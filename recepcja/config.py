"""Konfiguracja asystentki „Ola” (MXT Recepcja AI).

Tu zmienia się działy, godziny pracy, długości wizyt i listy pytań – bez programowania.
Klucze i adresy usług są w pliku .env (wzór: .env.example).
"""

import os
from dataclasses import dataclass, field

from dotenv import load_dotenv

load_dotenv(override=False)


def _env(name: str, default: str = "") -> str:
    return os.getenv(name, default).strip()


def _flag(name: str, default: bool = False) -> bool:
    v = _env(name)
    return default if v == "" else v.lower() in ("1", "true", "tak", "yes")


# ---------- firma ----------
FIRMA = "MXT"
ASYSTENTKA = "Ola"
STREFA_CZASOWA = "Europe/Warsaw"

# Godziny pracy biura: przekazanie rozmowy do pracownika i terminy wizyt tylko w tych godzinach.
# Klucz: dzień tygodnia (0 = poniedziałek). Brak dnia = nieczynne.
GODZINY_PRACY: dict[int, tuple[str, str]] = {0: ("08:00", "16:00"), 1: ("08:00", "16:00"), 2: ("08:00", "16:00"),
                                             3: ("08:00", "16:00"), 4: ("08:00", "16:00")}
WYPRZEDZENIE_MIN_GODZ = 2       # najwcześniejszy termin: teraz + 2 godziny
HORYZONT_DNI = 14               # terminy najwyżej 14 dni naprzód
LICZBA_PROPOZYCJI = 3           # asystentka proponuje 2–3 terminy
MAX_CZAS_ROZMOWY_MIN = 15       # bezpiecznik: dłuższa rozmowa jest grzecznie kończona


@dataclass
class Dzial:
    klucz: str                      # identyfikator (taki sam jak w aplikacji MXT)
    nazwa: str
    aktywny: bool
    opis: str                       # co asystentka robi w tym dziale (do promptu)
    pytania: list[str]              # dane, o które pyta
    wizyta_min: int | None = None   # długość wizyty / rozmowy w kalendarzu (None = bez rezerwacji)
    adres_wymagany: bool = False
    rodzaj_rezerwacji: str = "wizyta_serwisowa"  # rodzaj zgłoszenia w aplikacji MXT
    zasady: list[str] = field(default_factory=list)


DZIALY: dict[str, Dzial] = {
    "podzielniki": Dzial(
        klucz="podzielniki", nazwa="Podzielniki ciepła i montaże", aktywny=True, wizyta_min=60, adres_wymagany=True,
        opis="umawia wizytę serwisową (60 minut) pod wskazanym adresem: awaria lub wymiana podzielnika, ciepłomierza, wodomierza, problem z odczytem",
        pytania=["imię i nazwisko", "adres (ulica, numer budynku, numer lokalu, miejscowość)", "na czym polega problem",
                 "czy to awaria wymagająca pilnej wizyty", "numer telefonu do kontaktu"]),
    "ubezpieczenia": Dzial(
        klucz="ubezpieczenia", nazwa="MXT Agencja Ubezpieczeniowa", aktywny=True, wizyta_min=30, rodzaj_rezerwacji="rozmowa_agent",
        opis="umawia rozmowę z agentem ubezpieczeniowym (30 minut)",
        pytania=["imię i nazwisko", "jakiego ubezpieczenia dotyczy sprawa (np. OC/AC, mieszkanie, firma)", "numer telefonu do kontaktu"],
        zasady=["Nie podawaj składek ani cen i nie doradzaj w wyborze ubezpieczenia – tylko umawiasz rozmowę z agentem."]),
    "czesci": Dzial(
        klucz="czesci", nazwa="Części samochodowe i ciężarowe", aktywny=True,
        opis="zbiera zapytanie o część do oddzwonienia przez sprzedawcę",
        pytania=["imię i nazwisko", "marka i model pojazdu", "numer VIN, jeśli klient ma go pod ręką", "jakiej części szuka", "numer telefonu do kontaktu"],
        zasady=["Nie podawaj cen ani dostępności części – sprzedawca oddzwoni."]),
}


def aktywne_dzialy() -> list[Dzial]:
    return [d for d in DZIALY.values() if d.aktywny]


# ---------- usługi ----------
MODEL_LLM = _env("ANTHROPIC_MODEL", "claude-haiku-5-5")   # plan: Haiku 5.5, opcja: claude-sonnet-5-5
TTS = _env("TTS", "cartesia").lower()                      # cartesia | elevenlabs
CARTESIA_VOICE_ID = _env("CARTESIA_VOICE_ID")
ELEVENLABS_VOICE_ID = _env("ELEVENLABS_VOICE_ID")
# Słowa, które Deepgram ma rozpoznawać lepiej (nazwy firmy i branży).
SLOWA_KLUCZOWE = ["MXT", "Ola", "podzielnik", "podzielniki", "ciepłomierz", "wodomierz", "odczyt", "VIN", "OC", "AC", "Express Parts"]

# ---------- telefonia i integracje ----------
TRANSFER_NUMBER = _env("TRANSFER_NUMBER")           # numer pracownika do przekazania rozmowy (E.164, np. +48600100200)
NAGRYWANIE = _flag("NAGRYWANIE")                     # nagrywanie rozmów (asystentka mówi o nim w powitaniu)
SMS_WLACZONE = _flag("SMS_WLACZONE")                 # SMS z potwierdzeniem terminu
TWILIO_NUMER = _env("TWILIO_NUMER")                  # numer nadawcy SMS (numer firmy w Twilio)
KALENDARZ = _env("KALENDARZ", "lokalny").lower()     # lokalny | google
BAZA = _env("BAZA_SQLITE", os.path.join(os.path.dirname(os.path.abspath(__file__)), "recepcja.db"))
MXT_APP_WEBHOOK_URL = _env("MXT_APP_WEBHOOK_URL")    # z aplikacji MXT: Asystent telefoniczny → Integracja z botem
MXT_APP_WEBHOOK_TOKEN = _env("MXT_APP_WEBHOOK_TOKEN")
PODSUMOWANIE_AI = _flag("PODSUMOWANIE_AI", True)     # jednozdaniowe podsumowanie rozmowy (Claude), inaczej z danych rozmowy
