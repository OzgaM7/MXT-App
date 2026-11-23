from datetime import date, datetime, timedelta, timezone

import kalendarz as K

W = lambda *a: datetime(*a, tzinfo=K.TZ)   # czas warszawski


def test_wielkanoc_i_swieta():
    assert K._wielkanoc(2025) == date(2025, 4, 20) and K._wielkanoc(2026) == date(2026, 4, 5) and K._wielkanoc(2027) == date(2027, 3, 28)
    s = K.swieta(2026)
    assert {date(2026, 11, 11), date(2026, 12, 24), date(2026, 4, 6), date(2026, 6, 4)} <= s   # Niepodległości, Wigilia, Poniedziałek Wielkanocny, Boże Ciało
    assert not K.dzien_roboczy(date(2026, 11, 11)) and not K.dzien_roboczy(date(2026, 11, 28)) and K.dzien_roboczy(date(2026, 11, 23))


def test_godziny_pracy():
    assert K.w_godzinach_pracy(W(2026, 11, 23, 10, 0)) and not K.w_godzinach_pracy(W(2026, 11, 23, 16, 0))
    assert not K.w_godzinach_pracy(W(2026, 11, 23, 7, 59)) and not K.w_godzinach_pracy(W(2026, 11, 28, 10, 0))


def test_propozycje_rozne_dni_po_2_godzinach():
    t = K.wolne_terminy(60, W(2026, 11, 23, 10, 0), [])
    assert t == [W(2026, 11, 23, 12, 0), W(2026, 11, 24, 8, 0), W(2026, 11, 25, 8, 0)]


def test_preferencja_i_zajete():
    assert K.wolne_terminy(60, W(2026, 11, 23, 10, 0), [], preferencja="rano")[0] == W(2026, 11, 24, 8, 0)
    assert K.wolne_terminy(60, W(2026, 11, 23, 10, 0), [], preferencja="popoludnie")[0] == W(2026, 11, 23, 12, 0)
    zajete = [(W(2026, 11, 23, 12, 0), W(2026, 11, 23, 13, 0)), (W(2026, 11, 24, 7, 0), W(2026, 11, 24, 9, 30))]
    t = K.wolne_terminy(60, W(2026, 11, 23, 10, 0), zajete)
    assert t[0] == W(2026, 11, 23, 13, 0) and t[1] == W(2026, 11, 24, 9, 30)


def test_weekend_swieto_i_koniec_dnia():
    t = K.wolne_terminy(60, W(2026, 11, 27, 15, 30), [])          # piątek po 15:30 → poniedziałek
    assert t[0] == W(2026, 11, 30, 8, 0)
    t = K.wolne_terminy(60, W(2026, 11, 9, 15, 0), [])            # 11.11 pomijany
    assert date(2026, 11, 11) not in {x.date() for x in t} and t[0] == W(2026, 11, 10, 8, 0)
    t = K.wolne_terminy(30, W(2026, 11, 23, 13, 0), [], ile=10)   # rozmowa 30 min kończy się najpóźniej o 16:00
    assert all(x.hour * 60 + x.minute + 30 <= 16 * 60 for x in t)


def test_horyzont_14_dni():
    teraz = W(2026, 11, 23, 10, 0)
    assert K.wolne_terminy(60, teraz, [], od_dnia=date(2026, 12, 8)) == []
    assert all(x.date() <= (teraz + timedelta(days=14)).date() for x in K.wolne_terminy(60, teraz, [], od_dnia=date(2026, 12, 4)))


def test_opis_terminu():
    assert K.opis_terminu(W(2026, 11, 24, 8, 0)) == "wtorek, 24 listopada, godzina 8:00"
    assert K.opis_terminu(datetime(2026, 11, 24, 7, 0, tzinfo=timezone.utc)) == "wtorek, 24 listopada, godzina 8:00"   # czas UTC czytany po warszawsku


class _Wywolanie:
    def __init__(self, wynik):
        self.wynik = wynik

    def execute(self):
        return self.wynik


class _FalszyweGoogle:
    """Zaślepka googleapiclient: freebusy().query(...).execute() i events().insert(...).execute()."""
    def __init__(self, zajete):
        self.zajete, self.wpisy = zajete, []

    def freebusy(self):
        api = self
        class F:
            def query(self, body):
                cid = body["items"][0]["id"]
                return _Wywolanie({"calendars": {cid: {"busy": [{"start": s, "end": k} for s, k in api.zajete]}}})
        return F()

    def events(self):
        api = self
        class E:
            def insert(self, calendarId, body):
                api.wpisy.append((calendarId, body))
                return _Wywolanie({"id": "ev1"})
        return E()


def test_kalendarz_google(monkeypatch):
    import asyncio
    monkeypatch.setenv("GOOGLE_KALENDARZ_ID", "biuro@mxt")
    monkeypatch.setenv("GOOGLE_KALENDARZ_PODZIELNIKI", "serwis@mxt")
    g = K.KalendarzGoogle.__new__(K.KalendarzGoogle)
    g.api = _FalszyweGoogle([("2026-11-24T07:00:00Z", "2026-11-24T08:00:00Z")])
    z = asyncio.run(g.zajete("podzielniki", W(2026, 11, 24, 0, 0), W(2026, 11, 25, 0, 0)))
    assert z == [(W(2026, 11, 24, 8, 0), W(2026, 11, 24, 9, 0))]
    try:
        asyncio.run(g.rezerwuj("podzielniki", W(2026, 11, 24, 8, 0), W(2026, 11, 24, 9, 0), "CA1", "x", {}))
        assert False, "kolizja powinna być odrzucona"
    except K.TerminZajety:
        pass
    g.api.zajete = []
    nr = asyncio.run(g.rezerwuj("ubezpieczenia", W(2026, 11, 24, 10, 0), W(2026, 11, 24, 10, 30), "CA2", "OC",
                                {"imie_nazwisko": "Jan Nowak", "telefon": "+48600100200", "rodzaj_opis": "Rozmowa z agentem"}))
    cid, ev = g.api.wpisy[0]
    assert nr == "ev1" and cid == "biuro@mxt" and ev["summary"] == "Rozmowa z agentem: Jan Nowak" and "+48600100200" in ev["description"]
    assert ev["start"]["timeZone"] == "Europe/Warsaw" and ev["start"]["dateTime"].startswith("2026-11-24T10:00:00")
