# MXT – system zarządzania pracą (etap 1)

Aplikacja webowa (PWA) firmy MXT: logowanie, ekran powitalny i wybór działu.
Moduły działów będą dodawane w kolejnych etapach.

- **Serwer:** Node.js 22 + Express
- **Baza:** PostgreSQL (własny serwer, Docker albo Supabase)
- **Hasła:** wyłącznie hash bcrypt (koszt 12)
- **Sesja:** losowy token w ciasteczku httpOnly; w bazie zapisany jest tylko jego skrót SHA-256. Logowanie jest pamiętane 30 dni.

## Zmiana hasła przy pierwszym logowaniu

- **Wymuszenie przez serwer:** konto z `must_change_password = true` (hasło startowe `1234` albo hasło tymczasowe po resecie) po zalogowaniu widzi tylko ekran „Ustaw własne hasło”. Każde inne API zwraca 403 z kodem `must_change_password`, także przy bezpośrednim wywołaniu.
- **Wymagania hasła** (`lib/password.js`, ten sam zestaw podpowiada ekran na żywo):
  - co najmniej 10 znaków, litera i cyfra;
  - nie popularne hasło (np. 1234, qwerty), nie zawiera loginu;
  - inne niż obecne.
- **Po zmianie:** pozostałe sesje są wylogowane, a w rejestrze pojawia się wpis `haslo.zmiana`. Po 5 błędnych próbach podania obecnego hasła obowiązuje 15 minut blokady.
- **Zmiana w dowolnym momencie:** Menu → „Zmień hasło”.
- **Zapomniane hasło:** administrator w Konta i role → „Reset hasła”. Hasło tymczasowe jest pokazywane raz, konto zostaje wylogowane, a przy logowaniu pracownik ustawia własne. Wpis w rejestrze: `haslo.reset`.
- **Testy:** `test/haslo.js`, 56 sprawdzeń, w ramach `npm test`.

## Rozbudowa działu Podzielniki i Montaże – etap 1 (fundament)

Podstawa pod duże montaże, aplikację montera, serwisy i odczyty. Migracja `db/010_d1_fundament_konta_powiadomienia.sql`.

- **Konta i role** (moduł „Konta i role”, tylko administrator):
  - zakładanie kont pracowników z hasłem tymczasowym (zmiana przy pierwszym logowaniu);
  - role: Administrator, Pracownik biura, Kierownik, Osoba rozliczająca, Monter, Serwisant, Obsługa odczytów. Konto ma rolę główną i może mieć role dodatkowe – uprawnienia się sumują (`lib/rbac.js`);
  - kont się nie usuwa: wyłączone konto nie loguje się, jest wylogowane ze wszystkich urządzeń, a jego wpisy zostają;
  - nie można wyłączyć własnego konta ani zmienić własnej roli; musi zostać co najmniej jeden aktywny administrator;
  - role nadane przez administratora nie są nadpisywane przy ponownym wdrożeniu (migracja 003 ustawia role startowe tylko przy pierwszej instalacji).
- **Konto montera ↔ instalator:** konto powiązane z instalatorem widzi w „Moje montaże” wyłącznie montaże swojej ekipy: termin, adres z nawigacją, zakres prac, materiały, urządzenia, skład ekipy z telefonami. Bez finansów, wartości kontraktów i danych innych ekip – reguła w jednym miejscu (`lib/scope.js`), cudzy montaż zwraca 404 i trafia do rejestru jako odmowa dostępu. Pozostałe moduły zwracają monterowi 403.
- **Powiadomienia** (`lib/notify.js`, dzwonek z licznikiem w pasku u góry, strona „Powiadomienia”):
  - przydział montażu do ekipy, zmiana terminu, przekazanie innej ekipie, anulowanie, przeniesienie instalatora do innej ekipy – tylko do kont danej ekipy;
  - push na telefon (Web Push, bez płatnych usług; klucze VAPID generowane automatycznie i zapisane w bazie). Na iPhonie działa po dodaniu MXT do ekranu głównego;
  - opcjonalna kopia na e-mail (gdy konto ma adres e-mail i pracownik ją włączy);
  - klucz deduplikacji: to samo przypomnienie nie trafi do tej samej osoby dwa razy (gotowe pod terminy serwisów i odczytów);
  - dostawa przez kolejkę zadań z ponawianiem; urządzenia, które wypisały się z powiadomień, są usuwane.
- **Finanse – anulowanie zamiast usuwania:** wpis znika z sum i zestawień, a pełna kopia trafia do archiwum `finance_cancelled` z powodem, autorem i datą (Finance Intelligence → „Anuluj”, tylko administrator).
- **Eksport do Excela (XLSX)** z działu Podzielniki i Montaże: budynki, urządzenia, harmonogram montaży, kontrakty, finanse działu, rentowność (3 arkusze). Te same filtry co na ekranie, nagłówki z filtrem, daty jako daty Excela, kwoty w zł. Każdy eksport jest w rejestrze operacji. Uprawnienie `export.xlsx` mają role biurowe, monter nie.
- **Stronicowanie urządzeń:** lista po 100 pozycji z filtrem typu i statusu oraz łączną liczbą (projekty z tysiącami podzielników).
- **Konfiguracja (opcjonalnie):** `PUSH_CONTACT` – adres kontaktowy dla usług push (domyślnie adres aplikacji z `APP_URL` albo Render).
- **Testy:** `test/fundament.js`, 104 sprawdzenia, w ramach `npm test`.

## Zlecenia serwisowe (dział Podzielniki i Montaże)

Osobny proces, niezależny od dużych montaży. Migracja `db/011_d1_serwisy.sql`, logika `lib/service.js`, API `routes/serwisy.js`, interfejs `public/serwisy.js`.

- **Biuro** (zakładka „Serwisy” w dziale, uprawnienie `service.manage` – role biurowe):
  - przyjęcie zlecenia: data otrzymania, klient, adres i lokal (albo budynek z ewidencji lub reklamacja – adres uzupełni się sam), kontakt, opis, priorytet, termin realizacji;
  - **termin przydzielenia: 14 dni kalendarzowych od daty otrzymania**, liczony automatycznie (`assign_due`). Termin realizacji to osobne pole;
  - przydział serwisanta (lista z liczbą otwartych zleceń), termin wizyty, zmiana lub odebranie przydziału, edycja, notatki, zdjęcia, anulowanie z powodem;
  - kafelki: do przydzielenia, po terminie przydziału, przydział w ciągu 3 dni, u serwisantów, po terminie realizacji, do zatwierdzenia;
  - zatwierdzanie wykonanych zleceń: administrator i kierownik (`service.approve`); można też cofnąć zlecenie do poprawy.
- **Statusy:** Nowe (do weryfikacji), Oczekuje na przydzielenie, Przypisane, Zaplanowane, W realizacji, Wymaga ponownej wizyty, Wykonane, Zatwierdzone, Anulowane.
  „Po terminie przydziału”, „po terminie realizacji” i „pilne” to **oznaczenia wyliczane z dat**, nie statusy – przekroczenie terminu nie zmienia statusu realizacji.
- **Serwisant** (rola „Serwisant”, ekran „Moje serwisy” na telefonie, uprawnienie `service.own`):
  - widzi wyłącznie zlecenia przypisane do niego; cudze zlecenie zwraca 404 i trafia do rejestru;
  - lista „Do zrobienia” / „Wykonane”, karta z adresem (nawigacja), telefonem klienta, opisem i historią;
  - ustala termin wizyty, rozpoczyna pracę, zgłasza ponowną wizytę (z powodem), dodaje zdjęcia z aparatu (zmniejszane w telefonie do 1600 px) i notatki;
  - kończy zlecenie **protokołem serwisowym**: czynności, użyte części, uwagi, osoba potwierdzająca i **podpis palcem na ekranie** → PDF (numer PS/rok/nr) w dokumentach działu.
