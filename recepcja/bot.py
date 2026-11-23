"""MXT Recepcja AI – asystentka „Ola” (Pipecat 1.16).

Telefon (Twilio) → Deepgram Nova-3 (mowa → tekst, polski) → Claude (odpowiedź i narzędzia) → Cartesia lub ElevenLabs (tekst → mowa).
Claude przez narzędzia sprawdza terminy, rezerwuje wizyty, zapisuje zgłoszenia, przekazuje rozmowę pracownikowi i kończy rozmowę.
Po rozmowie całe zdarzenie (transkrypcja, wynik, zgłoszenia) trafia do aplikacji MXT (Asystent telefoniczny).

Test na komputerze (plan, etap 1):  python bot.py   → otwórz http://localhost:7860/client i rozmawiaj w przeglądarce.
Produkcja (telefon):                uvicorn server:app --host 0.0.0.0 --port 8000   (server.py: /voice dla Twilio)
"""

import asyncio
import os
import uuid
from dataclasses import dataclass
from datetime import datetime, timezone

from dotenv import load_dotenv
from loguru import logger

load_dotenv(override=False)

from pipecat.audio.vad.silero import SileroVADAnalyzer  # noqa: E402
from pipecat.frames.frames import EndWorkerFrame, FunctionCallResultProperties, TTSSpeakFrame  # noqa: E402
from pipecat.observers.user_bot_latency_observer import UserBotLatencyObserver  # noqa: E402
from pipecat.pipeline.pipeline import Pipeline  # noqa: E402
from pipecat.pipeline.worker import PipelineParams, PipelineWorker  # noqa: E402
from pipecat.processors.aggregators.llm_context import LLMContext  # noqa: E402
from pipecat.processors.aggregators.llm_response_universal import (  # noqa: E402
    AssistantTurnStoppedMessage, LLMContextAggregatorPair, LLMUserAggregatorParams, UserTurnStoppedMessage)
from pipecat.runner.types import RunnerArguments  # noqa: E402
from pipecat.services.anthropic.llm import AnthropicLLMService  # noqa: E402
from pipecat.services.cartesia.tts import CartesiaTTSService  # noqa: E402
from pipecat.services.deepgram.stt import DeepgramSTTService  # noqa: E402
from pipecat.services.elevenlabs.tts import ElevenLabsTTSService  # noqa: E402
from pipecat.services.llm_service import FunctionCallParams  # noqa: E402
from pipecat.transcriptions.language import Language  # noqa: E402
from pipecat.transports.base_transport import BaseTransport, TransportParams  # noqa: E402
from pipecat.workers.runner import WorkerRunner  # noqa: E402

import config  # noqa: E402
import kalendarz  # noqa: E402
import mxt  # noqa: E402
import narzedzia  # noqa: E402
import prompt  # noqa: E402
import telefon  # noqa: E402
from baza import Baza  # noqa: E402

LACZE = "Łączę z pracownikiem, proszę chwilę poczekać."
KONIEC_CZASU = "Przepraszam, muszę już zakończyć rozmowę. Pracownik oddzwoni, jeśli sprawa jest niezałatwiona. Do widzenia."


@dataclass
class Zasoby:
    """Wspólne dla wszystkich rozmów: baza, kalendarz, klient aplikacji MXT."""
    baza: Baza
    kalendarz: object
    mxt: mxt.KlientMXT

    @classmethod
    def utworz(cls) -> "Zasoby":
        b = Baza(config.BAZA)
        return cls(baza=b, kalendarz=kalendarz.utworz_kalendarz(b), mxt=mxt.KlientMXT(b))


