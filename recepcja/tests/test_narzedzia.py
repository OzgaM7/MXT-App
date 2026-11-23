import asyncio
import os
import tempfile
from datetime import datetime

import pytest

import config
import kalendarz as K
import narzedzia as N
from baza import Baza

W = lambda *a: datetime(*a, tzinfo=K.TZ)
run = asyncio.run


@pytest.fixture
def u():
    b = Baza(os.path.join(tempfile.mkdtemp(), "t.db"))
    return N.Uslugi(kalendarz=K.KalendarzLokalny(b), teraz=lambda: W(2026, 11, 23, 10, 0))


def rozmowa(**kw):
    return N.Rozmowa(call_sid=kw.pop("call_sid", "CA-test"), telefon=kw.pop("telefon", "+48600100200"), **kw)


WIZYTA = {"dzial": "podzielniki", "imie_nazwisko": "Anna Kowalska", "opis": "Podzielnik nie działa", "adres": "ul. Lipowa 5", "lokal": "12", "miasto": "Zielona Góra"}


def test_telefon():
    assert N.telefon("600 100 200") == "+48600100200" and N.telefon("0048 600-100-200") == "+48600100200"
    assert N.telefon("", "+48 601 000 001") == "+48601000001" and N.telefon("123") == "" and N.telefon("abc", "") == ""


def test_rezerwacja_tylko_z_propozycji(u):
    r = rozmowa()
    assert "blad" in run(N.zarezerwuj_wizyte(r, u, {**WIZYTA, "termin": "2026-11-24T08:00:00+01:00"}))   # bez sprawdz_wolne_terminy
    w = run(N.sprawdz_wolne_terminy(r, u, {"dzial": "podzielniki"}))
    assert len(w["terminy"]) == 3 and w["czas_min"] == 60 and r.dzial == "podzielniki"
    assert "blad" in run(N.zarezerwuj_wizyte(r, u, {**WIZYTA, "termin": "2026-11-24T10:00:00+01:00"}))   # spoza propozycji
    ok = run(N.zarezerwuj_wizyte(r, u, {**WIZYTA, "termin": w["terminy"][1]["termin"]}))
    assert ok["status"] == "zarezerwowano" and ok["termin"] == "wtorek, 24 listopada, godzina 8:00"
    x = r.rezerwacje[0]
    assert x["telefon"] == "+48600100200" and x["rodzaj"] == "wizyta_serwisowa" and x["termin"] == W(2026, 11, 24, 8, 0)
    assert "już zarezerwowany" in run(N.zarezerwuj_wizyte(r, u, {**WIZYTA, "termin": w["terminy"][2]["termin"]}))["blad"]


def test_rezerwacja_termin_w_formacie_utc(u):
    r = rozmowa()
    t = run(N.sprawdz_wolne_terminy(r, u, {"dzial": "podzielniki"}))["terminy"][0]["termin"]
    utc = datetime.fromisoformat(t).astimezone(__import__("datetime").timezone.utc).isoformat().replace("+00:00", "Z")
    assert run(N.zarezerwuj_wizyte(r, u, {**WIZYTA, "termin": utc}))["status"] == "zarezerwowano"


def test_adres_wymagany_dla_podzielnikow(u):
    r = rozmowa()
    t = run(N.sprawdz_wolne_terminy(r, u, {"dzial": "podzielniki"}))["terminy"][0]["termin"]
    w = run(N.zarezerwuj_wizyte(r, u, {**WIZYTA, "adres": "", "miasto": "", "termin": t}))
    assert "adres" in w["blad"] and "miejscowość" in w["blad"] and not r.rezerwacje


def test_podwojna_rezerwacja_dwie_rozmowy(u):
    r1, r2 = rozmowa(call_sid="CA1"), rozmowa(call_sid="CA2")
    t1 = run(N.sprawdz_wolne_terminy(r1, u, {"dzial": "podzielniki"}))["terminy"][0]["termin"]
    t2 = run(N.sprawdz_wolne_terminy(r2, u, {"dzial": "podzielniki"}))["terminy"][0]["termin"]
    assert t1 == t2
    assert run(N.zarezerwuj_wizyte(r1, u, {**WIZYTA, "termin": t1}))["status"] == "zarezerwowano"
    w = run(N.zarezerwuj_wizyte(r2, u, {**WIZYTA, "termin": t2}))
    assert "zajęty" in w["blad"] and not r2.rezerwacje and N._czas(t2) not in r2.propozycje["podzielniki"]
    assert run(N.sprawdz_wolne_terminy(r2, u, {"dzial": "podzielniki"}))["terminy"][0]["termin"] != t1   # nowe propozycje bez zajętego


