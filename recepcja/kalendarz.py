"""Wolne terminy i rezerwacje.

Zabezpieczenia z planu: tylko godziny pracy, co najmniej 2 godziny wyprzedzenia, najwyżej 14 dni naprzód,
bez świąt; każdy dział ma osobny kalendarz (wizyta serwisowa nie blokuje rozmowy z agentem ubezpieczeń).
Kalendarz: lokalny (SQLite, domyślnie) albo Google Calendar (KALENDARZ=google, konto serwisowe).
"""

import asyncio
import os
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

import config

TZ = ZoneInfo(config.STREFA_CZASOWA)
KROK_MIN = 30  # terminy zaczynają się o pełnej godzinie i o wpół do


class TerminZajety(Exception):
    """Termin zajęto w międzyczasie (np. inna rozmowa)."""


# ---------- dni wolne w Polsce ----------
def _wielkanoc(rok: int) -> date:
    a, b, c = rok % 19, rok // 100, rok % 100
    d, e = b // 4, b % 4
    f = (b + 8) // 25
    g = (b - f + 1) // 3
    h = (19 * a + b - d - g + 15) % 30
    i, k = c // 4, c % 4
    l = (32 + 2 * e + 2 * i - h - k) % 7
    m = (a + 11 * h + 22 * l) // 451
    mies = (h + l - 7 * m + 114) // 31
    dzien = (h + l - 7 * m + 114) % 31 + 1
    return date(rok, mies, dzien)


def swieta(rok: int) -> set[date]:
    stale = {(1, 1), (1, 6), (5, 1), (5, 3), (8, 15), (11, 1), (11, 11), (12, 25), (12, 26)}
    if rok >= 2025:
        stale.add((12, 24))  # Wigilia – dzień wolny od 2025 r.
    w = _wielkanoc(rok)
    return {date(rok, m, d) for m, d in stale} | {w, w + timedelta(days=1), w + timedelta(days=49), w + timedelta(days=60)}


def dzien_roboczy(d: date) -> bool:
    return d.weekday() in config.GODZINY_PRACY and d not in swieta(d.year)


def godziny(d: date) -> tuple[datetime, datetime] | None:
    if not dzien_roboczy(d):
        return None
    od, do = config.GODZINY_PRACY[d.weekday()]
    return (datetime.combine(d, time.fromisoformat(od), TZ), datetime.combine(d, time.fromisoformat(do), TZ))


def w_godzinach_pracy(chwila: datetime) -> bool:
    g = godziny(chwila.astimezone(TZ).date())
    return bool(g) and g[0] <= chwila < g[1]


# ---------- propozycje terminów ----------
def wolne_terminy(dlugosc_min: int, teraz: datetime, zajete: list[tuple[datetime, datetime]], preferencja: str = "",
                  od_dnia: date | None = None, ile: int | None = None) -> list[datetime]:
    """Propozycje terminów: pierwszy wolny, potem kolejne w innych dniach (żeby klient miał wybór)."""
    ile = ile or config.LICZBA_PROPOZYCJI
    teraz = teraz.astimezone(TZ)
    najwczesniej = teraz + timedelta(hours=config.WYPRZEDZENIE_MIN_GODZ)
    ostatni_dzien = teraz.date() + timedelta(days=config.HORYZONT_DNI)
    dlugosc = timedelta(minutes=dlugosc_min)
    dzien = max(teraz.date(), od_dnia) if od_dnia else teraz.date()
    wolne: list[datetime] = []
    while dzien <= ostatni_dzien:
        g = godziny(dzien)
        if g:
            start = g[0]
            while start + dlugosc <= g[1]:
                koniec = start + dlugosc
                pasuje = (preferencja != "rano" or start.hour < 12) and (preferencja != "popoludnie" or start.hour >= 12)
                if start >= najwczesniej and pasuje and not any(s < koniec and start < k for s, k in zajete):
                    wolne.append(start)
                start += timedelta(minutes=KROK_MIN)
        dzien += timedelta(days=1)
    wybor: list[datetime] = []
    for t in wolne:  # różne dni
        if len(wybor) < ile and all(t.date() != w.date() for w in wybor):
            wybor.append(t)
    for t in wolne:  # dopełnienie, jeśli dni jest za mało
        if len(wybor) < ile and t not in wybor and all(abs(t - w) >= timedelta(hours=2) for w in wybor):
            wybor.append(t)
    return sorted(wybor)