# ---------- usługi AI ----------
def uslugi_ai(r: narzedzia.Rozmowa):
    stt = DeepgramSTTService(api_key=os.getenv("DEEPGRAM_API_KEY", ""), settings=DeepgramSTTService.Settings(
        model="nova-3", language=Language.PL, punctuate=True,
        **({"keyterm": config.SLOWA_KLUCZOWE} if os.getenv("DEEPGRAM_SLOWA_KLUCZOWE", "1") != "0" else {})))
    llm = AnthropicLLMService(api_key=os.getenv("ANTHROPIC_API_KEY", ""), settings=AnthropicLLMService.Settings(
        model=config.MODEL_LLM, system_instruction=prompt.instrukcje(datetime.now(timezone.utc), r.telefon),
        max_tokens=1024, enable_prompt_caching=True))
    if config.TTS == "elevenlabs":
        tts = ElevenLabsTTSService(api_key=os.getenv("ELEVENLABS_API_KEY", ""), settings=ElevenLabsTTSService.Settings(
            voice=config.ELEVENLABS_VOICE_ID, model="eleven_flash_v2_5", language=Language.PL))
    else:
        tts = CartesiaTTSService(api_key=os.getenv("CARTESIA_API_KEY", ""), settings=CartesiaTTSService.Settings(
            voice=config.CARTESIA_VOICE_ID, language=Language.PL))
    return stt, llm, tts


def podlacz_narzedzia(llm, r: narzedzia.Rozmowa, u: narzedzia.Uslugi) -> None:
    """Rejestruje narzędzia w Claude. Logika jest w narzedzia.py; tu tylko działania na rozmowie (mowa, przekazanie, koniec)."""

    async def obsluz(params: FunctionCallParams):
        nazwa = params.function_name
        try:
            wynik = await narzedzia.NARZEDZIA[nazwa](r, u, dict(params.arguments or {}))
        except Exception as e:  # noqa: BLE001 – błąd narzędzia nie może przerwać rozmowy
            logger.exception(f"Narzędzie {nazwa}: {e}")
            wynik = {"blad": "Chwilowy problem z systemem. Przeproś klienta i zaproponuj, że pracownik oddzwoni."}
        logger.info(f"{r.call_sid} · {nazwa} → {wynik}")
        if nazwa == "przekaz_do_konsultanta" and wynik.get("status") == "laczenie":
            await params.result_callback(wynik, properties=FunctionCallResultProperties(run_llm=False))
            await params.llm.push_frame(TTSSpeakFrame(LACZE))
            asyncio.create_task(_przekaz_po(r, sekund=len(LACZE) / 14 + 1.0))
        elif nazwa == "zakoncz_rozmowe":
            # Pożegnanie (tekst modelu przed wywołaniem) jest już w kolejce – EndWorkerFrame czeka, aż wybrzmi.
            await params.result_callback(wynik, properties=FunctionCallResultProperties(run_llm=False))
            await params.llm.push_frame(EndWorkerFrame(reason="pożegnanie"))
        else:
            await params.result_callback(wynik)

    for nazwa in narzedzia.NARZEDZIA:
        llm.register_function(nazwa, obsluz)


async def _przekaz_po(r: narzedzia.Rozmowa, sekund: float) -> None:
    await asyncio.sleep(sekund)   # najpierw wybrzmiewa „Łączę z pracownikiem”
    if not await telefon.przekaz(r.call_sid):
        r.przekazana = False      # nieudane – rozmowa zostaje u asystentki (zakończy ją klient albo bezpiecznik czasu)


