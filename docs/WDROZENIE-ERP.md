# Wdrożenie MXT ERP na produkcję (gałąź `erp` → `main`)

Wdrożenie wykonujemy dopiero po akceptacji właściciela. Produkcja (Render) buduje się automatycznie z gałęzi `main`;
przy starcie kontenera najpierw działają migracje (`node scripts/migrate.js`), potem serwer. Jeśli migracja się nie uda,
nowa wersja nie wstaje, a Render zostawia działającą poprzednią.

## Wdrożenie poprawek po audycie (mxt-v26, migracja `021`)

- **Baza:** `021_audyt_poprawki.sql` – tylko dodaje: kolumny archiwum/anonimizacji klientów, archiwum budynków, anulowania
  polis (`019`: kolumny przed widokiem `policies_v`, widok tworzony od nowa – widok nie przechowuje danych) i dokumentów
  magazynowych, rozszerzona lista zdarzeń polis, ~40 indeksów kluczy obcych (Rentowność przy 3000 budynków: 14,7 s → 0,46 s).
  Żadne istniejące dane nie są zmieniane ani usuwane. Migracja sprawdzona dwukrotnie na pustej bazie i na bazie testowej.
- **Wycofanie:** poprzednia wersja działa na bazie po `021` (dodatkowe kolumny i indeksy jej nie przeszkadzają). Jeśli
  w nowej wersji anulowano polisę (zdarzenie „anulowanie”), migracja `019` poprzedniej wersji nie odtworzy starszej listy
  zdarzeń – nowa wersja wtedy nie wstanie, a Render zostawi działającą poprzednią (bez utraty danych).
- **Aplikacja na telefonie:** nowa wersja plików `mxt-v26` pobiera się sama.
- **Strefa czasowa:** każde połączenie z bazą ustawia strefę `Europe/Warsaw` (parametr startowy połączenia), a daty domyślne
  w kodzie liczone są wg czasu polskiego (`lib/dzis.js`) – dokumenty wystawione tuż po północy nie dostają już wczorajszej daty.
  Za pulą połączeń, która nie przyjmuje parametrów startowych (np. pgbouncer w trybie transakcji): `DB_TIMEZONE=` (puste)
  i jednorazowo `ALTER DATABASE … SET timezone = 'Europe/Warsaw'`. Render (bezpośrednie połączenie) – bez zmian konfiguracji.

## Co zmienia wdrożenie

- **Baza:** migracje `016`–`020` – tylko dodają (nowe tabele, kolumny, indeksy, rozszerzone listy dozwolonych wartości).
  Jedyna zmiana istniejących danych: nazwy działów „Ciepłomierze i podzielniki” i „Sprzedaż części samochodowych”
  (identyfikatory i adresy bez zmian). Żadne dane nie są usuwane.
- **Menu:** nowe moduły Magazyn i zakupy, Finanse firmy, Pulpit właściciela, Pracownicy, Mój czas pracy, Szkolenia
  (platforma przeniesiona z działu Ubezpieczenia bez zmian); dział Ubezpieczenia = rejestr polis; dział Sprzedaż części
  ma zamówienia, produkty i analitykę.
- **Role:** dochodzą właściciel, magazynier, księgowość, dostęp ograniczony. Istniejące konta zachowują swoje role.
- **Aplikacja na telefonie (PWA):** nowa wersja plików (`mxt-v22`) pobiera się sama przy następnym otwarciu.

## Sprawdzone przed wdrożeniem (kopia bazy w schemacie produkcji)

1. Baza zbudowana kodem z `main` (stan produkcji), wypełniona danymi (~11,5 tys. wierszy w 60 tabelach).
2. Migracje ERP uruchomione dwa razy: bez błędów, 25 nowych tabel, liczba wierszy w starych tabelach bez zmian,
   suma kontrolna treści wszystkich starych kolumn bez zmian poza nazwami działów.