- **Powiadomienia** (dzwonek, push, opcjonalnie e-mail): serwisant – przydział, przekazanie, zmiana terminu, anulowanie, pilne, do poprawy, termin realizacji jutro/dziś, po terminie; kierownik i administrator – przypomnienia o terminie przydziału (3 dni i 1 dzień przed, w dniu terminu, po terminie i po kolejnych 7 dniach), ponowna wizyta, zlecenie do zatwierdzenia, po terminie realizacji.
  Przypomnienia sprawdza harmonogram co 5 minut (`SERVICE_REMINDERS_MS`); klucze deduplikacji gwarantują, że to samo przypomnienie nie przyjdzie dwa razy. Ustawienia (dni przydziału, dni przypomnień) w `system_settings` → `service`.
- **Eksport do Excela:** zestawienie serwisów z terminami, informacją „przydział w terminie”, flagami i liczbą zdjęć.
- **Uwaga (hosting):** na darmowym planie Render aplikacja usypia się po ok. 15 min bez ruchu – wtedy przypomnienia czekają do jej wybudzenia. Na płatnym planie działają na bieżąco.
- **Testy:** `test/serwisy.js`, 96 sprawdzeń, w ramach `npm test`.

## Odczyty (dział Podzielniki i Montaże)

Terminy i wykonanie odczytów – bez wartości odczytów (te zostają w programie do odczytów / Excelu). Migracja `db/012_d1_odczyty.sql`, logika `lib/readings.js`, API `routes/odczyty.js`, interfejs `public/odczyty.js`.

- **Gdzie:** zakładka „Odczyty” w dziale oraz moduł „Odczyty” w menu. Rola **„Obsługa odczytów”** widzi tylko ten moduł (obiekty, klienci, terminy, wykonanie) – bez finansów, CRM i innych modułów.
- **Obiekt = budynek z ewidencji** (ta sama tabela co montaże i serwisy), **klient = klient z CRM**. Nowy budynek lub klient dodany z poziomu odczytów trafia do wspólnej ewidencji – dane wprowadza się raz.
- **Na obiekt:** zakres (podzielniki, wodomierze, ciepłomierze, wszystkie, inne – jeden budynek może mieć kilka harmonogramów), sposób odczytu (radiowy, wizualny, zdalny), cykl w miesiącach, kolejny termin, data ostatniego odczytu, osoba odpowiedzialna, własne wyprzedzenie przypomnienia, kontakt na miejscu, dostęp (klucze, kod do bramy), uwagi; w karcie także liczba lokali i zamontowanych urządzeń.
- **„Wykonano” jednym działaniem:** data odczytu (domyślnie dziś), kto wykonał, wynik pełny / częściowy (liczba lokali bez odczytu, uwagi) i **kolejny termin wyliczony z cyklu** (można go zmienić). Wpis trafia do historii obiektu.
- **Cofnięcie pomyłki** (administrator, kierownik): ostatni wpis zostaje w historii jako cofnięty z powodem, a termin wraca do poprzedniego.
- **Przypomnienia:** domyślnie 14 dni przed terminem (ustawienie „Przypomnienia” – administrator/kierownik – albo pole przy obiekcie), w dniu terminu i po terminie (wtedy także do kierownika). Odbiorca: osoba odpowiedzialna, a bez niej – zespół odczytów. Każde przypomnienie przychodzi raz na termin; po wykonaniu i nowym terminie cykl zaczyna się od nowa.
- **Widoki i kafelki:** po terminie, w ciągu 7 i 30 dni, bez osoby odpowiedzialnej, wykonane w tym miesiącu, obiekty aktywne; filtry: osoba, zakres, wyszukiwanie. Na telefonie lista jest w formie kart.
- **Eksport do Excela** (także dla obsługi odczytów): arkusz „Odczyty” (harmonogram z terminami i statusem) i „Historia” (wykonane odczyty, kto, wynik).
- **Testy:** `test/odczyty.js`, 65 sprawdzeń, w ramach `npm test`.

## Harmonogram montaży – ekran startowy działu, import z Excela, wczytanie z umowy

- **Kolejność zakładek działu** (od najważniejszej): Harmonogram montaży (otwiera się domyślnie), Serwisy, Odczyty, Kontrakty i rozliczenia, Ekipy i instalatorzy, Reklamacje, Oferty, Rentowność, Budynki i wspólnoty, Urządzenia.
- **Na górze harmonogramu:** montaże trwające dziś, montaże w 14 dni, bez przydzielonej ekipy, czekające na protokół, serwisy do przydzielenia (z liczbą po terminie) i odczyty po terminie – kafelki serwisów i odczytów przenoszą do zakładek. Agenci AI działu są pod harmonogramem.
- **Dodaj nowy montaż / Edytuj montaż:** przy nowym montażu budynek można wybrać z ewidencji albo dodać od razu w formularzu; przy każdym montażu jest przycisk „Edytuj”.
- **Importuj z Excela** (`routes/importy.js`, `public/montaze-import.js`):
  - szablon do pobrania (arkusz „Montaże” + instrukcja); można też wczytać własny arkusz `.xlsx` albo `.csv` (separator `;` lub `,`, UTF-8 albo Windows-1250) – nagłówki są rozpoznawane po nazwach (np. „Budynek”/„Nazwa budynku”/„Obiekt”, „Termin od”/„Data od”, „Liczba urządzeń”/„Podzielniki”), także gdy nad tabelą jest tytuł;
  - **podgląd przed zapisem:** każdy wiersz ze statusem (do importu / błąd / pominięty), błędy dat i liczb, nieznane ekipy i kontrakty, nowe budynki; **możliwe duplikaty** (ten sam budynek i termin co w harmonogramie) są pomijane – ponowny import tego samego pliku nie zdubluje montaży;
  - zapis w jednej transakcji: nowe budynki trafiają do ewidencji (raz, nawet gdy występują w kilku wierszach), ekipy dostają **jedno zbiorcze powiadomienie**; import w rejestrze operacji.
- **Wczytaj z umowy / harmonogramu** (PDF, skan lub zdjęcie, do 10 MB; `lib/docread.js`):
  - **Claude** (`claude-opus-5-5`, structured outputs ze ścisłym schematem JSON, model zapasowy przy odmowie) odczytuje: zamawiającego (nazwa, NIP, adres), inwestora / spółdzielnię, numer umowy i zadania, terminy, liczbę urządzeń (lokale mieszkalne / użytkowe), stawki z VAT, wartość netto, kary umowne, obowiązki wykonawcy, budynki z adresami; zaznacza, co było nieczytelne;
  - wynik trafia do **formularza do sprawdzenia** (nic nie zapisuje się automatycznie): zamawiający i inwestor dopasowani do ewidencji klientów (po NIP / nazwie), nowy lub istniejący kontrakt z warunkami z dokumentu, lista montaży (budynek z ewidencji albo nowy, terminy, liczba urządzeń, ekipa, zakres) – można dodawać i usuwać pozycje;
  - **zapis w jednej transakcji:** klient, inwestor, kontrakt (KT), budynki, montaże (MZ) w harmonogramie i **dokument źródłowy w kontrakcie** (zdjęcie zapisywane jako PDF; link „Umowa / harmonogram” w zakładce Kontrakty i rozliczenia); ekipy dostają powiadomienie;
  - każde wczytanie jest zapisane (`doc_imports`): plik, dane odczytane przez model, model, tokeny i koszt, a po zatwierdzeniu – co zostało utworzone; w rejestrze operacji `montaz.odczyt_dokumentu` (z kosztem) i `montaz.import_dokumentu`;
  - **włączanie:** odczyt działa, gdy serwer ma `ANTHROPIC_API_KEY` oraz `DOC_AI=live` (w `render.yaml` domyślnie) albo `AI_MODE=live`; agenci mogą zostać w trybie testowym. Bez klucza, przy wyłączniku AI w Security & Audit albo gdy model nie odczyta dokumentu – ten sam formularz do uzupełnienia ręcznie, dokument i tak trafia do kontraktu.
