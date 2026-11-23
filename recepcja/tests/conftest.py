import os
import sys
import tempfile

# Środowisko testów ustawiane przed importem config (bez kluczy, sieci i aplikacji MXT).
_tmp = tempfile.mkdtemp(prefix="recepcja-test-")
os.environ.update({"BAZA_SQLITE": os.path.join(_tmp, "test.db"), "MXT_APP_WEBHOOK_URL": "", "MXT_APP_WEBHOOK_TOKEN": "",
                   "PODSUMOWANIE_AI": "0", "TWILIO_AUTH_TOKEN": "test-token", "TWILIO_ACCOUNT_SID": "", "TRANSFER_NUMBER": "",
                   "NAGRYWANIE": "0", "SMS_WLACZONE": "0", "KALENDARZ": "lokalny", "TAXI_WLACZONE": "0"})
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
