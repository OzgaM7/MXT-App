"""Twilio: walidacja żądań, odpowiedź TwiML, przekazanie do pracownika, rozłączenie, nagrywanie, SMS."""

import asyncio
import hashlib
import hmac
import os

from loguru import logger
from twilio.request_validator import RequestValidator
from twilio.twiml.voice_response import Connect, Dial, Say, VoiceResponse

import config


def _konto() -> tuple[str, str]:
    return os.getenv("TWILIO_ACCOUNT_SID", ""), os.getenv("TWILIO_AUTH_TOKEN", "")


def klient():
    from twilio.rest import Client
    sid, token = _konto()
    return Client(sid, token) if sid and token else None


def podpis_poprawny(url: str, parametry: dict, podpis: str) -> bool:
    """Nagłówek X-Twilio-Signature – żądanie naprawdę przyszło z Twilio (plan: walidacja podpisu włączona)."""
    _, token = _konto()
    return bool(token and podpis) and RequestValidator(token).validate(url, parametry, podpis)


def token_strumienia(call_sid: str) -> str:
    """Znacznik w TwiML: strumień audio przyjmujemy tylko dla rozmów, które zaczęły się od naszego /voice."""
    klucz = (os.getenv("WS_SECRET") or _konto()[1] or "brak").encode()
    return hmac.new(klucz, call_sid.encode(), hashlib.sha256).hexdigest()[:32]


def twiml_strumien(ws_url: str, call_sid: str, od: str) -> str:
    r, c = VoiceResponse(), Connect()
    s = c.stream(url=ws_url)
    s.parameter(name="from", value=od)
    s.parameter(name="token", value=token_strumienia(call_sid))
    r.append(c)
    return str(r)


def twiml_awaria() -> str:
    """Gdy bot nie działa: przekierowanie na numer pracownika albo prośba o ponowny telefon."""
    r = VoiceResponse()
    if config.TRANSFER_NUMBER:
        r.say("Łączę z pracownikiem.", language="pl-PL")
        r.dial(config.TRANSFER_NUMBER)
    else:
        r.say("Przepraszamy, linia jest chwilowo niedostępna. Prosimy zadzwonić później.", language="pl-PL")
    return str(r)


async def przekaz(call_sid: str) -> bool:
    """Przełącza trwające połączenie na numer pracownika (strumień do bota się kończy)."""
    c = klient()
    if not c or not config.TRANSFER_NUMBER:
        return False
    r = VoiceResponse()
    d = Dial(timeout=25, caller_id=config.TWILIO_NUMER or None)
    d.number(config.TRANSFER_NUMBER)
    r.append(d)
    r.append(Say("Pracownik nie odbiera. Oddzwonimy najszybciej, jak to możliwe. Do widzenia.", language="pl-PL"))
    try:
        await asyncio.to_thread(lambda: c.calls(call_sid).update(twiml=str(r)))
        return True
    except Exception as e:  # noqa: BLE001 – błąd Twilio nie może przerwać zamykania rozmowy
        logger.error(f"Przekazanie {call_sid} nieudane: {e}")
        return False


async def rozlacz(call_sid: str) -> None:
    c = klient()
    if not c:
        return
    try:
        await asyncio.to_thread(lambda: c.calls(call_sid).update(status="completed"))
    except Exception as e:  # noqa: BLE001 – rozmowa mogła być już zakończona przez klienta
        logger.debug(f"Rozłączenie {call_sid}: {e}")


async def nagrywaj(call_sid: str) -> None:
    c = klient()
    if not c:
        return
    try:
        await asyncio.to_thread(lambda: c.calls(call_sid).recordings.create())
    except Exception as e:  # noqa: BLE001
        logger.error(f"Nagrywanie {call_sid} nieudane: {e}")


async def sms(do: str, tresc: str) -> bool:
    c = klient()
    if not c or not config.TWILIO_NUMER or not do:
        return False
    try:
        await asyncio.to_thread(lambda: c.messages.create(to=do, from_=config.TWILIO_NUMER, body=tresc[:600]))
        return True
    except Exception as e:  # noqa: BLE001
        logger.error(f"SMS do {do} nieudany: {e}")
        return False