def test_ubezpieczenia_bez_adresu_i_osobny_kalendarz(u):
    r = rozmowa()
    w = run(N.sprawdz_wolne_terminy(r, u, {"dzial": "ubezpieczenia"}))
    assert w["czas_min"] == 30
    ok = run(N.zarezerwuj_wizyte(r, u, {"dzial": "ubezpieczenia", "termin": w["terminy"][0]["termin"], "imie_nazwisko": "Jan Nowak", "opis": "OC na auto"}))
    assert ok["status"] == "zarezerwowano" and r.rezerwacje[0]["rodzaj"] == "rozmowa_agent"
    assert run(N.sprawdz_wolne_terminy(rozmowa(), u, {"dzial": "podzielniki"}))["terminy"][0]["termin"] == w["terminy"][0]["termin"]   # inny dział – termin wolny


def test_dzialy_bez_rezerwacji_i_wylaczone(u):
    r = rozmowa()
    assert "nie rezerwuje" in run(N.sprawdz_wolne_terminy(r, u, {"dzial": "czesci"}))["blad"]
    assert "nie jest obsługiwany" in run(N.sprawdz_wolne_terminy(r, u, {"dzial": "taxi"}))["blad"]
    assert "blad" in run(N.zapisz_zgloszenie(r, u, {"dzial": "taxi", "rodzaj": "taxi", "opis": "Przejazd"}))
    assert "blad" in run(N.zapisz_zgloszenie(r, u, {"dzial": "czesci", "rodzaj": "pizza", "opis": "x"}))


def test_zgloszenie_czesci(u):
    r = rozmowa()
    w = run(N.zapisz_zgloszenie(r, u, {"dzial": "czesci", "rodzaj": "zapytanie_czesci", "imie_nazwisko": "Piotr", "opis": "Klocki hamulcowe",
                                       "pojazd": "MAN TGX", "vin": "WMA06XZZ1234", "pilne": True}))
    assert w["status"] == "zapisano" and "pilne" in w["komunikat"]
    z = r.zgloszenia[0]
    assert z["telefon"] == "+48600100200" and z["dane"] == {"pojazd": "MAN TGX", "vin": "WMA06XZZ1234"} and z["pilne"] and r.dzial == "czesci"
    bez = rozmowa(telefon="")
    assert "numer telefonu" in run(N.zapisz_zgloszenie(bez, u, {"dzial": "czesci", "rodzaj": "oddzwonienie", "opis": "x"}))["blad"]


def test_przekazanie(u, monkeypatch):
    assert run(N.przekaz_do_konsultanta(rozmowa(telefonia=False), u, {"powod": "x"}))["status"] == "niedostepne"
    assert run(N.przekaz_do_konsultanta(rozmowa(), u, {"powod": "x"}))["status"] == "niedostepne"   # brak TRANSFER_NUMBER
    monkeypatch.setattr(config, "TRANSFER_NUMBER", "+48600999888")
    wieczor = N.Uslugi(kalendarz=u.kalendarz, teraz=lambda: W(2026, 11, 23, 18, 0))
    r = rozmowa()
    assert run(N.przekaz_do_konsultanta(r, wieczor, {"powod": "reklamacja"}))["status"] == "poza_godzinami" and not r.przekazana
    assert run(N.przekaz_do_konsultanta(r, u, {"powod": "reklamacja"}))["status"] == "laczenie" and r.przekazana and r.powod_przekazania == "reklamacja"


def test_sms_po_rezerwacji(u, monkeypatch):
    wyslane = []

    async def sms(do, tresc):
        wyslane.append((do, tresc))
        return True
    monkeypatch.setattr(config, "SMS_WLACZONE", True)
    u2 = N.Uslugi(kalendarz=u.kalendarz, teraz=u.teraz, sms=sms)
    r = rozmowa()
    t = run(N.sprawdz_wolne_terminy(r, u2, {"dzial": "podzielniki"}))["terminy"][0]["termin"]
    assert run(N.zarezerwuj_wizyte(r, u2, {**WIZYTA, "termin": t}))["sms_wyslany"] is True
    assert wyslane[0][0] == "+48600100200" and "ul. Lipowa 5, lok. 12, Zielona Góra" in wyslane[0][1]


def test_schematy_narzedzi():
    s = N.schematy()
    nazwy = [f.name for f in s.standard_tools]
    assert nazwy == list(N.NARZEDZIA)
    rez = next(f for f in s.standard_tools if f.name == "zarezerwuj_wizyte")
    assert rez.properties["dzial"]["enum"] == ["podzielniki", "ubezpieczenia"] and "termin" in rez.required
