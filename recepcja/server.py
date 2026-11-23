"""Serwer produkcyjny asystentki dla Twilio:  uvicorn server:app --host 0.0.0.0 --port 8000

POST /voice   – webhook numeru w Twilio (A call comes in). Podpis Twilio sprawdzany; odpowiedź: TwiML ze strumieniem audio.
WS   /ws      – strumień audio rozmowy (Twilio Media Streams) → rozmowa z asystentką (bot.run_bot).
POST /awaria  – zapasowy URL w Twilio (Primary handler fails): łączy z pracownikiem albo prosi o ponowny telefon.
GET  /health  – sprawdzenie, czy serwer działa.
"""

import os
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import PlainTextResponse, Response
from loguru import logger
from pipecat.runner.utils import parse_telephony_websocket
from pipecat.serializers.twilio import TwilioFrameSerializer
from pipecat.transports.websocket.fastapi import FastAPIWebsocketParams, FastAPIWebsocketTransport

import bot
import narzedzia
import telefon

WALIDACJA = os.getenv("TWILIO_WALIDACJA", "1") != "0"     # 0 tylko do testów lokalnych bez Twilio
PUBLIC_URL = os.getenv("PUBLIC_URL", "").rstrip("/")       # adres serwera widziany przez Twilio, np. https://recepcja.mxt.pl


@asynccontextmanager
async def lifespan(app: FastAPI):
    app.state.zasoby = bot.Zasoby.utworz()
    wyslane = await app.state.zasoby.mxt.ponow_zalegle()
    if wyslane:
        logger.info(f"Wysłano zaległe rozmowy do aplikacji MXT: {wyslane}")
    yield


app = FastAPI(title="MXT Recepcja AI", lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)


def _adres(request: Request, sciezka: str) -> str:
    if PUBLIC_URL:
        return PUBLIC_URL + sciezka
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    return f"{proto}://{request.headers.get('host', request.url.netloc)}{sciezka}"


async def _z_twilio(request: Request) -> dict | None:
    """Parametry żądania z Twilio albo None, gdy podpis się nie zgadza."""
    form = {k: str(v) for k, v in (await request.form()).items()}
    url = _adres(request, request.url.path) + (f"?{request.url.query}" if request.url.query else "")
    if WALIDACJA and not telefon.podpis_poprawny(url, form, request.headers.get("X-Twilio-Signature", "")):
        logger.warning(f"Odrzucone żądanie {request.url.path}: nieprawidłowy podpis Twilio")
        return None
    return form


@app.get("/health")
async def health():
    return {"ok": True}


@app.post("/voice")
async def voice(request: Request):
    form = await _z_twilio(request)
    if form is None:
        return PlainTextResponse("Nieprawidłowy podpis", status_code=403)
    ws = _adres(request, "/ws").replace("https://", "wss://", 1).replace("http://", "ws://", 1)
    logger.info(f"Połączenie {form.get('CallSid')} od {form.get('From')}")
    return Response(telefon.twiml_strumien(ws, form.get("CallSid", ""), form.get("From", "")), media_type="application/xml")


@app.post("/awaria")
async def awaria(request: Request):
    if await _z_twilio(request) is None:
        return PlainTextResponse("Nieprawidłowy podpis", status_code=403)
    return Response(telefon.twiml_awaria(), media_type="application/xml")


@app.websocket("/ws")
async def strumien(websocket: WebSocket):
    await websocket.accept()
    rodzaj, call = await parse_telephony_websocket(websocket)
    body = call.body or {}
    if rodzaj != "twilio" or not call.call_id or (WALIDACJA and body.get("token") != telefon.token_strumienia(call.call_id)):
        logger.warning(f"Odrzucony strumień ({rodzaj}, {call.call_id}): brak znacznika z /voice")
        await websocket.close(code=1008)
        return
    # Rozłączenie robi bot (telefon.rozlacz) – automatyczne rozłączanie serializera przerwałoby przekazanie do pracownika.
    serializer = TwilioFrameSerializer(stream_sid=call.stream_id, call_sid=call.call_id,
                                       params=TwilioFrameSerializer.InputParams(auto_hang_up=False))
    transport = FastAPIWebsocketTransport(websocket=websocket, params=FastAPIWebsocketParams(
        audio_in_enabled=True, audio_out_enabled=True, add_wav_header=False, serializer=serializer))
    r = narzedzia.Rozmowa(call_sid=call.call_id, telefon=body.get("from") or call.from_number or "",
                          test=os.getenv("ROZMOWY_TESTOWE") == "1", telefonia=True)
    await bot.run_bot(transport, r, app.state.zasoby)