- **Testy:** `test/harmonogram.js`, 52 sprawdzenia (w tym atrapa API Claude: postać zapytania, propozycja, koszt, wyłącznik, odmowa), w ramach `npm test`.

## Strefa GHOST

- **Kafelek GHOST** na ekranie wyboru działu widzą wszyscy (konta bez wyboru działu – monter, serwisant, odczyty – mają GHOST w Menu). Kliknięcie otwiera osobny ekran logowania z logo i animowanym tłem („deszcz znaków” w kolorach logo; przy ustawieniu systemowym „ogranicz ruch” tło jest nieruchome).
- **Konto GHOST** jest powiązane z kontem MXT (`ghost_accounts`). Na start ma je tylko `m.ozga` (migracja `014_ghost.sql`). Przy pierwszym wejściu właściciel ustawia **osobne hasło do GHOST** – inne niż do MXT, z tymi samymi zasadami (10+ znaków, litera i cyfra). Hasła nikt poza nim nie zna.
- **Logowanie:** login konta MXT, na którym jesteś, i hasło GHOST. Odpowiedź nie zdradza, czy konto GHOST istnieje. Limit: 5 nieudanych prób w 15 minut. Odblokowanie trwa 12 godzin i dotyczy tylko bieżącej sesji – wylogowanie z MXT albo „Zablokuj GHOST” je kończy.
- **Rejestr:** `ghost.haslo_ustawione`, `ghost.logowanie` (ok / odmowa), `ghost.wylogowanie`. Zapomniane hasło: wyczyszczenie `password_hash` w `ghost_accounts` przywraca ekran „Ustaw hasło”.
- Zawartość panelu po zalogowaniu – w przygotowaniu. Testy: `node test/ghost.js` (część `npm test`).

## Wdrożenie online

Aplikacja potrzebuje serwera Node.js i bazy PostgreSQL. Do działania online wystarczy jedna z poniższych dróg. Wszystkie korzystają z gotowego `Dockerfile`, który przy starcie wykonuje migracje.

### A. Render (najprostsze, bez własnego serwera)

1. Wgraj folder projektu do repozytorium na GitHubie (bez `node_modules` i `.env`).
2. Na render.com: **New → Blueprint**. Wskaż repozytorium. Render odczyta `render.yaml` i utworzy aplikację oraz bazę PostgreSQL.
3. Po pierwszym wdrożeniu ustaw `APP_URL`, np. `https://mxt.onrender.com`. Opcjonalnie ustaw `ANTHROPIC_API_KEY` i `AI_MODE=live` (agenci na Claude) oraz `SMTP_HOST`, `SMTP_FROM` (poczta).
   **Odczyt umów przez AI** („Wczytaj z umowy / harmonogramu”) – sam klucz wystarczy, agenci zostają w trybie testowym:
   - console.anthropic.com: **Billing** – doładuj środki; **Settings → Limits** – ustaw miesięczny limit wydatków; **Settings → API Keys → Create Key** – skopiuj klucz (pokazuje się raz).
   - Render → usługa **mxt** → **Environment**: `ANTHROPIC_API_KEY` = klucz, sprawdź `DOC_AI` = `live` (dodaj, jeśli brak) → **Save, rebuild, and deploy**.
   - Po wdrożeniu okno „Wczytaj z umowy / harmonogramu” nie pokazuje już „Automatyczny odczyt jest wyłączony”; jeśli pokazuje, administrator widzi w nim, czego brakuje. Koszt każdego odczytu (tokeny i USD) jest w Security & Audit → Rejestr operacji (`montaz.odczyt_dokumentu`).
4. Zaloguj się kontem `m.ozga` z hasłem `1234`. Aplikacja wymusi ustawienie własnego hasła. Każdy pracownik zrobi to samo przy pierwszym logowaniu.

Plan darmowy Render usypia aplikację po okresie bezczynności, a darmowa baza ma ograniczony czas życia. Do pracy firmy wybierz plan płatny albo zewnętrzną bazę (np. Supabase: `DATABASE_URL` + `DATABASE_SSL=1`).

### B. Własny serwer (VPS) z Dockerem

```bash
cp .env.example .env
```

```bash
docker compose up -d --build
```

HTTPS zapewnia Caddy przed aplikacją. Do tego ustaw `COOKIE_SECURE=1` i `TRUST_PROXY=1`.

### C. Supabase + dowolny hosting Node.js

Baza w Supabase (`DATABASE_URL`, `DATABASE_SSL=1`), aplikacja na hostingu obsługującym Dockerfile lub Node.js 22 (`npm ci --omit=dev`, `npm run migrate`, `npm start`).

**Po wdrożeniu:**
- zmień hasła wszystkich kont (wymusi to aplikacja),
- skonfiguruj SMTP,
- włącz dzienny raport w module Automatyzacje,
- ustaw kopie zapasowe bazy, np. `pg_dump` codziennie albo kopie w panelu Supabase lub Render.

## MXT Business OS – etap 4 (automatyzacja, analityka, poczta, karta wyników agentów)

| Moduł | Adres | Kto |
|---|---|---|
| Automatyzacje: dzienny raport zarządu, reguły zdarzenie → działanie, integracje n8n i poczty, stan poczty i kolejki | `/automatyzacje` | administratorzy (uprawnienie `automations.manage`) |
| Communication Hub: skrzynka (e-maile od klientów), wysyłka e-mail, szkice odpowiedzi agentów, rozmowy agentów | `/komunikacja` | wszyscy |
| Business Intelligence: trendy 12 miesięcy i wskaźniki | `/bi` | wszyscy |
| Karta wyników agentów: skuteczność, zatwierdzone operacje, oceny pracowników, koszty | `/karta-wynikow` | wszyscy (podgląd) |

### Dzienny raport Zarządu AI

- **Ustawienia:** administrator ustawia godzinę (np. 07:15), strefę czasową i odbiorców e-mail.
- **Przebieg:** harmonogram (`lib/scheduler.js`) sprawdza co 30 s, czy minęła ustawiona godzina, i raz dziennie zleca raport. Jedno uruchomienie na dzień gwarantuje tabela `scheduled_runs`, także przy kilku instancjach serwera.
- **Treść i wysyłka:** CEO przygotowuje raport z danych firmy i wskaźników BI. Raport trafia do AI Board i e-mailem do odbiorców.
- **„Uruchom teraz”:** generuje raport od razu.
- **Wyłącznik agentów:** blokuje raport (zapis w rejestrze, bez ponawiania).

### Poczta (integracja)