# ---------- jedna rozmowa ----------
async def run_bot(transport: BaseTransport, r: narzedzia.Rozmowa, zasoby: Zasoby, handle_sigint: bool = False) -> dict:
    stt, llm, tts = uslugi_ai(r)
    u = narzedzia.Uslugi(kalendarz=zasoby.kalendarz, sms=telefon.sms if r.telefonia else None)
    podlacz_narzedzia(llm, r, u)

    # Anthropic wymaga, by rozmowa zaczynała się od użytkownika: znacznik odebrania, potem stałe powitanie (ujawnienie AI).
    context = LLMContext(messages=[{"role": "user", "content": "[Połączenie odebrane – klient czeka na powitanie.]"}], tools=narzedzia.schematy())
    user_agg, assistant_agg = LLMContextAggregatorPair(context, user_params=LLMUserAggregatorParams(vad_analyzer=SileroVADAnalyzer()))

    pipeline = Pipeline([transport.input(), stt, user_agg, llm, tts, transport.output(), assistant_agg])
    opoznienia = UserBotLatencyObserver()
    worker = PipelineWorker(pipeline, observers=[opoznienia], params=PipelineParams(
        enable_metrics=True, enable_usage_metrics=True, audio_in_sample_rate=8000, audio_out_sample_rate=8000))
    runner = WorkerRunner(handle_sigint=handle_sigint)
    await runner.add_workers(worker)

    @opoznienia.event_handler("on_latency_measured")
    async def _opoznienie(observer, sekundy: float):
        r.opoznienia_ms.append(round(sekundy * 1000))

    @user_agg.event_handler("on_user_turn_stopped")
    async def _klient(aggregator, strategy, message: UserTurnStoppedMessage):
        r.dodaj("klient", message.content)

    @assistant_agg.event_handler("on_assistant_turn_stopped")
    async def _asystentka(aggregator, message: AssistantTurnStoppedMessage):
        r.dodaj("asystent", message.content)

    @transport.event_handler("on_client_connected")
    async def _polaczono(transport, client):
        if config.NAGRYWANIE and r.telefonia:
            await telefon.nagrywaj(r.call_sid)
        witaj = TTSSpeakFrame(prompt.powitanie())
        witaj.interruptible = False   # ujawnienie AI zawsze wybrzmiewa w całości
        await worker.queue_frames([witaj])

    @transport.event_handler("on_client_disconnected")
    async def _rozlaczono(transport, client):
        await runner.cancel()

    async def bezpiecznik():
        await asyncio.sleep(config.MAX_CZAS_ROZMOWY_MIN * 60)
        logger.warning(f"{r.call_sid}: limit czasu rozmowy")
        await worker.queue_frames([TTSSpeakFrame(KONIEC_CZASU), EndWorkerFrame(reason="limit czasu")])

    limit = asyncio.create_task(bezpiecznik())
    try:
        await runner.run()
    finally:
        limit.cancel()
        r.zakonczona = datetime.now(timezone.utc)
        if r.telefonia and not r.przekazana:
            await asyncio.sleep(0.5)
            await telefon.rozlacz(r.call_sid)
    return await zakoncz(r, zasoby)


async def zakoncz(r: narzedzia.Rozmowa, zasoby: Zasoby) -> dict:
    """Podsumowanie i wysyłka do aplikacji MXT (z kolejką ponowień)."""
    z = mxt.zdarzenie(r, await mxt.podsumowanie_ai(r) or mxt.podsumowanie_z_danych(r))
    await zasoby.mxt.wyslij(z)
    await zasoby.mxt.ponow_zalegle()
    logger.info(f"{r.call_sid}: {z['wynik']}, zgłoszenia: {len(z['zgloszenia'])}")
    return z


# ---------- uruchamianie przez runner Pipecat: test w przeglądarce (domyślnie) albo -t twilio -x <adres> ----------
_zasoby: Zasoby | None = None


async def bot(runner_args: RunnerArguments):
    global _zasoby
    from pipecat.runner.utils import create_transport
    from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams
    _zasoby = _zasoby or Zasoby.utworz()
    transport = await create_transport(runner_args, {
        "webrtc": lambda: TransportParams(audio_in_enabled=True, audio_out_enabled=True),
        "twilio": lambda: FastAPIWebsocketParams(audio_in_enabled=True, audio_out_enabled=True),
    })
    call = getattr(runner_args, "call_data", None)
    if call:   # telefon przez runner (testy z ngrok); produkcja: server.py
        r = narzedzia.Rozmowa(call_sid=call.call_id, telefon=call.from_number or (call.body or {}).get("from", ""), telefonia=True)
    else:      # rozmowa w przeglądarce: testowa, bez przekazania i rozłączania
        r = narzedzia.Rozmowa(call_sid=f"WEB-{uuid.uuid4().hex[:12]}", telefon=os.getenv("TEST_TELEFON", ""), test=True, telefonia=False)
    await run_bot(transport, r, _zasoby, handle_sigint=runner_args.handle_sigint)


if __name__ == "__main__":
    from pipecat.runner.run import main
    main()
