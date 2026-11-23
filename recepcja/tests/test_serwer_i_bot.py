import asyncio
import json
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient
from starlette.websockets import WebSocketDisconnect
from twilio.request_validator import RequestValidator

import bot
import config
import narzedzia as N
import server
import telefon
from pipecat.frames.frames import EndWorkerFrame, TTSSpeakFrame


@pytest.fixture
def klient():
    with TestClient(server.app) as c:
        yield c


# ---------- serwer Twilio ----------
def test_health(klient):
    assert klient.get("/health").json() == {"ok": True}


def test_voice_bez_podpisu(klient):
    assert klient.post("/voice", data={"CallSid": "CA1", "From": "+48600100200"}).status_code == 403


def test_voice_z_podpisem(klient):
    form = {"CallSid": "CA123", "From": "+48600100200", "To": "+48686000000"}
    url = "https://testserver/voice"
    sig = RequestValidator("test-token").compute_signature(url, form)
    r = klient.post("/voice", data=form, headers={"X-Twilio-Signature": sig, "X-Forwarded-Proto": "https"})
    assert r.status_code == 200 and r.headers["content-type"].startswith("application/xml")
    assert '<Stream url="wss://testserver/ws">' in r.text and '<Parameter name="from" value="+48600100200" />' in r.text
    assert f'<Parameter name="token" value="{telefon.token_strumienia("CA123")}" />' in r.text
    form["From"] = "+48999999999"   # zmienione parametry – podpis nie pasuje
    assert klient.post("/voice", data=form, headers={"X-Twilio-Signature": sig, "X-Forwarded-Proto": "https"}).status_code == 403


def test_awaria_bez_numeru_pracownika(klient):
    form = {"CallSid": "CA9"}
    sig = RequestValidator("test-token").compute_signature("https://testserver/awaria", form)
    r = klient.post("/awaria", data=form, headers={"X-Twilio-Signature": sig, "X-Forwarded-Proto": "https"})
    assert r.status_code == 200 and "linia jest chwilowo niedostępna" in r.text


def test_strumien_bez_znacznika_odrzucony(klient):
    with klient.websocket_connect("/ws") as ws:
        ws.send_text(json.dumps({"event": "connected", "protocol": "Call", "version": "1.0.0"}))
        ws.send_text(json.dumps({"event": "start", "start": {"streamSid": "MZ1", "callSid": "CA1", "customParameters": {"token": "zly", "from": "+48600"}}}))
        with pytest.raises(WebSocketDisconnect) as e:
            ws.receive_text()
    assert e.value.code == 1008


def test_twiml_awaria_z_przekazaniem(monkeypatch):
    monkeypatch.setattr(config, "TRANSFER_NUMBER", "+48600999888")
    assert "<Dial>+48600999888</Dial>" in telefon.twiml_awaria()


# ---------- pipeline: usługi i narzędzia ----------
def test_uslugi_ai_skladaja_sie_bez_sieci(monkeypatch):
    for k in ("DEEPGRAM_API_KEY", "ANTHROPIC_API_KEY", "CARTESIA_API_KEY"):
        monkeypatch.setenv(k, "klucz-testowy")
    stt, llm, tts = bot.uslugi_ai(N.Rozmowa(call_sid="CA1", telefon="+48600100200"))
    assert type(stt).__name__ == "DeepgramSTTService" and type(llm).__name__ == "AnthropicLLMService" and type(tts).__name__ == "CartesiaTTSService"


class FalszyweLLM:
    def __init__(self):
        self.funkcje, self.ramki = {}, []

    def register_function(self, nazwa, f):
        self.funkcje[nazwa] = f

    async def push_frame(self, ramka, kierunek=None):
        self.ramki.append(ramka)


def wywolaj(llm, nazwa, argumenty):
    wyniki = []

    async def cb(wynik, properties=None):
        wyniki.append((wynik, properties))
    asyncio.run(llm.funkcje[nazwa](SimpleNamespace(function_name=nazwa, arguments=argumenty, result_callback=cb, llm=llm)))
    return wyniki[0]


def test_narzedzia_w_pipecat(monkeypatch):
    llm, r = FalszyweLLM(), N.Rozmowa(call_sid="CA1", telefon="+48600100200")

    class Kal:
        async def zajete(self, *a):
            raise RuntimeError("kalendarz nie działa")
    bot.podlacz_narzedzia(llm, r, N.Uslugi(kalendarz=Kal()))
    assert set(llm.funkcje) == set(N.NARZEDZIA)
    wynik, prop = wywolaj(llm, "sprawdz_wolne_terminy", {"dzial": "podzielniki"})
    assert "Chwilowy problem" in wynik["blad"] and prop is None          # błąd narzędzia nie przerywa rozmowy
    wynik, prop = wywolaj(llm, "zakoncz_rozmowe", {})
    assert r.zakonczenie and prop.run_llm is False and isinstance(llm.ramki[-1], EndWorkerFrame)


def test_przekazanie_w_pipecat(monkeypatch):
    monkeypatch.setattr(config, "TRANSFER_NUMBER", "+48600999888")
    monkeypatch.setattr(N.kalendarz, "w_godzinach_pracy", lambda t: True)
    zadania = []
    monkeypatch.setattr(bot.asyncio, "create_task", lambda c: zadania.append(c) or c.close())
    llm, r = FalszyweLLM(), N.Rozmowa(call_sid="CA1")
    bot.podlacz_narzedzia(llm, r, N.Uslugi(kalendarz=None))
    wynik, prop = wywolaj(llm, "przekaz_do_konsultanta", {"powod": "reklamacja"})
    assert wynik["status"] == "laczenie" and prop.run_llm is False and r.przekazana
    assert isinstance(llm.ramki[-1], TTSSpeakFrame) and llm.ramki[-1].text == bot.LACZE and len(zadania) == 1