- **Kolejka wysyłki:** każda wiadomość trafia do `mail_outbox` i wysyła ją kolejka zadań w tle (ponawianie 1, 2, 4… min).
- **Konfiguracja SMTP:** zmienne `SMTP_HOST`, `SMTP_PORT`, `SMTP_SECURE`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`.
- **Bez konfiguracji SMTP:** tryb testowy poczty – wiadomość jest zapisana jako „Tryb testowy” i nie wychodzi.
- **Oferty:** po akceptacji administratora i „Wyślij do klienta” oferta wychodzi e-mailem z PDF zatwierdzonej wersji, w języku klienta (PL, DE, EN). Gdy klient nie ma adresu w CRM, w historii klienta pojawia się informacja, że PDF trzeba przekazać ręcznie.
- **Wiadomości od pracowników:** Communication Hub, z opcjonalnym załącznikiem PDF z Knowledge Base. Ofert nie da się wysłać z pominięciem akceptacji.
- **Poczta przychodząca:** `POST /api/integracje/poczta` z tokenem o zakresie „poczta”, np. z n8n (IMAP Trigger → HTTP Request). Wiadomość jest dopasowywana do klienta po adresie (e-mail klienta lub osoby kontaktowej), bez duplikatów po Message-ID. Nieprzypisane wiadomości można przypisać ręcznie.
- **Szkic odpowiedzi agenta:** dobór agenta zależy od rodzaju klienta (Eksport dla klientów zagranicznych, Handlowiec dla wspólnot, Kierownik sprzedaży dla firm). Agent nie ma narzędzi i nie wysyła poczty – wysyła człowiek po przeczytaniu. Treść e-maila trafia do modelu jako dane, nie polecenia.

### Automatyzacje i n8n

- **Reguły:** zdarzenie → działanie: utwórz zadanie (dla pracownika albo agenta AI), wyślij powiadomienie e-mail, wyślij webhook do n8n.
- **Zdarzenia:**
  - reklamacja;
  - oferta do akceptacji, wysłana i przyjęta;
  - decyzja w Approval Center;
  - odebrany montaż;
  - e-mail od klienta;
  - raport dzienny;
  - nowe zadanie.
- **Pola zdarzeń:** do użycia w treści jako `{{numer}}`, `{{tytul}}` itd.
- **Webhooki:** podpisane `X-MXT-Signature: sha256=HMAC(sekret, treść)`. Sekret jest pokazywany raz i przechowywany zaszyfrowany AES-256-GCM (klucz `MXT_SECRET_KEY`). Dozwolony jest https; http i adresy wewnętrzne tylko dla hostów z `N8N_ALLOWED_HOSTS`.
- **Tokeny integracji** (zakresy „poczta”, „zadania”): w bazie wyłącznie skrót SHA-256, z limitem 120 żądań na minutę i unieważnianiem. Odmowy trafiają do rejestru.
- **Zakres działań:** automatyzacje wykonują tylko czynności niewiążące – nie zatwierdzają operacji i nie wysyłają ofert.
- **Kolejka zadań w tle:** PostgreSQL (`jobs`, `FOR UPDATE SKIP LOCKED`), odpowiednik Redis zgodny z obecną architekturą, bez dodatkowej usługi. `WORKERS=0` wyłącza kolejkę i harmonogram na danej instancji.

### Karta wyników agentów

- **Wynik 0–100:** 40% skuteczność uruchomień + 30% odsetek zatwierdzonych operacji poziomu 2 zgłoszonych przez agenta + 30% ocen „Przydatny” od pracowników.
- **Zablokowane uruchomienia** (wyłącznik, limit, wyłączony agent) nie obniżają skuteczności.
- **Gdzie ocenić wynik:** w oknie zadania agenta, w protokole posiedzenia, przy raportach i w „Rozmowach agentów”.

### Monitoring AI (Langfuse – opcjonalnie)

- **Eksport:** po ustawieniu `LANGFUSE_HOST`, `LANGFUSE_PUBLIC_KEY`, `LANGFUSE_SECRET_KEY` każde uruchomienie agenta jest wysyłane kolejką do Langfuse (API ingestion: trace + generation z modelem, tokenami, kosztem, czasem, wersją promptu).
- **Prywatność:** domyślnie bez treści zapytań i odpowiedzi (RODO); `LANGFUSE_INCLUDE_CONTENT=1` je włącza.
- **Testy:** format sprawdzony na atrapie API, nie na prawdziwej instancji Langfuse.

### Uruchomienie etapu 4

```bash
npm install
```

```bash
npm run migrate
```

Migracja `008` dodaje tabele kolejki, harmonogramu, poczty, automatyzacji, tokenów i ocen. Nie zmienia danych.
Zmienne poczty, n8n, Langfuse i `MXT_SECRET_KEY` opisuje `.env.example`.

### Testy etapu 4 (`node test/etap4.js`, część `npm test`)

79 sprawdzeń, na lokalnym serwerze SMTP (prawdziwy protokół) i atrapach n8n i Langfuse:
- RBAC modułu Automatyzacje (403 dla użytkowników);
- harmonogram: raport o ustawionej godzinie, e-mail do odbiorców, jeden na dzień, uruchomienie ręczne, blokada wyłącznikiem;
- oferta e-mailem z PDF zatwierdzonej wersji w języku klienta, klient bez adresu;
- e-mail pracownika i blokada wysyłki oferty z pominięciem akceptacji;
- poczta przychodząca: tokeny i zakresy, skrót w bazie, dopasowanie klienta, Message-ID, przypisywanie, unieważnianie;
- szkic odpowiedzi agenta bez wysyłki i bez tworzenia operacji z treści e-maila;
- reguły: zadanie dla agenta, e-mail, webhook n8n z poprawnym podpisem HMAC, blokada hosta spoza listy;
- zadanie z n8n;
- oceny i karta wyników;
- BI;
- eksport Langfuse (Basic auth, bez treści);
- tryb testowy poczty bez SMTP.

## MXT Business OS – etap 3 (działy, CRM, finanse, Knowledge Base, Platforma Szkoleniowa)

Po kliknięciu kafelka działu otwiera się jego moduł: logo, nazwa działu, przycisk „Powrót do wyboru działu” i zakładki funkcji.

### Podzielniki i Montaże (`/dzial/podzielniki-i-montaze`)

| Zakładka | Co robi |
|---|---|
| Budynki i wspólnoty | Baza budynków powiązanych z wspólnotą lub spółdzielnią z CRM. Karta budynku pokazuje urządzenia, montaże, reklamacje, rozliczenia i marżę. |
| Urządzenia | Numery seryjne (dodawanie listą: jeden numer na linię), typ, model, lokalizacja, status, wyszukiwanie po numerze. Duplikaty numerów są blokowane. |
| Harmonogram montaży | Montaże według dni, ekipa, kontrakt, lista materiałowa. Kolizje terminów ekipy są wykrywane. Montaż wykonany przechodzi do odbioru. |
| Protokół odbioru (PDF) | Generowany z danych montażu (urządzenia z numerami seryjnymi, materiały, odbierający). Zapisuje się jako dokument z wersjami, a montaż przechodzi w stan „odebrany”. |
| Ekipy i instalatorzy | Ewidencja ekip, brygadzistów i instalatorów z uprawnieniami. |
| Reklamacje | Zgłoszenie po numerze seryjnym (automatycznie podpina budynek i klienta, opcjonalnie oznacza urządzenie jako wadliwe), statusy, rozwiązanie. |
| Rozliczenia kontraktów | Wartość kontraktu, zafakturowano, zapłacono, koszty, marża, postęp montaży, faktury i koszty działu. |
| Rentowność | Marża na budynek, zlecenie montażowe i kontrakt (z wpisów Finance Intelligence). |
| Oferty | Oferty Handlowca dla wspólnot (ten sam mechanizm co w dziale 2). |

Agenci działu (Handlowiec, Technik, Rozliczenia) są widoczni na stronie działu. Przycisk „Zleć zadanie” tworzy zadanie przydzielone agentowi.

### Sprzedaż części i eksport (`/dzial/sprzedaz-czesci-i-eksport`) – tylko 4 funkcje

1. **Oferty:**
   - automatyczna kalkulacja z danych klienta (CRM) i pozycji: cena = koszt × (1 + marża) ÷ kurs NBP, albo cena ręczna; rabat;
   - każda zmiana to nowa wersja z PDF;
   - „Wyślij do akceptacji” tworzy operację poziomu 2 przypiętą do tej wersji oferty;
   - po zgodzie administratora „Wyślij do klienta” zwalnia ofertę. Jeśli oferta zmieniła się po zatwierdzeniu, wysyłka jest blokowana;
   - przyjęcie przez klienta tworzy sprzedaż oraz przychód i koszt w finansach.
2. **Kalkulacje wielowalutowe:** przeliczenie między walutami z marżą i kursem na dzień. Kursy z API NBP (tabela A) zapisywane są z datą i numerem tabeli. Brak kursu daje błąd, system nigdy nie zgaduje kursu. Kurs ręczny może wpisać tylko administrator i jest oznaczony jego loginem.
3. **Dokumenty eksportowe i celne:** faktura eksportowa, specyfikacja wysyłkowa (packing list) i dane do zgłoszenia celnego (kody HS są wymagane), z Incoterms 2020. Generowane są jako PDF ze sprzedaży lub oferty i przechowywane w wersjach.
4. **Historia sprzedaży i reklamacji:** transakcje z marżą, powiązane oferty i dokumenty, reklamacje sprzedaży.

Nie ma (zgodnie z założeniami): wyszukiwania po VIN, katalogu OEM i zamienników, porównywania dostawców, bazy Inter Cars, kontroli transportu.

### Ubezpieczenia (`/dzial/ubezpieczenia`) – tylko Platforma Szkoleniowa

- **Kursy:** podzielone na moduły i lekcje (tekst, PDF z podglądem, wideo z YouTube, Vimeo lub pliku https).
- **Testy:** z progiem zaliczenia, ocenianie po stronie serwera. Poprawne odpowiedzi nie trafiają do przeglądarki uczestnika.
- **Postęp:** lekcje i testy. **Zaświadczenie PDF** z numerem jest dostępne po ukończeniu wszystkich lekcji i zaliczeniu testów.
- **Panel administratora (m.ozga, p.krajewski):** kursy, moduły, lekcje, testy, publikacja, postęp wszystkich pracowników. COO z Zarządu AI śledzi ten postęp narzędziem „postęp szkoleń”.

### Moduły wspólne

| Moduł | Adres | Opis |
|---|---|---|
| CRM | `/crm` | Klienci (wspólnoty, spółdzielnie, zarządcy, firmy, klienci zagraniczni), osoby kontaktowe, historia współpracy: budynki, kontrakty, oferty, sprzedaż, reklamacje, kontakty |
| Finance Intelligence | `/finanse` | Przychody, koszty, marże działów 1 i 2, faktury i płatności (nieopłacone, po terminie), wykres 12 miesięcy, prognoza (średnia z 3 pełnych miesięcy) |
| Knowledge Base | `/wiedza` | Dokumenty i procedury z wersjami i PDF. Dokumenty udostępnione agentom publikuje administrator. Oddzielna od platformy szkoleniowej. |

Command Center pokazuje nowe alerty: faktury po terminie, otwarte reklamacje, montaże czekające na protokół, montaże na dziś.

### Agenci działowi – narzędzia (tylko odczyt danych działu + szkice)

| Agent | Narzędzia |
|---|---|
| Handlowiec | budynki, CRM, oferty, szkic oferty, zgłoszenie wysyłki |
| Technik | budynki, urządzenia, harmonogram, ekipy, reklamacje |
| Rozliczenia | kontrakty, rentowność, finanse |
| Kierownik sprzedaży | CRM, oferty, kursy NBP, historia sprzedaży, reklamacje, szkic oferty, zgłoszenie wysyłki |
| Eksport i logistyka | CRM, historia sprzedaży, dokumenty eksportowe, kursy |

Zarząd AI też dostał nowe narzędzia: CFO ma finanse i rentowność, COO harmonogram i postęp szkoleń, CSO klientów i sprzedaż.

Agent nie wyśle oferty: tworzy szkic (poziom 1) i zgłasza wysyłkę, a decyzję podejmuje administrator. Ogólne zgłaszanie „wysłania oferty” bez konkretnej oferty jest zablokowane. Treści z Knowledge Base, opisy reklamacji i korespondencja trafiają do modelu jako dane, nie jako polecenia.

### Pliki i bezpieczeństwo

- **Przechowywanie:** PDF (protokoły, oferty, dokumenty eksportowe, materiały KB i lekcji) w tabeli `document_versions` z sumą SHA-256. Warstwa `lib/docs.js` jest wydzielona pod przeniesienie plików do S3/MinIO.
- **Przesyłanie:** wyłącznie PDF (weryfikacja nagłówka pliku), do 10 MB, przez JSON (ochrona CSRF jak dla reszty API).
- **CSP:** dopuszcza osadzanie wideo tylko z YouTube (`youtube-nocookie.com`) i Vimeo.

### Uruchomienie etapu 3

```bash
npm install
```

```bash
npm run migrate
```

Migracje `006` (działy, CRM, finanse, dokumenty, kursy) i `007` (platforma szkoleniowa) tylko dodają tabele.
Do pobierania kursów serwer potrzebuje dostępu do `api.nbp.pl`. Zmienna `NBP_API_URL` jest tylko do testów.

### Testy etapu 3 (`node test/etap3.js`, część `npm test`)

129 sprawdzeń:
- CRM;
- budynki, urządzenia (duplikaty), ekipy, kolizja terminu, protokół PDF tylko po wykonaniu, reklamacja po numerze seryjnym, rentowność i rozliczenia kontraktu;
- finanse (usuwanie tylko przez admina, brak finansów działu 3);
- kursy NBP (atrapa API w formacie NBP), kalkulacja z marżą, błąd przy braku kursu;
- oferty: kalkulacja, wersje, PDF, wysyłka tylko po akceptacji tej wersji, blokada po zmianie wersji, odrzucenie wraca do szkicu, sprzedaż;
- dokumenty eksportowe (HS, Incoterms);
- Knowledge Base (uprawnienia, wersje, tylko PDF, wyszukiwanie);
- narzędzia agentów działowych;
- platforma szkoleniowa: uprawnienia panelu, publikacja, ukryte odpowiedzi, ocena testu, zaświadczenie PDF po ukończeniu, postęp w panelu.

## MXT Business OS – etap 2 (Zarząd AI, Ustawienia AI, AI Board, AI Workforce)

Warstwa AI działa na modelach **Claude** (oficjalne SDK `@anthropic-ai/sdk`) w dwóch trybach:

| Tryb | Ustawienie | Działanie |
|---|---|---|
| **testowy** (domyślny) | `AI_MODE=test` | Agenci odpowiadają treściami symulowanymi z danych systemu: zadań, wniosków, pamięci. Bez wywołań modelu i bez kosztów. Każda odpowiedź ma oznaczenie „Tryb testowy”. |
| **rzeczywisty** | `AI_MODE=live` + `ANTHROPIC_API_KEY` | Agenci korzystają z Claude. Wywołania są płatne, a ich koszt jest liczony i blokowany po przekroczeniu miesięcznego limitu agenta. |

Domyślny model to `claude-opus-5-5`. W Ustawieniach AI można też wybrać `claude-sonnet-5-5` lub `claude-haiku-5-5`.
Dla Opus i Sonnet włączony jest serwerowy fallback po odmowie (`fallbacks: "default"`).

| Moduł | Adres | Kto |
|---|---|---|
| AI Board: struktura organizacji, posiedzenia, protokoły, raporty zarządu | `/ai-board` | podgląd: wszyscy; zwoływanie i raporty: administratorzy |
| AI Workforce: profile 9 agentów, statusy, historia uruchomień i zadań, koszty, pamięć | `/ai-workforce` | wszyscy |
| Ustawienia AI: zakładki Zarząd AI / Agenci działowi, karta ustawień każdego agenta | `/ustawienia-ai` | administratorzy |

### Agenci

- **Zarząd AI:** CEO, CFO, COO, CSO.
- **Podzielniki i Montaże:** Handlowiec, Technik, Rozliczenia.
- **Sprzedaż części i eksport:** Kierownik sprzedaży, Eksport i logistyka.
- **Ubezpieczenia:** bez agentów.

Stanowiska, przypisane narzędzia i dozwolone operacje są zdefiniowane w kodzie (`lib/ai/catalog.js`).
Domyślne prompty trafiają do bazy przez seed `db/005_seed_agenci.sql`, generowany poleceniem `node scripts/gen-seed-agents.js`.
Przy każdym uruchomieniu agent pobiera z bazy aktualną wersję promptu.

### Ustawienia AI: karta agenta

- **Pola:** nazwa, awatar (skrót i kolor), prompt systemowy, model, poziom wysiłku, temperatura, miesięczny limit kosztów (USD), status oraz podgląd narzędzi i operacji. Zakresu narzędzi nie da się rozszerzyć.
- **Wersje promptu:** każdy zapis nowej treści tworzy wersję z autorem, datą i treścią. Historia pokazuje różnice względem aktualnej wersji i ma przycisk „Przywróć tę wersję”. Jest też przycisk „Przywróć domyślny”.
- **Test promptu:** wysyła wiadomość z roboczym, niezapisanym promptem. Działa bez narzędzi i nie wykonuje operacji.
- **Zapis:** przed zapisem pojawia się potwierdzenie z listą zmian i różnicami w prompcie. Każda zmiana trafia do `audit_logs`.
- **Temperatura:** modele Claude 5.5 nie przyjmują tego parametru. Wartość jest zapisywana, a styl i głębię odpowiedzi kształtują prompt i **poziom wysiłku** (`output_config.effort`).

### AI Board: posiedzenie

1. Administrator podaje temat (i opcjonalnie kontekst).
2. CEO otwiera posiedzenie.
3. CFO, COO i CSO przedstawiają stanowiska. Wyłączony agent jest w protokole oznaczony jako „pominięty”.
4. CEO formułuje rekomendację.
5. Rekomendacja trafia do Approval Center jako operacja poziomu 2 zgłoszona przez agenta CEO.
6. Administrator zatwierdza lub odrzuca ją na stronie posiedzenia albo w Approval Center.

Decyzja zapisuje się w protokole (`board_meetings`, `board_contributions`), w tabeli `decisions` i w pamięci korporacyjnej agentów.
Przycisk „Przygotuj raport” tworzy raport CEO dla administratorów. Dzienny raport automatyczny ustawia się w module Automatyzacje (etap 4).

### Zadania dla agentów

W module Zadania osobą odpowiedzialną może być agent AI. „Uruchom agenta” w oknie zadania zapisuje wynik przy zadaniu i w historii agenta.
Uruchamia autor zadania lub administrator.

### Bezpieczeństwo warstwy AI (w kodzie, nie w promptach)

- **Twarde zasady (`GUARD` w `lib/ai/runner.js`):** system dopisuje je przed promptem stanowiska. Edycja promptu ich nie usuwa, a backend egzekwuje je niezależnie.
- **Narzędzia:** agent używa tylko narzędzi swojego stanowiska (`lib/ai/tools.js`). Operacje może tylko zgłaszać, w zakresie przypisanym stanowisku.
- **Zatwierdzanie:** żadne narzędzie nie zatwierdza operacji ani nie zmienia ustawień.
- **Kontrola przy każdym uruchomieniu:** wyłącznik agentów (423), status agenta (409) i miesięczny limit kosztów (429). Każde uruchomienie, także zablokowane, zapisuje się w `agent_runs` i `audit_logs`.
- **Prompt injection:** dane systemu, pamięć i treści od użytkowników trafiają do modelu w znacznikach `<dane_systemu>`, `<pamiec>`, `<tresc_od_uzytkownika>`. Model ma je traktować jako dane, nie polecenia, a próby zamknięcia znacznika są neutralizowane.
- **Pamięć:** jest rozdzielona na osobistą, działową i korporacyjną (`agent_memory`). Agent widzi swoją pamięć osobistą, pamięć swojego działu i korporacyjną.
- **Wyszukiwanie w pamięci:** pełnotekstowe. Jeśli baza ma rozszerzenie pgvector (Supabase ma), migracja dodaje kolumnę `embedding` na pamięć semantyczną.

### Dodatki z punktu 1 – stan

| Element | Etap 2 |
|---|---|
| Modele AI | **Claude** (zamiast OpenAI, zgodnie z decyzją) |
| Orkiestracja | Przebieg posiedzenia jako stały graf kroków w kodzie (`lib/ai/board.js`). Odpowiednik LangGraph bez dodatkowej zależności. |
| Monitoring AI | `agent_runs` (tokeny, koszt, wersja promptu, czas, narzędzia) + `audit_logs`, podgląd w AI Workforce i karcie wyników. Opcjonalny eksport do Langfuse (etap 4). |
| pgvector | Kolumna dodawana warunkowo. Embeddingi wymagają osobnego dostawcy (Anthropic nie udostępnia API embeddingów). |
| Redis / MinIO / n8n | Etapy 3–4: kolejki dla automatyzacji, pliki dokumentów, integracje |

### Uruchomienie etapu 2

```bash
npm install
```

```bash
npm run migrate
```

Migracje `004` (tabele) i `005` (seed 9 agentów) nie zmieniają istniejących danych. Seed nie nadpisuje promptów zmienionych przez administratorów.
Tryb rzeczywisty: w `.env` ustaw `AI_MODE=live` i `ANTHROPIC_API_KEY=...`, potem zrestartuj aplikację.

### Testy etapu 2 (`node test/etap2.js`, uruchamiane też przez `npm test`)

1. m.ozga1 i k.kretkowska dostają 403 przy bezpośrednim API Ustawień AI (lista, wersje, zapis, test, przywracanie) oraz przy zwoływaniu posiedzeń i raportach. Podgląd AI Board i Workforce działa.
2. Ustawienia AI:
   - 9 agentów (4 + 5) z domyślnymi promptami,
   - walidacja modelu, temperatury i pustego promptu,
   - wersjonowanie, przywracanie wersji i domyślnego,
   - zapis w `audit_logs`.
3. Test promptu odpowiada bez tworzenia operacji i bez kosztów.
4. Posiedzenie:
   - przebieg CEO → CFO/COO/CSO (wyłączony CSO pominięty) → rekomendacja,
   - wniosek poziomu 2 od agenta CEO,
   - użytkownik nie zatwierdza,
   - decyzja administratora zamyka posiedzenie i trafia do `decisions` i pamięci.
5. Zadanie dla agenta: uruchomienie, wynik, historia; cudze zadanie daje 403.
6. Twarde reguły: narzędzie spoza stanowiska i operacja spoza zakresu są blokowane; oferta od agenta czeka na administratora.
7. Limit kosztów (429) i wyłącznik (423) blokują agentów.
8. Tryb rzeczywisty na lokalnej atrapie API Anthropic:
   - model `claude-opus-5-5`, `effort`, bez `temperature`, fallback po odmowie,
   - zasady systemu przed promptem, odgrodzona treść użytkownika,
   - tylko narzędzia stanowiska, pętla narzędzi,
   - odrzucenie niedozwolonej operacji, poprawne wyliczenie kosztu.

## MXT Business OS – etap 1 (role, Command Center, zadania, Approval Center, Security & Audit)

Etap 1 rozbudowy jest wpięty w istniejącą aplikację. Logowanie, powitanie i wybór działu działają bez zmian.
Na ekranie wyboru działu jest nowy przycisk **Command Center**, a w pasku użytkownika jest **Menu** z modułami.
Pozycje tylko dla administratorów mają oznaczenie „admin”.

| Moduł | Adres | Kto |
|---|---|---|
| Command Center: KPI, alerty, moje zadania, oczekujące decyzje, mapa modułów | `/command-center` | wszyscy |
| Zadania: zlecanie, przypisywanie, statusy, terminy, filtry | `/zadania` | wszyscy |
| Moje wnioski: zgłoszenia operacji do akceptacji, wykonanie po zgodzie | `/wnioski` | wszyscy |
| Approval Center: decyzje, historia, reguły poziomu 3, poziomy uprawnień | `/akceptacje` | administratorzy |
| Security & Audit: rejestr operacji, wyłącznik wszystkich agentów, macierz uprawnień | `/bezpieczenstwo` | administratorzy |
| Ustawienia AI: już chronione uprawnieniem, konfiguracja agentów w etapie 2 | `/ustawienia-ai` | administratorzy |

### Role

| Konto | Rola |
|---|---|
| m.ozga, p.krajewski | administrator |
| m.ozga1, k.kretkowska | użytkownik |

Uprawnienia są zdefiniowane w `lib/rbac.js` i sprawdzane przez serwer przy każdym żądaniu.
Ukrycie przycisku w interfejsie to tylko wygoda. Żądanie bez uprawnienia zwraca **403** i zostaje zapisane w `audit_logs` jako „Odmowa dostępu”.

### Approval Center: reguły egzekwowane w kodzie (`lib/operations.js`)

- **Poziomy:** 0 (analiza) i 1 (przygotowanie dokumentów) wykonują się od razu. Poziom 2 czeka na administratora. Poziom 3 to automat w granicach reguły ustanowionej wcześniej przez administratora: tylko operacje odwracalne, z limitem kwoty i liczby dziennie, z datą ważności.
- **Kto decyduje:** zatwierdza lub odrzuca wyłącznie administrator-człowiek. Agent AI nie może zatwierdzić żadnej operacji, nawet z rolą „administrator”.
- **Wersja i skrót:** każda zmiana treści wniosku tworzy nową wersję. Decyzja dotyczy konkretnej wersji i skrótu SHA-256 treści. Wykonanie jest blokowane, jeśli treść różni się od zatwierdzonej, także po ręcznej zmianie w bazie.
- **Historia:** każde zgłoszenie, zmiana, decyzja, wykonanie i wycofanie trafia do `approval_events` (kto, kiedy, wersja, skrót) oraz do `audit_logs`.
- **Wyłącznik agentów:** wyłącznik w Security & Audit blokuje po stronie serwera każdą operację zgłaszaną lub wykonywaną przez agentów.
- **Skutki operacji:** wysyłka oferty ma skutek w module Oferty (od etapu 3: wersja + PDF, od etapu 4: e-mail do klienta). Wydatek, zmiana ceny, rabat i umowa są rejestrem decyzji bez automatycznego skutku.

### Uruchomienie etapu 1 na istniejącej instalacji

```bash
npm run migrate
```

Migracja `db/003_etap1_rbac_zadania_akceptacje_audyt.sql` dodaje kolumnę `users.role`, przypisuje role 4 kontom i tworzy nowe tabele.
Nie usuwa i nie zmienia istniejących danych. Można ją uruchamiać wielokrotnie.
W Supabase możesz zamiast tego wkleić plik w SQL Editorze.
W Dockerze migracja uruchamia się sama przy starcie kontenera.

### Lista testów (`npm test`)

Test uruchamiaj na bazie testowej: zapisuje wpisy w `audit_logs`, a dane robocze z prefiksem `[TEST]` usuwa na końcu.

1. Błędne hasło i nieznany login zwracają „Nieprawidłowy login lub hasło”.
2. Logowanie każdym z 4 kont zwraca właściwą rolę.
3. m.ozga1 i k.kretkowska dostają 403 przy bezpośrednim wywołaniu API Ustawień AI, Approval Center (lista, decyzje, reguły) oraz Security & Audit (rejestr, wyłącznik). Każda odmowa jest zapisana w `audit_logs`.
4. m.ozga i p.krajewski mają dostęp do tych modułów.
5. Zadania: tworzy je każdy, zmienia autor lub osoba przypisana, usuwa autor lub administrator. W pozostałych przypadkach 403.
6. Approval Center:
   - użytkownik nie zatwierdza (403),
   - bez zgody nie da się wykonać operacji (409),
   - decyzja na nieaktualnej wersji jest zablokowana (409),
   - ręczna zmiana treści w bazie blokuje wykonanie (409),
   - historia zapisuje kolejno: zgłoszenie → zmiana → zatwierdzenie → wykonanie.
7. Poziom 3:
   - brak reguły dla operacji nieodwracalnych,
   - auto-zatwierdzenie w limicie,
   - ręczna decyzja po przekroczeniu limitu dziennego lub kwoty.
8. Agent AI (wywołanie modułu polityk):
   - nie zatwierdza nawet z rolą administratora,
   - poziom 1 wykonuje samodzielnie,
   - poziom 2 czeka na administratora,
   - przy włączonym wyłączniku jest blokowany (423).
9. Wylogowanie unieważnia sesję.

Do ręcznego sprawdzenia w przeglądarce:
- zaloguj się jako m.ozga1 i sprawdź, że w Menu nie ma Approval Center, Security & Audit ani Ustawień AI,
- wejdź bezpośrednio na `/akceptacje`: zobaczysz ekran „Brak dostępu”.

## Struktura

```
server.js                 serwer: logowanie (/api/login, /api/me, /api/logout), /api/health, podpięcie modułów
routes/api.js             API modułów MXT Business OS (zadania, akceptacje, Command Center, audyt)
lib/rbac.js               role i uprawnienia (jedno źródło prawdy dla backendu)
lib/operations.js         Approval Center: poziomy, wersje, skróty, twarde reguły dla agentów
lib/audit.js              zapis do audit_logs
lib/password.js           polityka haseł (zmiana hasła przy pierwszym logowaniu)
render.yaml               wdrożenie na Render (Blueprint: aplikacja + PostgreSQL)
lib/ai/                   agenci AI: catalog (stanowiska, prompty), runner, provider (test/Claude), tools, board, mock
routes/ai.js              API: Ustawienia AI, AI Board, AI Workforce, zadania agentów
routes/dzial1.js          API działu Podzielniki i Montaże
routes/konta.js           API kont pracowników (zakładanie, role, instalator, wyłączanie, reset hasła)
routes/powiadomienia.js   API powiadomień zalogowanego pracownika (lista, licznik, push, kopia e-mail)
routes/teren.js           API „Moje montaże” (monter: tylko montaże własnej ekipy)
routes/eksport.js         eksport zestawień działu 1 do Excela (XLSX)
routes/serwisy.js         API zleceń serwisowych: biuro (/api/serwisy) i serwisant (/api/moje/serwisy)
lib/service.js            zlecenia serwisowe: statusy, terminy, flagi, przypomnienia, zdjęcia, protokół z podpisem
routes/odczyty.js         API odczytów (obiekty, terminy, wykonanie, cofnięcie, ustawienia, eksport)
routes/importy.js         import montaży z Excela (szablon, podgląd, zapis) i wczytanie z umowy / harmonogramu
lib/docread.js            odczyt dokumentów przez Claude (PDF, skan, zdjęcie → dane do formularza), zdjęcie → PDF
lib/readings.js           odczyty: zakresy, flagi terminów, przypomnienia z wyprzedzeniem
lib/notify.js, lib/scope.js, lib/xlsx.js   powiadomienia (w aplikacji, push, e-mail), zasięg danych montera, budowa plików XLSX
routes/biznes.js          API: CRM, finanse, kursy NBP, oferty, sprzedaż, reklamacje, dokumenty eksportowe, Knowledge Base
routes/szkolenia.js       API Platformy Szkoleniowej
routes/automatyzacje.js   API: dzienny raport, reguły, tokeny, poczta, kolejka (administratorzy)
routes/komunikacja.js     API Communication Hub
routes/integracje.js      wejście integracji (n8n, skrzynka) – tokeny Bearer
lib/jobs.js, lib/scheduler.js, lib/mail.js, lib/events.js, lib/bi.js, lib/monitoring.js, lib/secrets.js   kolejka, harmonogram, poczta, zdarzenia, BI, Langfuse, szyfrowanie sekretów
lib/offers.js, lib/nbp.js, lib/pdf.js, lib/docs.js   oferty, kursy NBP, PDF, dokumenty z wersjami
assets/fonts/             czcionki DejaVu (polskie znaki w PDF, wolna licencja)
db.js                     połączenie z PostgreSQL
db/001_schema.sql         tabele users i sessions
db/002_seed_users.sql     4 konta startowe (hasło 1234, zapisane jako hash bcrypt)
db/003_etap1_…sql         etap 1: role, działy, zadania, akceptacje, reguły poziomu 3, audyt, wyłącznik agentów
db/004_etap2_…sql         etap 2: agenci, ustawienia, wersje promptów, uruchomienia, pamięć, posiedzenia, decyzje, raporty
db/005_seed_agenci.sql    seed 9 agentów i domyślnych promptów (generowany: scripts/gen-seed-agents.js)
db/006_etap3_…sql         etap 3: CRM, dokumenty, finanse, kursy walut, działy 1 i 2, reklamacje
db/007_etap3_…sql         etap 3: platforma szkoleniowa
db/008_etap4_…sql         etap 4: kolejka, harmonogram, poczta, automatyzacje, tokeny, oceny agentów
scripts/migrate.js        wykonuje pliki db/*.sql po kolei (npm run migrate)
scripts/hash.js           tworzy hash bcrypt dla dowolnego hasła (npm run hash -- "hasło")
public/                   aplikacja: index.html, app.css, app.js, modules.js, biznes.js, dzial1.js, dzial2.js, szkolenia.js, etap4.js, konta.js (konta, powiadomienia), teren.js (Moje montaże), serwisy.js (serwisy: biuro i serwisant), odczyty.js (odczyty), montaze-import.js (import z Excela, wczytanie z umowy), logo, ikony, manifest PWA, service worker (cache + push)
public/logo.png           logo MXT (Ubezpieczenia + Ciepłomierze i podzielniki) – logowanie, powitanie, nagłówki modułów
public/logos/             logo działów: podzielniki.png (Podzielniki i Montaże), express-parts.png (Sprzedaż części i eksport),
                          ubezpieczenia.png (Ubezpieczenia) – kafelki wyboru działu, nagłówek strony działu i dokumenty PDF działu
public/app.css (:root)    kolory z logo: czerń (przyciski główne, aktywne zakładki), czerwień MXT #da141e (akcenty, linki),
                          złoto MXT Ubezpieczenia (oznaczenia administratora, tryb testowy); ikony PWA w public/icons
test/haslo.js             testy wymuszonej zmiany hasła i resetu
test/smoke.js             testy logowania, ról i etapu 1 (npm test)
test/etap2.js             testy etapu 2, w tym tryb rzeczywisty na atrapie API Anthropic
test/etap3.js             testy etapu 3 (działy, CRM, finanse, KB, szkolenia; atrapa API NBP)
test/etap4.js             testy etapu 4 (lokalny SMTP, atrapy n8n i Langfuse)
test/fundament.js         testy rozbudowy działu 1, etap 1 (konta, zasięg montera, powiadomienia, push, anulowanie finansów, eksport XLSX)
test/serwisy.js           testy zleceń serwisowych (termin 14 dni, przydział, zasięg serwisanta, zdjęcia, protokół z podpisem, przypomnienia)
test/odczyty.js           testy odczytów (rola obsługi odczytów, wykonanie z kolejnym terminem, cofnięcie, przypomnienia, eksport)
test/harmonogram.js       testy harmonogramu: import z Excela, wczytanie z umowy (tryb ręczny i atrapa API Claude)
```

## Konta startowe

| Login | Hasło początkowe |
|---|---|
| m.ozga | 1234 |
| p.krajewski | 1234 |
| m.ozga1 | 1234 |
| k.kretkowska | 1234 |

Każde konto ma `must_change_password = true`. Pole jest przygotowane pod wymuszenie zmiany hasła w kolejnym etapie i na razie nic nie blokuje.
Hasło `1234` jest bardzo słabe, więc zmień je przed udostępnieniem aplikacji w internecie.

## Uruchomienie

Wymagany Node.js 22.9 lub nowszy.

### Wariant A: Docker (aplikacja + baza w jednym)

```bash
docker compose up -d --build
```

Aplikacja: http://localhost:3000. Tabele i konta tworzą się same przy starcie kontenera.

### Wariant B: Supabase (baza w chmurze)

1. Załóż projekt na supabase.com.
2. Utwórz tabele i konta. Możesz to zrobić na dwa sposoby:
   - w panelu Supabase otwórz **SQL Editor**, wklej i uruchom kolejno `db/001_schema.sql` i `db/002_seed_users.sql`;
   - albo wykonaj `npm run migrate` z punktu 4 poniżej.
3. Skopiuj adres bazy: **Project Settings → Database → Connection string → URI**. Wstaw hasło bazy w miejsce `[YOUR-PASSWORD]`.
4. W folderze projektu:

```bash
cp .env.example .env
```

W pliku `.env` ustaw `DATABASE_URL=<adres z punktu 3>` oraz `DATABASE_SSL=1`.

```bash
npm ci
```

```bash
npm run migrate
```

```bash
npm start
```

Tabele mają włączone RLS bez polityk, więc publiczne API Supabase (klucz `anon`) nie ma do nich dostępu. Dane czyta i zapisuje wyłącznie serwer aplikacji.

### Wariant C: własny PostgreSQL

Utwórz bazę, wpisz jej adres do `DATABASE_URL` w `.env` (z `DATABASE_SSL=0` dla lokalnej bazy), a potem uruchom `npm ci`, `npm run migrate` i `npm start` jak w wariancie B.

## Produkcja i instalacja jako aplikacja (PWA)

- PWA i zapamiętywanie hasła w telefonie wymagają **HTTPS**. Postaw aplikację za reverse proxy z certyfikatem (np. Caddy) albo na hostingu z HTTPS (Render, Railway, Fly.io).
- Za HTTPS ustaw w `.env`: `COOKIE_SECURE=1`. Jeśli przed aplikacją stoi proxy, ustaw też `TRUST_PROXY=1`.
- Instalacja: w Chrome lub Edge użyj „Zainstaluj aplikację”. Na iPhonie w Safari wybierz Udostępnij → „Do ekranu początkowego”.

## Zmiana hasła (do czasu ekranu zmiany hasła)

```bash
npm run hash -- "NoweHaslo123"
```

Wynik wstaw w SQL Editorze lub w `psql`:

```sql
UPDATE users SET password_hash = '<hash>', must_change_password = false WHERE login = 'm.ozga';
```

## Test

```bash
npm test
```

Test wymaga `DATABASE_URL` i wykonanej migracji. Sprawdza błędne logowanie, logowanie na każde z 4 kont, zapamiętaną sesję i wylogowanie.
