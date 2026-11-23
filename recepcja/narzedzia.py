"""Narzędzia asystentki (wywołuje je Claude) i stan rozmowy.

Logika jest tu, niezależnie od Pipecat, żeby dało się ją testować bez telefonu i kluczy API.
Zabezpieczenia z planu są w kodzie, nie tylko w instrukcjach dla modelu:
- terminy tylko w godzinach pracy, min. 2 h wyprzedzenia, horyzont 14 dni (kalendarz.wolne_terminy),
- rezerwacja tylko terminu z propozycji tej rozmowy, bez podwójnej rezerwacji, adres wymagany dla podzielników,
- przekazanie do pracownika tylko w godzinach pracy; poza nimi – propozycja oddzwonienia.
"""

import re
from dataclasses import dataclass, field
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from pipecat.adapters.llm.schemas.function_schema import FunctionSchema
from pipecat.adapters.llm.schemas.tools_schema import ToolsSchema

import config
import kalendarz

RODZAJE_ZGLOSZEN = ["zapytanie_czesci", "oddzwonienie", "inne"]


@dataclass
class Rozmowa:
    """Stan jednej rozmowy – z niego powstaje zdarzenie wysyłane do aplikacji MXT."""
    call_sid: str
    telefon: str = ""
    test: bool = False            # rozmowa testowa (np. w przeglądarce): w aplikacji MXT bez zleceń i statystyk
    telefonia: bool = True        # False w przeglądarce – nie ma czego przekazać ani rozłączyć
    rozpoczeta: datetime = field(default_factory=lambda: datetime.now(timezone.utc))
    zakonczona: datetime | None = None
    transkrypcja: list[dict] = field(default_factory=list)
    propozycje: dict[str, list[datetime]] = field(default_factory=dict)
    rezerwacje: list[dict] = field(default_factory=list)
    zgloszenia: list[dict] = field(default_factory=list)
    dzial: str = ""
    przekazana: bool = False
    powod_przekazania: str = ""
    zakonczenie: bool = False
    opoznienia_ms: list[int] = field(default_factory=list)

    def dodaj(self, rola: str, tekst: str) -> None:
        tekst = (tekst or "").strip()
        if tekst:
            self.transkrypcja.append({"rola": rola, "tekst": tekst[:4000], "czas": datetime.now(timezone.utc).isoformat()})

    @property
    def tury_klienta(self) -> int:
        return sum(1 for t in self.transkrypcja if t["rola"] == "klient")


@dataclass
class Uslugi:
    """Zależności narzędzi: kalendarz, zegar i opcjonalny SMS (podmieniane w testach)."""
    kalendarz: Any
    teraz: Callable[[], datetime] = lambda: datetime.now(timezone.utc)
    sms: Callable[[str, str], Awaitable[bool]] | None = None


# ---------- pomocnicze ----------
def telefon(v: str, domyslny: str = "") -> str:
    """Numer w formie +48600100200; 9 cyfr = numer polski. Pusty → numer dzwoniącego."""
    s = re.sub(r"[^\d+]", "", v or "")
    if not s:
        s = re.sub(r"[^\d+]", "", domyslny or "")
    if s.startswith("00"):
        s = "+" + s[2:]
    if re.fullmatch(r"\d{9}", s):
        s = "+48" + s
    return s if re.fullmatch(r"\+?\d{9,15}", s) else ""


def _dzial(klucz: str, rezerwacja: bool = False):
    d = config.DZIALY.get(klucz or "")
    if not d or not d.aktywny:
        return None, {"blad": f"Dział „{klucz}” nie jest obsługiwany. Dostępne: {', '.join(x.klucz for x in config.aktywne_dzialy())}."}
    if rezerwacja and not d.wizyta_min:
        return None, {"blad": f"W dziale {d.nazwa} nie rezerwuje się terminów – zapisz zgłoszenie (zapisz_zgloszenie)."}
    return d, None


def _czas(v: str) -> datetime | None:
    try:
        t = datetime.fromisoformat(str(v).replace("Z", "+00:00"))
        return t if t.tzinfo else t.replace(tzinfo=kalendarz.TZ)
    except ValueError:
        return None


# ---------- narzędzia ----------
async def sprawdz_wolne_terminy(r: Rozmowa, u: Uslugi, a: dict) -> dict:
    d, err = _dzial(a.get("dzial"), rezerwacja=True)
    if err:
        return err
    teraz = u.teraz()
    od_dnia = _czas(a["od_dnia"] + "T00:00:00") if a.get("od_dnia") else None
    zajete = await u.kalendarz.zajete(d.klucz, teraz, teraz + timedelta(days=config.HORYZONT_DNI + 1))
    terminy = kalendarz.wolne_terminy(d.wizyta_min, teraz, zajete, preferencja=a.get("preferencja") or "",
                                      od_dnia=od_dnia.date() if od_dnia else None)
    r.dzial = d.klucz
    znane = r.propozycje.setdefault(d.klucz, [])
    znane.extend(t for t in terminy if t not in znane)
    if not terminy:
        return {"terminy": [], "komunikat": f"Brak wolnych terminów w najbliższych {config.HORYZONT_DNI} dniach dla tych warunków. "
                                            "Zaproponuj inny dzień albo zapisz zgłoszenie z prośbą o oddzwonienie."}
    return {"dzial": d.klucz, "czas_min": d.wizyta_min,
            "terminy": [{"termin": t.isoformat(), "opis": kalendarz.opis_terminu(t)} for t in terminy]}


