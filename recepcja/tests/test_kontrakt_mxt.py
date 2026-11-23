"""Zgodność z prawdziwym webhookiem aplikacji MXT (uruchamiany tylko z MXT_TEST_WEBHOOK_URL i MXT_TEST_WEBHOOK_TOKEN).

Przykład: aplikacja MXT lokalnie → Asystent telefoniczny → Integracja z botem → Wygeneruj klucz, potem:
MXT_TEST_WEBHOOK_URL=http://localhost:3000/api/asystent/webhook MXT_TEST_WEBHOOK_TOKEN=mxt_tel_... pytest tests/test_kontrakt_mxt.py
Rozmowa jest wysyłana jako testowa (bez zleceń i powiadomień w aplikacji).
"""

import asyncio
import os
import tempfile
import uuid

import pytest

import mxt
from baza import Baza
from test_prompt_i_mxt import rozmowa_z_danymi

URL, TOKEN = os.getenv("MXT_TEST_WEBHOOK_URL"), os.getenv("MXT_TEST_WEBHOOK_TOKEN")


@pytest.mark.skipif(not URL or not TOKEN, reason="brak MXT_TEST_WEBHOOK_URL / MXT_TEST_WEBHOOK_TOKEN")
def test_aplikacja_mxt_przyjmuje_rozmowe_z_bota():
    r = rozmowa_z_danymi()
    r.call_sid, r.test = "TEST-bot-" + uuid.uuid4().hex[:10], True
    b = Baza(os.path.join(tempfile.mkdtemp(), "t.db"))
    k = mxt.KlientMXT(b, url=URL, token=TOKEN)
    assert asyncio.run(k.wyslij(mxt.zdarzenie(r, mxt.podsumowanie_z_danych(r)))) is True
    assert asyncio.run(b.do_wyslania()) == []
    assert asyncio.run(k.wyslij(mxt.zdarzenie(r, "drugi raz"))) is True   # ten sam call_sid – aplikacja odpowiada 200, bez duplikatu
