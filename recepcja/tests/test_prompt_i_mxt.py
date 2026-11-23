import asyncio
import json
import os
import tempfile
from datetime import datetime, timezone

import httpx

import config
import kalendarz as K
import mxt
import narzedzia as N
import prompt
from baza import Baza

W = lambda *a: datetime(*a, tzinfo=K.TZ)


# ---------- prompt ----------
def test_powitanie_ujawnia_ai():
    p = prompt.powitanie(nagrywanie=False)
    assert p.startswith("Dzień dobry, tu Ola, wirtualna asystentka AI firmy MXT.") and "nagrywana" not in p
    assert "Rozmowa jest nagrywana." in prompt.powitanie(nagrywanie=True)


def test_instrukcje():
    t = prompt.instrukcje(W(2026, 11, 23, 18, 30), "+48600100200")
    assert "poniedziałek, 23 listopada 2026, godzina 18:30" in t and "Biuro jest teraz zamknięte" in t and "+48600100200" in t
    assert "Podzielniki ciepła i montaże" in t and "MXT Agencja Ubezpieczeniowa" in t and "Taxi" not in t
    for zasada in ("jesteś asystentką AI", "Nie podajesz cen, składek", "PESEL", "sprawdz_wolne_terminy", "zakoncz_rozmowe", "poniedziałek–piątek, 08:00–16:00"):
        assert zasada in t, zasada
    assert "Biuro jest teraz otwarte" in prompt.instrukcje(W(2026, 11, 23, 9, 0))


# ---------- zdarzenie dla aplikacji MXT ----------
def rozmowa_z_danymi():
    r = N.Rozmowa(call_sid="CAkontrakt", telefon="+48600100200", rozpoczeta=datetime(2026, 11, 23, 9, 0, tzinfo=timezone.utc))
    r.dodaj("asystent", prompt.powitanie(False))
    r.dodaj("klient", "Podzielnik w kuchni nic nie pokazuje.")
    r.dodaj("klient", "Tak, pasuje.")
    r.rezerwacje.append({"dzial": "podzielniki", "rodzaj": "wizyta_serwisowa", "termin": W(2026, 11, 24, 8, 0), "czas_min": 60, "imie_nazwisko": "Anna Kowalska",
                         "telefon": "+48600100200", "adres": "ul. Lipowa 5", "lokal": "12", "miasto": "Zielona Góra", "opis": "Podzielnik nie działa", "pilne": True})
    r.zgloszenia.append({"dzial": "czesci", "rodzaj": "zapytanie_czesci", "imie_nazwisko": "Anna", "telefon": "+48600100200", "opis": "Filtr",
                         "pilne": False, "dane": {"pojazd": "MAN TGX"}})
    r.dzial, r.opoznienia_ms = "podzielniki", [1000, 1300]
    return r


def test_wynik_rozmowy():
    r = N.Rozmowa(call_sid="x")
    assert mxt.wynik(r) == "przerwana"
    r.dodaj("klient", "a"); r.dodaj("klient", "b")
    assert mxt.wynik(r) == "informacja"
    r.zgloszenia.append({"rodzaj": "oddzwonienie"})
    assert mxt.wynik(r) == "oddzwonienie"
    r.zgloszenia.append({"rodzaj": "zapytanie_czesci"})
    assert mxt.wynik(r) == "zgloszenie"
    r.przekazana = True
    assert mxt.wynik(r) == "przekazanie"
    r.rezerwacje.append({})
    assert mxt.wynik(r) == "rezerwacja"


def test_zdarzenie_zgodne_z_kontraktem():
    z = mxt.zdarzenie(rozmowa_z_danymi(), "Umówiona wizyta.")
    assert set(z) == {"call_sid", "test", "rozpoczeta", "zakonczona", "telefon", "dzial", "wynik", "przekazana", "podsumowanie",
                      "sredni_czas_odpowiedzi_ms", "transkrypcja", "zgloszenia"}
    assert z["wynik"] == "rezerwacja" and z["dzial"] == "podzielniki" and z["sredni_czas_odpowiedzi_ms"] == 1150
    assert [t["rola"] for t in z["transkrypcja"]] == ["asystent", "klient", "klient"] and all(t["czas"] for t in z["transkrypcja"])
    w, c = z["zgloszenia"]
    assert w["rodzaj"] == "wizyta_serwisowa" and w["termin"] == "2026-11-24T08:00:00+01:00" and w["czas_min"] == 60 and w["pilne"] and w["lokal"] == "12"
    assert c["rodzaj"] == "zapytanie_czesci" and c["dane"] == {"pojazd": "MAN TGX"} and "termin" not in c
    json.dumps(z)   # serializowalne


def test_podsumowanie_z_danych():
    s = mxt.podsumowanie_z_danych(rozmowa_z_danymi())
    assert "termin wtorek, 24 listopada, godzina 8:00, Anna Kowalska, ul. Lipowa 5" in s and "Zgłoszenie (zapytanie czesci): Filtr" in s


# ---------- wysyłka z kolejką ----------
def test_wysylka_i_kolejka(monkeypatch):
    oryginal = asyncio.sleep
    monkeypatch.setattr(mxt.asyncio, "sleep", lambda *_: oryginal(0))
    b = Baza(os.path.join(tempfile.mkdtemp(), "t.db"))
    stan = {"kod": 500, "zadania": []}

    def odp(req: httpx.Request):
        stan["zadania"].append(req)
        return httpx.Response(stan["kod"], json={})
    k = mxt.KlientMXT(b, url="https://mxt.test/api/asystent/webhook", token="mxt_tel_x", transport=httpx.MockTransport(odp))
    z = mxt.zdarzenie(rozmowa_z_danymi(), "x")
    assert asyncio.run(k.wyslij(z)) is False and len(stan["zadania"]) == 3            # 500 → 3 próby, potem kolejka
    assert stan["zadania"][0].headers["authorization"] == "Bearer mxt_tel_x" and json.loads(stan["zadania"][0].content)["call_sid"] == "CAkontrakt"
    assert len(asyncio.run(b.do_wyslania())) == 1
    stan["kod"] = 201
    assert asyncio.run(k.ponow_zalegle()) == 1 and asyncio.run(b.do_wyslania()) == []
    stan["kod"], stan["zadania"] = 400, []
    z2 = {**z, "call_sid": "CAzle"}
    assert asyncio.run(k.wyslij(z2)) is False and len(stan["zadania"]) == 1             # błąd danych – bez ponawiania


def test_brak_konfiguracji_mxt():
    b = Baza(os.path.join(tempfile.mkdtemp(), "t.db"))
    assert asyncio.run(mxt.KlientMXT(b, url="", token="").wyslij(mxt.zdarzenie(rozmowa_z_danymi(), "x"))) is False
    assert len(asyncio.run(b.do_wyslania())) == 1