async def zarezerwuj_wizyte(r: Rozmowa, u: Uslugi, a: dict) -> dict:
    d, err = _dzial(a.get("dzial"), rezerwacja=True)
    if err:
        return err
    t = _czas(a.get("termin", ""))
    if not t or not any(t == p for p in r.propozycje.get(d.klucz, [])):
        return {"blad": "Ten termin nie pochodzi z propozycji. Najpierw użyj sprawdz_wolne_terminy i zaproponuj klientowi terminy z wyniku."}
    if any(x["dzial"] == d.klucz for x in r.rezerwacje):
        return {"blad": "W tej rozmowie termin w tym dziale jest już zarezerwowany. Druga rezerwacja jest zablokowana."}
    nazwisko, opis = (a.get("imie_nazwisko") or "").strip(), (a.get("opis") or "").strip()
    tel = telefon(a.get("telefon", ""), r.telefon)
    brak = [n for n, v in (("imię i nazwisko", nazwisko), ("numer telefonu", tel), ("opis sprawy", opis)) if not v]
    adres, miasto = (a.get("adres") or "").strip(), (a.get("miasto") or "").strip()
    if d.adres_wymagany:
        brak += [n for n, v in (("adres (ulica i numer)", adres), ("miejscowość", miasto)) if not v]
    if brak:
        return {"blad": "Brakuje danych: " + ", ".join(brak) + ". Zapytaj klienta i powtórz mu je do potwierdzenia."}
    lokal = (a.get("lokal") or "").strip()
    dane = {"imie_nazwisko": nazwisko, "telefon": tel, "rodzaj_opis": d.nazwa,
            "adres_pelny": ", ".join(filter(None, [adres, f"lok. {lokal}" if lokal else "", miasto]))}
    try:
        nr = await u.kalendarz.rezerwuj(d.klucz, t, t + timedelta(minutes=d.wizyta_min), r.call_sid, opis, dane)
    except kalendarz.TerminZajety:
        r.propozycje[d.klucz] = [p for p in r.propozycje.get(d.klucz, []) if p != t]
        return {"blad": "Ten termin został właśnie zajęty. Przeproś klienta i użyj sprawdz_wolne_terminy, żeby zaproponować inne."}
    rez = {"dzial": d.klucz, "rodzaj": d.rodzaj_rezerwacji, "termin": t, "czas_min": d.wizyta_min, "imie_nazwisko": nazwisko, "telefon": tel,
           "adres": adres, "lokal": lokal, "miasto": miasto, "opis": opis, "pilne": bool(a.get("pilne")), "kalendarz_id": nr}
    r.rezerwacje.append(rez)
    r.dzial = d.klucz
    sms = False
    if u.sms and config.SMS_WLACZONE:
        sms = await u.sms(tel, f"{config.FIRMA}: potwierdzamy termin – {kalendarz.opis_terminu(t)}"
                               + (f", {dane['adres_pelny']}" if dane["adres_pelny"] else "") + f". Sprawa: {opis[:80]}.")
    return {"status": "zarezerwowano", "termin": kalendarz.opis_terminu(t), "sms_wyslany": sms}


async def zapisz_zgloszenie(r: Rozmowa, u: Uslugi, a: dict) -> dict:
    d, err = _dzial(a.get("dzial"))
    if err:
        return err
    rodzaj = a.get("rodzaj") or "inne"
    if rodzaj not in RODZAJE_ZGLOSZEN:
        return {"blad": f"Nieznany rodzaj zgłoszenia. Dostępne: {', '.join(RODZAJE_ZGLOSZEN)}."}
    opis, tel = (a.get("opis") or "").strip(), telefon(a.get("telefon", ""), r.telefon)
    if not opis or not tel:
        return {"blad": "Brakuje danych: " + ", ".join(n for n, v in (("opis sprawy", opis), ("numer telefonu", tel)) if not v) + "."}
    dane = {k: str(a[k]).strip()[:500] for k in ("pojazd", "vin", "czesc") if a.get(k)}
    r.zgloszenia.append({"dzial": d.klucz, "rodzaj": rodzaj, "imie_nazwisko": (a.get("imie_nazwisko") or "").strip(), "telefon": tel,
                         "opis": opis, "pilne": bool(a.get("pilne")), "dane": dane})
    r.dzial = r.dzial or d.klucz
    return {"status": "zapisano", "komunikat": "Zgłoszenie przekazane pracownikom" + (" jako pilne" if a.get("pilne") else "") + "."}


