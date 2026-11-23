# MXT Recepcja AI – asystentka „Ola”

Bot telefoniczny z planu „MXT Recepcja AI – plan działania”. Odbiera numer MXT 24/7, po polsku rozpoznaje sprawę, umawia wizyty i zapisuje zgłoszenia. Każda rozmowa trafia z transkrypcją do aplikacji MXT (dział **Asystent telefoniczny**). Wizyta serwisowa od razu staje się zleceniem w module Serwisy.

```
Telefon ── Twilio ──▶ server.py (/voice, /ws) ──▶ bot.py (Pipecat 1.16)
                                                   Deepgram Nova-3 (pl) → Claude Haiku 5.5 + narzędzia → Cartesia / ElevenLabs
                                                   │
                       narzedzia.py (terminy, rezerwacje, zgłoszenia, przekazanie, koniec)
                       kalendarz.py (SQLite albo Google Calendar)        mxt.py ──▶ aplikacja MXT /api/asystent/webhook
```

| Plik | Co zawiera |
|---|---|
| `config.py` | Działy, godziny pracy, długości wizyt, listy pytań, przełączniki (nagrywanie, SMS) – **zmiany bez programowania** |
| `prompt.py` | Powitanie (ujawnienie AI) i zasady asystentki – **zmiany bez programowania** |
| `narzedzia.py` | Narzędzia Claude i ich zabezpieczenia |
| `kalendarz.py` | Wolne terminy, święta, kalendarz lokalny i Google |
| `bot.py` | Przebieg rozmowy (Pipecat): mowa → tekst → Claude → mowa, transkrypcja, czas odpowiedzi |
| `server.py` | Serwer dla Twilio: `/voice`, `/ws`, `/awaria`, `/health` |
| `telefon.py` | Twilio: podpis, TwiML, przekazanie, rozłączenie, nagrywanie, SMS |
| `mxt.py` | Zdarzenie rozmowy dla aplikacji MXT, podsumowanie, wysyłka z kolejką ponowień |
| `baza.py` | SQLite: rezerwacje kalendarza lokalnego i rejestr rozmów |

## Narzędzia i zabezpieczenia w kodzie

| Narzędzie | Kiedy Claude go używa | Zabezpieczenie w kodzie |
|---|---|---|
| `sprawdz_wolne_terminy` | Klient chce wizytę (60 min) lub rozmowę z agentem (30 min) | Tylko godziny pracy (pon–pt 8–16), bez świąt, min. 2 h wyprzedzenia, horyzont 14 dni, osobny kalendarz każdego działu |
| `zarezerwuj_wizyte` | Klient potwierdził termin i dane | Termin tylko z propozycji tej rozmowy; zajęty termin odrzucony (także gdy dwie rozmowy trwają naraz); adres wymagany dla podzielników; jedna rezerwacja na dział w rozmowie |
| `zapisz_zgloszenie` | Części (pojazd, VIN, część), oddzwonienie, sprawy nietypowe | Flaga „pilne” dla awarii; numer dzwoniącego jako domyślny kontakt |
| `przekaz_do_konsultanta` | Prośba o człowieka, reklamacja, zdenerwowany klient | Tylko w godzinach pracy i z ustawionym `TRANSFER_NUMBER`; poza nimi propozycja oddzwonienia; po przekazaniu bot nie rozłącza rozmowy |
| `zakoncz_rozmowe` | Klient się żegna | Najpierw wybrzmiewa pożegnanie, potem Twilio kończy połączenie |

Powitanie wypowiada bot (nie model) i nie da się go przerwać: „Dzień dobry, tu Ola, wirtualna asystentka AI firmy MXT. W czym mogę pomóc?” (AI Act, art. 50 ust. 1). Przy `NAGRYWANIE=1` dochodzi „Rozmowa jest nagrywana”. Zakazy (ceny, składki, PESEL, karty, hasła, porady ubezpieczeniowe) są w `prompt.py`. Rozmowa dłuższa niż 15 minut jest grzecznie kończona.

## Etap 1 – test na komputerze

1. Klucze: Anthropic (console.anthropic.com, doładowane środki), Deepgram (200 USD kredytu na start), Cartesia (lub ElevenLabs).
2. W Cartesia Playground wybierz polski głos i wpisz jego ID do `.env` (`CARTESIA_VOICE_ID`).
3. Instalacja (Python 3.12):
   ```bash
   cd recepcja
   python3.12 -m venv .venv && . .venv/bin/activate
   pip install -r requirements-dev.txt
   cp .env.example .env   # uzupełnij klucze i MXT_APP_WEBHOOK_TOKEN
   python bot.py
   ```