DNI = ["poniedziałek", "wtorek", "środa", "czwartek", "piątek", "sobota", "niedziela"]
MIESIACE = ["stycznia", "lutego", "marca", "kwietnia", "maja", "czerwca", "lipca", "sierpnia", "września", "października", "listopada", "grudnia"]


def opis_terminu(t: datetime) -> str:
    """Termin do przeczytania na głos, np. „wtorek, 25 listopada, godzina 9:00”."""
    t = t.astimezone(TZ)
    return f"{DNI[t.weekday()]}, {t.day} {MIESIACE[t.month - 1]}, godzina {t.hour}:{t.minute:02d}"


# ---------- kalendarze ----------
class KalendarzLokalny:
    """Rezerwacje w bazie SQLite bota – start bez żadnej infrastruktury."""

    def __init__(self, baza):
        self.baza = baza

    async def zajete(self, dzial: str, od: datetime, do: datetime):
        return await self.baza.zajete(dzial, od, do)

    async def rezerwuj(self, dzial: str, start: datetime, koniec: datetime, call_sid: str, opis: str, dane: dict) -> str:
        nr = await self.baza.rezerwuj(dzial, start, koniec, call_sid, opis, dane)
        if nr is None:
            raise TerminZajety()
        return f"lokalny-{nr}"


class KalendarzGoogle:
    """Google Calendar przez konto serwisowe (plan, etap 3).

    .env: GOOGLE_SERVICE_ACCOUNT_FILE (plik JSON klucza), GOOGLE_KALENDARZ_ID (domyślny kalendarz)
    oraz opcjonalnie GOOGLE_KALENDARZ_<DZIAL> (np. GOOGLE_KALENDARZ_PODZIELNIKI) – osobny kalendarz działu.
    Kalendarz trzeba udostępnić adresowi e-mail konta serwisowego z prawem wprowadzania zmian.
    """

    def __init__(self, plik_klucza: str | None = None):
        from google.oauth2 import service_account
        from googleapiclient.discovery import build
        plik = plik_klucza or os.environ["GOOGLE_SERVICE_ACCOUNT_FILE"]
        cred = service_account.Credentials.from_service_account_file(plik, scopes=["https://www.googleapis.com/auth/calendar"])
        self.api = build("calendar", "v3", credentials=cred, cache_discovery=False)

    @staticmethod
    def kalendarz_dzialu(dzial: str) -> str:
        return os.getenv(f"GOOGLE_KALENDARZ_{dzial.upper()}") or os.environ["GOOGLE_KALENDARZ_ID"]

    def _zajete(self, dzial, od, do):
        cid = self.kalendarz_dzialu(dzial)
        r = self.api.freebusy().query(body={"timeMin": od.isoformat(), "timeMax": do.isoformat(), "timeZone": config.STREFA_CZASOWA,
                                            "items": [{"id": cid}]}).execute()
        return [(datetime.fromisoformat(b["start"].replace("Z", "+00:00")), datetime.fromisoformat(b["end"].replace("Z", "+00:00")))
                for b in r["calendars"][cid].get("busy", [])]

    def _rezerwuj(self, dzial, start, koniec, call_sid, opis, dane):
        if self._zajete(dzial, start, koniec):
            raise TerminZajety()
        cid = self.kalendarz_dzialu(dzial)
        tytul = f"{dane.get('rodzaj_opis', 'Wizyta')}: {dane.get('imie_nazwisko', '')}".strip(": ")
        opis_pelny = "\n".join(filter(None, [opis, f"Telefon: {dane.get('telefon', '')}", f"Adres: {dane.get('adres_pelny', '')}" if dane.get("adres_pelny") else "",
                                             f"Rozmowa: {call_sid}", "Umówione przez asystentkę AI MXT."]))
        ev = self.api.events().insert(calendarId=cid, body={
            "summary": tytul, "description": opis_pelny, "location": dane.get("adres_pelny", ""),
            "start": {"dateTime": start.isoformat(), "timeZone": config.STREFA_CZASOWA},
            "end": {"dateTime": koniec.isoformat(), "timeZone": config.STREFA_CZASOWA}}).execute()
        return ev["id"]

    async def zajete(self, dzial, od, do):
        return await asyncio.to_thread(self._zajete, dzial, od, do)

    async def rezerwuj(self, dzial, start, koniec, call_sid, opis, dane) -> str:
        return await asyncio.to_thread(self._rezerwuj, dzial, start, koniec, call_sid, opis, dane)


def utworz_kalendarz(baza):
    return KalendarzGoogle() if config.KALENDARZ == "google" else KalendarzLokalny(baza)