async def przekaz_do_konsultanta(r: Rozmowa, u: Uslugi, a: dict) -> dict:
    alternatywa = "Zaproponuj oddzwonienie i zapisz je narzędziem zapisz_zgloszenie (rodzaj „oddzwonienie”)."
    if not r.telefonia:
        return {"status": "niedostepne", "komunikat": "W rozmowie testowej przekazanie nie działa. " + alternatywa}
    if not config.TRANSFER_NUMBER:
        return {"status": "niedostepne", "komunikat": "Przekazanie rozmowy nie jest skonfigurowane. " + alternatywa}
    if not kalendarz.w_godzinach_pracy(u.teraz()):
        return {"status": "poza_godzinami", "komunikat": "Biuro jest teraz zamknięte. " + alternatywa}
    r.przekazana, r.powod_przekazania = True, (a.get("powod") or "").strip()[:300]
    return {"status": "laczenie"}


async def zakoncz_rozmowe(r: Rozmowa, u: Uslugi, a: dict) -> dict:
    r.zakonczenie = True
    return {"status": "koniec"}


NARZEDZIA = {f.__name__: f for f in (sprawdz_wolne_terminy, zarezerwuj_wizyte, zapisz_zgloszenie, przekaz_do_konsultanta, zakoncz_rozmowe)}


def schematy() -> ToolsSchema:
    dzialy = [d.klucz for d in config.aktywne_dzialy()]
    rez = [d.klucz for d in config.aktywne_dzialy() if d.wizyta_min]
    s = lambda opis: {"type": "string", "description": opis}
    return ToolsSchema(standard_tools=[
        FunctionSchema(name="sprawdz_wolne_terminy", description="Zwraca 2–3 wolne terminy wizyty lub rozmowy z agentem. Proponuj klientowi tylko terminy z wyniku.",
                       properties={"dzial": {"type": "string", "enum": rez, "description": "Dział, którego dotyczy termin."},
                                   "preferencja": {"type": "string", "enum": ["", "rano", "popoludnie"], "description": "Pora dnia, jeśli klient ją podał."},
                                   "od_dnia": s("Najwcześniejszy dzień RRRR-MM-DD, jeśli klient chce później (opcjonalnie).")},
                       required=["dzial"]),
        FunctionSchema(name="zarezerwuj_wizyte", description="Rezerwuje termin z propozycji – dopiero gdy klient potwierdził termin i dane słowem „tak”.",
                       properties={"dzial": {"type": "string", "enum": rez}, "termin": s("Pole „termin” dokładnie z wyniku sprawdz_wolne_terminy."),
                                   "imie_nazwisko": s("Imię i nazwisko klienta."), "telefon": s("Numer kontaktowy; pusty = numer dzwoniącego."),
                                   "adres": s("Ulica i numer budynku (wymagane dla podzielników)."), "lokal": s("Numer lokalu / mieszkania."),
                                   "miasto": s("Miejscowość."), "opis": s("Na czym polega sprawa, jednym zdaniem."),
                                   "pilne": {"type": "boolean", "description": "Awaria wymagająca pilnej wizyty."}},
                       required=["dzial", "termin", "imie_nazwisko", "opis"]),
        FunctionSchema(name="zapisz_zgloszenie", description="Zapisuje sprawę do załatwienia przez pracownika: zapytanie o części, prośba o oddzwonienie, sprawa nietypowa.",
                       properties={"dzial": {"type": "string", "enum": dzialy}, "rodzaj": {"type": "string", "enum": RODZAJE_ZGLOSZEN},
                                   "imie_nazwisko": s("Imię i nazwisko klienta."), "telefon": s("Numer kontaktowy; pusty = numer dzwoniącego."),
                                   "opis": s("Czego dotyczy sprawa."), "pilne": {"type": "boolean", "description": "Awaria lub sprawa pilna."},
                                   "pojazd": s("Marka i model pojazdu (części)."), "vin": s("Numer VIN (części)."), "czesc": s("Szukana część (części).")},
                       required=["dzial", "rodzaj", "opis"]),
        FunctionSchema(name="przekaz_do_konsultanta", description="Łączy z pracownikiem: prośba o człowieka, reklamacja, zdenerwowany klient. Działa tylko w godzinach pracy.",
                       properties={"powod": s("Krótko: dlaczego klient chce rozmawiać z pracownikiem.")}, required=["powod"]),
        FunctionSchema(name="zakoncz_rozmowe", description="Kończy rozmowę. Wywołaj po pożegnaniu klienta.", properties={}, required=[]),
    ])