4. Otwórz http://localhost:7860, kliknij **Connect** i rozmawiaj przez mikrofon. Rozmowy z przeglądarki trafiają do aplikacji MXT jako **testowe** (bez zleceń i statystyk).
5. Min. 20 rozmów testowych: każdy dział, trudne nazwiska, adresy, numery, przerywanie w pół zdania. Popraw `prompt.py` i `config.py` na podstawie transkrypcji w aplikacji MXT (karta rozmowy → przegląd).

## Etap 2 – numer telefonu

1. Twilio: konto, pakiet regulacyjny dla MXT (wypis z KRS/CEIDG, adres w strefie numeru), zakup polskiego numeru.
2. Serwer z HTTPS w UE. Na Render: **New → Web Service** z tego repozytorium, Root Directory `recepcja`, Runtime **Docker**, region Frankfurt, plan płatny (bot nie może zasypiać), dysk `/data` (1 GB) dla bazy SQLite, zmienne z `.env.example` (z `PUBLIC_URL` = adres usługi). Lokalnie: `uvicorn server:app --port 8000` i `ngrok http 8000` (wtedy `PUBLIC_URL` = adres ngrok).
3. Numer w Twilio → Voice Configuration: **A call comes in** → Webhook `https://<serwer>/voice` (HTTP POST); **Primary handler fails** → `https://<serwer>/awaria` (łączy z pracownikiem, gdy bot nie działa).
4. Na czas testów `ROZMOWY_TESTOWE=1` – rozmowy w aplikacji MXT bez zleceń. 30 testów z różnych telefonów (komórka, stacjonarny, głośnik w aucie, hałas).
5. Ustaw `TRANSFER_NUMBER` i sprawdź przekazanie do pracownika w godzinach pracy.

## Etap 3 – integracje

- **Aplikacja MXT** – gotowe: `MXT_APP_WEBHOOK_URL` i `MXT_APP_WEBHOOK_TOKEN` (aplikacja: Asystent telefoniczny → Integracja z botem). Rozmowa najpierw zapisuje się w lokalnej bazie; gdy aplikacja nie odpowiada, czeka w kolejce i jest wysyłana ponownie (po kolejnej rozmowie i przy starcie serwera), bez duplikatów.
- **Google Calendar**: konto serwisowe w Google Cloud, kalendarz udostępniony jego adresowi (prawo wprowadzania zmian), w `requirements.txt` odkomentuj biblioteki Google, `KALENDARZ=google`, `GOOGLE_SERVICE_ACCOUNT_FILE`, `GOOGLE_KALENDARZ_ID` (opcjonalnie osobne kalendarze działów).
- **SMS** z potwierdzeniem: `SMS_WLACZONE=1`, `TWILIO_NUMER`.
- **RODO**: klauzula informacyjna na stronie, umowy powierzenia (Twilio, Deepgram, Cartesia, Anthropic), decyzja o nagrywaniu. Transkrypcje w aplikacji MXT usuwają się po 90 dniach (ustawienie w zakładce Integracja z botem).

## Etap 4 – start na żywo

Najpierw przekierowanie z obecnego numeru firmy tylko po godzinach i przy nieodebranych (po 20 s) – ustawia się u operatora numeru firmowego. Przez 2 tygodnie codzienny przegląd transkrypcji w aplikacji MXT (ocena „Sprawdzona / Błąd w danych”). Gdy wskaźniki w aplikacji są dobre (rezerwacja lub zgłoszenie ≥ 70%, przekazania < 20%, pomyłki ≤ 2%, odpowiedź < 1,5 s), przekierowanie całego ruchu.

## Testy

```bash
cd recepcja && . .venv/bin/activate && pytest
```

35 testów bez sieci i kluczy: kalendarz (godziny, święta, wyprzedzenie, horyzont, kolizje, Google), narzędzia (wszystkie zabezpieczenia z tabeli), prompt (ujawnienie AI, zakazy), zdarzenie dla aplikacji MXT i kolejka ponowień, serwer (podpis Twilio, TwiML, odrzucanie obcych strumieni), połączenie narzędzi z Pipecat (przekazanie, pożegnanie przed rozłączeniem). Zgodność z prawdziwym webhookiem aplikacji: `MXT_TEST_WEBHOOK_URL=… MXT_TEST_WEBHOOK_TOKEN=… pytest tests/test_kontrakt_mxt.py`.

## Koszty

Według planu ok. 0,0335 USD za minutę rozmowy (Twilio 0,0107 + Media Streams 0,0044 + Deepgram 0,0048 + Cartesia ok. 0,0116 + Claude Haiku 5.5 ok. 0,0020), czyli ok. 30 USD za 900 minut miesięcznie, plus numer (2,90 USD), Cartesia Startup (49 USD) i serwer. Podsumowanie rozmowy przez Claude to ułamek centa (`PODSUMOWANIE_AI=0` wyłącza).