3. Na tak zaktualizowanej bazie: cały zestaw testów (1205 sprawdzeń) – OK.
4. **Wycofanie:** kod z `main` uruchomiony na zaktualizowanej bazie – jego migracje niczego nie zawężają ani nie zmieniają,
   jego pełny zestaw testów (879 sprawdzeń) – OK. Powrót do poprzedniej wersji w Render jest więc bezpieczny.

## Kolejność wdrożenia

1. **Kopia bazy produkcyjnej** (obowiązkowo, tuż przed wdrożeniem):
   ```bash
   DATABASE_URL='<External Database URL z panelu Render>' sh scripts/kopia-bazy.sh
   ```
   Skrypt zapisuje plik `mxt-RRRRMMDD-GGMM.dump` i sprawdza, czy da się go odczytać. Potrzebny jest `pg_dump`
   w wersji co najmniej takiej jak serwer bazy. Plik przechowuj poza repozytorium (zawiera dane klientów).
2. Scalenie `erp` → `main` (bez przepisywania historii) i wypchnięcie `main` – Render zaczyna budowanie.
3. W panelu Render → usługa `mxt` → **Logs**: linie `Wykonano 016…020`, potem start serwera.
4. Sprawdzenie po wdrożeniu:
   - `GET /api/health` → `{"ok":true}`;
   - logowanie, Wybór działu, każdy dział i moduł z menu otwiera się bez błędu;
   - Pulpit właściciela i Finanse firmy pokazują liczby (Ubezpieczenia: przychód = zysk z polis);
   - stare dane (montaże, serwisy, odczyty, finanse, klienci) widoczne jak przed wdrożeniem.
5. Nadanie ról nowym osobom (Konta i role): właściciel, magazynier, księgowość – według potrzeb.

## Wycofanie (gdy coś nie działa)

- Render → usługa `mxt` → **Events / Deploys** → przy poprzednim wdrożeniu **Rollback**. Kod wraca do wersji sprzed ERP;
  baza zostaje (nowe tabele są dla starej wersji niewidoczne, nic nie trzeba kasować).
- Odtworzenie bazy z kopii tylko w ostateczności i do **nowej, pustej** bazy:
  `pg_restore --no-owner --no-acl -d '<adres nowej bazy>' mxt-….dump` – potem przełączenie `DATABASE_URL`.
  Kopia i odtworzenie zostały sprawdzone lokalnie (85 tabel, identyczna liczba wierszy).

## Kopie zapasowe – na stałe

- Darmowa baza na Render ma ograniczony czas życia i nie ma automatycznych kopii. Przed datą wygaśnięcia
  (widoczną w panelu bazy) trzeba przejść na płatny plan albo przenieść dane – plan: przejście na płatny plan w grudniu.
- Do tego czasu: kopia `scripts/kopia-bazy.sh` co najmniej raz w tygodniu i zawsze przed wdrożeniem.
- Po przejściu na płatny plan: włączone kopie w panelu Render; ręczna kopia nadal przed każdym wdrożeniem.

## Integracje czekające na dane dostępowe (nic nie jest symulowane)

Stan widać w Finanse firmy → Eksport i integracje.

| Integracja | Co jest gotowe | Czego brakuje |
|---|---|---|
| KSeF | rejestr faktur, eksport | `KSEF_TOKEN`, `KSEF_NIP` i uzgodnienie z księgową – faktury nie są wysyłane |
| Program księgowy | eksport XLSX (sprzedaż, zakupy, koszty, polisy) | wybór programu i dane API |
| Poczta e-mail | kolejka wiadomości | `SMTP_HOST`, `SMTP_FROM` (bez nich e-maile czekają w kolejce) |
| SMS | kanał w powiadomieniach | konto u operatora SMS i klucz |
| Kalendarz Google | obsługa w bocie telefonicznym | konto serwisowe Google |
| Mapy / trasy | adresy budynków i zleceń | klucz usługi map |
| Urządzenia pomiarowe | import odczytów z pliku czytnika | dane dostępowe API producenta |
