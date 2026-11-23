# MXT ERP – audyt aplikacji i plan rozbudowy

Gałąź robocza: `erp` (produkcja na Render wdraża się z `main` – zmiany trafią na produkcję dopiero po akceptacji i scaleniu).
Data audytu: 23.11.2026.

## 1. Obecna architektura

| Warstwa | Stan |
|---|---|
| Backend | Node.js 22, Express 5, jeden proces (`server.js`), moduły tras w `routes/`, logika w `lib/` |
| Baza | PostgreSQL, 55 tabel, migracje `db/001…015_*.sql` (idempotentne, uruchamiane przy każdym starcie) |
| Frontend | PWA bez frameworka: `public/*.js` (moduły rejestrowane w `modules.js`), jeden arkusz `app.css`, service worker, Web Push |
| Uwierzytelnianie | bcrypt (12), sesje w bazie (cookie httpOnly, SameSite=strict), limit prób logowania, wymuszona zmiana hasła startowego |
| Uprawnienia | `lib/rbac.js`: role → uprawnienia, sprawdzane w backendzie (`requirePerm`), odmowy w `audit_logs` |
| Bezpieczeństwo | CSP bez inline, ochrona CSRF (zapisy tylko JSON), rejestr operacji, RLS włączony na tabelach |
| Zadania w tle | kolejka na PostgreSQL (`lib/jobs.js`, FOR UPDATE SKIP LOCKED, ponawianie), harmonogram (`lib/scheduler.js`: raport dzienny, przypomnienia serwisów i odczytów co 5 min, deduplikacja kluczem) |
| Dokumenty | `documents` + `document_versions` (PDF z wersjami), generator PDF (`lib/pdf.js`, pdfkit) |
| Integracje | NBP (kursy), poczta SMTP (kolejka `mail_outbox`), n8n (tokeny), Claude (agenci AI, odczyt umów), webhook bota telefonicznego |
| Testy | 11 plików testów API (`npm test`, 879 sprawdzeń), testy interfejsu tylko lokalnie (poza repozytorium) |
| Hosting | Render (web + PostgreSQL), auto-deploy z `main` |

## 2. Istniejące funkcjonalności (sprawdzone w kodzie i testach)

- **Wspólne:** konta i role (7 ról + role dodatkowe), powiadomienia (dzwonek, push, e-mail), zadania, Approval Center (poziomy 0–3), Security & Audit, CRM (klienci, historia kontaktów), Finance Intelligence (przychody/koszty, waluty NBP, anulowanie z powodem), Knowledge Base, Communication Hub, BI, automatyzacje (n8n, poczta, raport dzienny), agenci AI i AI Board, eksport XLSX.
- **Podzielniki i Montaże:** harmonogram montaży (lista/tydzień/miesiąc, kolizje ekip), import z Excela, wczytanie montażu z umowy (AI), protokół odbioru PDF, zlecenia serwisowe (kontrola 14 dni na przydział, przypomnienia, zdjęcia, podpis, protokół PDF, aplikacja serwisanta), odczyty (harmonogram per budynek, przypomnienia, rola „Obsługa odczytów”), kontrakty (projekty) z rozliczeniem, oferty, rentowność, ekipy i instalatorzy, budynki, urządzenia (numery seryjne), reklamacje, „Moje montaże” dla montera.
- **Sprzedaż części i eksport:** oferty wielowalutowe z akceptacją, kalkulacje z kursami NBP, dokumenty eksportowe (faktura, packing list, dane celne), historia sprzedaży i reklamacji.
- **Ubezpieczenia:** obecnie platforma szkoleniowa (kursy, lekcje, testy, zaświadczenia) – **niezgodne z nowym zakresem działu**.
- **Asystent telefoniczny:** webhook bota, rozmowy z transkrypcją, zgłoszenia, wizyta z telefonu → zlecenie serwisowe; bot „Ola” (Python, osobna usługa, jeszcze nieuruchomiona).
- **GHOST:** strefa z osobnym hasłem (bez treści).

## 3. Najważniejsze problemy

**Techniczne**
1. Brak magazynu – materiały montażu zapisane tekstowo (JSON w `installations.materials`), bez stanów, cen, przyjęć i wydań.
2. Trzy rodzaje zleceń w osobnych tabelach (montaże, serwisy, odczyty) bez wspólnego widoku, wspólnych terminów i rozliczeń; serwis nie łączy się z projektem i nie ma materiałów ani kosztów.
3. Odczyty tylko na poziomie budynku (pełny/częściowy) – brak wartości per urządzenie, kontroli kompletności i poprawności.
4. Urządzenia bez producenta, lokalu i historii (serwisy, odczyty); brak lokali jako kartoteki.
5. Projekty (kontrakty) bez budżetu, zespołu, historii i protokołu miesięcznego.
6. Pracownicy = konta logowania, bez kartoteki (stanowisko, stawka), czasu pracy, dostępności i obciążenia.
7. Finanse: należności/zobowiązania tylko pośrednio (termin, data zapłaty), brak raportów należności, przepływów, budżetów i eksportu dla księgowości.
8. Klienci: brak typu „osoba prywatna”, wyszukiwanie tylko w CRM, karta klienta nie pokazuje serwisów, odczytów, polis.
9. Brak globalnego wyszukiwania i zapisanych widoków list.
10. Testy interfejsu poza repozytorium.
11. Kopie zapasowe zależne wyłącznie od planu Render (darmowa baza Render wygasa – planowane przejście na płatny plan w grudniu).

**Biznesowe**
1. Dział Ubezpieczenia nie ma rejestru polis, przypomnień o końcu ochrony ani wyliczania zysku.
2. Sprzedaż części bez kartoteki produktów, stanów, zamówień, zwrotów i należności.
3. Brak dashboardu właściciela z wynikiem finansowym działów.
4. Brak ról: właściciel, magazynier, księgowość, użytkownik ograniczony.
5. W asystencie telefonicznym zostawiona opcja „taxi” (wyłączona) – do usunięcia z interfejsu i bota.
6. Teksty „w kolejnych etapach” w gotowych modułach.

## 4. Brakujące moduły ERP

Magazyn i zakupy (wiele magazynów, PZ/WZ/MM/RW, rezerwacje, inwentaryzacja, minima, dostawcy, zamówienia zakupu) · kartoteka produktów i sprzedaż części (zamówienia, sprzedaż, zwroty, należności, analityka) · rejestr polis · pracownicy i czas pracy · wspólny rejestr zleceń · lokale · historia urządzeń i odczyty per urządzenie · budżety projektów i protokoły miesięczne · należności, zobowiązania, przepływy, eksport dla księgowości · dashboard właściciela · globalne wyszukiwanie · zapisane widoki.

## 5. Architektura docelowa

Bez zmiany technologii (Node/Express/PostgreSQL/PWA). Rozbudowa istniejącego kodu:

- **Logika biznesowa** w `lib/erp/*` (polisy, magazyn, zlecenia, finanse), trasy w `routes/erp/*` – bez obliczeń w interfejsie (interfejs tylko podgląd, wynik liczy i zapisuje backend).
- **Migracje** `db/016+`, wyłącznie dodające (nowe tabele, kolumny, rozszerzenia CHECK) – bez usuwania danych.
- **Wspólny rdzeń:** klienci (jedna kartoteka dla wszystkich działów), budynki → lokale → urządzenia, pracownicy (konta + kartoteka), dokumenty (`documents`), powiadomienia (`notifications` + kolejka), rejestr operacji (`audit_logs`).
- **Zlecenia:** pozostają w tabelach procesowych (montaż, serwis, odczyt – różne przebiegi), wspólny widok `work_orders` (typ, numer, klient, budynek, status, termin, osoba, projekt, rozliczenie).
- **Magazyn:** kartoteka pozycji (materiały i części), stany per magazyn, dokumenty ruchu w transakcjach z blokadą wiersza stanu (bez ujemnych stanów przy równoczesnych operacjach), średni ważony koszt; wydanie na zlecenie/projekt tworzy koszt w finansach.
- **Finanse:** jedna księga przychodów i kosztów z przypisaniem do działu i projektu/zlecenia; ubezpieczenia tylko jako zysk z polis, osobno od wartości polis (wartość polisy nigdy nie jest przychodem MXT).
- **Harmonogram:** zadania cykliczne w strefie Europe/Warsaw, jedno wykonanie dziennie (`scheduled_runs`), nadrabianie po przerwie, deduplikacja.
- **Integracje oczekujące na dane** (KSeF, księgowość, SMS, kalendarze, mapy, urządzenia pomiarowe): konfiguracja i status „oczekuje na dane dostępowe”, bez atrap.

## 6. Plan rozbudowy (priorytety)

| Etap | Zakres | Priorytet |
|---|---|---|
| 1 | Audyt (ten dokument) | – |
| 2 | Architektura i model danych (sekcja 5, migracje w kolejnych etapach) | – |
| 3 | Fundamenty: role (właściciel, magazynier, księgowość, ograniczony), klienci (osoba prywatna, karta 360°, wyszukiwanie), globalne wyszukiwanie, zapisane widoki, usunięcie taxi, porządek tekstów | wysoki |
| 4 | Ciepłomierze i podzielniki: wspólny rejestr zleceń, serwis ↔ projekt, statusy rozliczone/zamknięte, lokale, kartoteka i historia urządzeń, odczyty per urządzenie z kontrolą poprawności, budżet i zespół projektu, protokół miesięczny, dashboard działu | najwyższy |
| 5 | Magazyn i zakupy, materiały na zlecenia, finanse: należności, zobowiązania, przepływy, raporty działów, eksport dla księgowości | wysoki |
| 6 | Ubezpieczenia: rejestr polis, zysk z marży, historia zmian, przypomnienia 30 dni, polisy do odnowienia, dashboard | wysoki |
| 7 | Sprzedaż części: produkty, zamówienia, sprzedaż, zwroty, reklamacje, należności, analityka | średni |
| 8 | Dashboard właściciela, raporty, alerty, automatyzacje | średni |
| 9 | Testy przepływów, poprawki, przygotowanie wdrożenia (kopie zapasowe, scalenie z `main` po akceptacji) | wysoki |

## 7. Założenia biznesowe przyjęte bez pytania

- Platforma szkoleniowa nie jest usuwana – przenoszę ją z działu Ubezpieczenia do wspólnego modułu „Szkolenia” (menu), dział Ubezpieczenia staje się rejestrem polis.
- Przypomnienie o polisie: dzień = data końca ochrony − 30 dni (Europe/Warsaw). Gdy serwer nie działał w tym dniu albo polisę dodano później, przypomnienie powstaje przy pierwszym sprawdzeniu, jeśli ochrona jeszcze trwa (jedno na polisę i datę końca).
- Status polisy liczony z dat: aktywna → zbliża się koniec (≤ 30 dni) → zakończona (po dacie końca); „odnowiona” tylko po potwierdzeniu użytkownika.
- Statusy serwisu: istniejące + „rozliczone” i „zamknięte” na końcu procesu; etykiety statusów edytowalne przez administratora.
- Koszt materiału wydanego z magazynu = średni ważony koszt zakupu w chwili wydania.
- Zysk z polisy trafia do wyniku działu Ubezpieczenia; wartość polisy pokazywana osobno i nigdy nie sumowana z przychodami.

## 8. Status realizacji

Aktualizowany po każdym etapie (sekcja poniżej).

### Etap 3 – fundamenty (zrobione)

- Role: właściciel, magazynier, księgowość, dostęp ograniczony (+ 10 nowych uprawnień: dashboard właściciela, finanse, magazyn, zakupy, polisy, sprzedaż części, pracownicy, czas pracy, wyszukiwanie). Kontrola w backendzie (`lib/rbac.js`), ograniczenie ról również w bazie (CHECK).
- Klienci: rodzaj „osoba prywatna”, wyszukiwanie po nazwie, NIP, adresie, e-mailu, telefonie (same cyfry) i identyfikatorze; karta klienta 360° (zlecenia serwisowe, montaże, odczyty, dokumenty; kolejne moduły dopisują sekcje przez `lib/customer360.js`).
- Globalne wyszukiwanie (`lib/search.js`, `GET /api/szukaj`, Ctrl+K i lupa w pasku) – wyniki tylko z modułów dostępnych dla konta; linki otwierają kartę rekordu.
- Zapisane widoki list (`user_views`, `/api/widoki`) – pierwsze użycie: harmonogram montaży.
- Asystent telefoniczny i bot bez działalności taxi (starsza wartość od bota → „inne”, dane historyczne bez zmian).
- Nazwy działów: „Ciepłomierze i podzielniki”, „Sprzedaż części samochodowych” (adresy i identyfikatory bez zmian).
- Migracja `db/016_erp_fundamenty.sql` (tylko dodaje). Testy: `test/erp-fundamenty.js` (51 sprawdzeń), cały zestaw 930 sprawdzeń OK, bot 35 testów OK.

### Etap 4 – Ciepłomierze i podzielniki + rdzeń magazynu (zrobione)

- **Wspólny rejestr zleceń** (widok `work_orders`): montaże, serwisy i odczyty z jednymi statusami (nowe → do przydzielenia → przydzielone/zaplanowane → w realizacji → wykonane → rozliczone → zamknięte), terminami, osobą/ekipą, projektem i rozliczeniem; filtry (typ, status, termin, rozliczenie, szukaj) i zapisane widoki. Zakładka „Wszystkie zlecenia”.
- **Rozliczanie po zleceniu**: przychód w finansach z fakturą, terminem płatności, klientem, projektem i zleceniem; serwis przechodzi w „rozliczone”, potem „zamknięte”. Rozlicza rola finansowa (właściciel, księgowość, rozliczający, kierownik).
- **Projekty**: kierownik, sposób rozliczania (po zleceniu / miesięcznie / ryczałt), budżet przychodów i kosztów w kategoriach, zespół (z powiadomieniem), zlecenia projektu, materiały, czas pracy, faktury, dokumenty, historia; **protokół miesięczny PDF** (montaże, serwisy, odczyty, materiały z miesiąca) zapisany przy projekcie.
- **Koszty bez podwójnego liczenia** (widok `cost_ledger`): koszty z finansów + materiały wydane na zlecenia (RW − ZW, po średnim koszcie) + robocizna (godziny × stawka z dnia wpisu). Zakup na magazyn (PZ) nie jest kosztem.
- **Magazyn** (moduł w menu): wiele magazynów (np. samochód serwisowy), pozycje (materiały, części: zamienniki, ceny, marża, minimum, dostawca), dokumenty PZ/WZ/RW/ZW/MM/INW w transakcjach z blokadą stanu (równoczesne wydania nie zejdą poniżej zera – sprawdzone testem; dodatkowo CHECK w bazie), rezerwacje, alert „poniżej minimum”, dostawcy.
- **Lokale** w budynkach (seria 1–N), **kartoteka urządzenia** (producent, lokal, ID radiowe, legalizacja) z pełną historią: montaż, zdarzenia, zmiany statusu z powodem, serwisy, odczyty, dokumenty.
- **Odczyty per urządzenie**: wpis na komputerze i telefonie, braki z powodem, kontrola kompletności, wykrywanie podejrzanych (spadek licznika, podzielnik > 5× mediany budynku), import z czytnika (numer seryjny lub ID radiowe; przygotowanie pod integrację z urządzeniami), protokół odczytów PDF.
- **Pracownicy** (moduł w menu, kierownik): kartoteka kadrowa i stawka, obciążenie (serwisy, montaże, odczyty, godziny), nieobecności; **Mój czas pracy** dla wszystkich ról z ewidencją.
- **Pulpit działu**: aktywne projekty, otwarte serwisy, odczyty w miesiącu, po terminie, zagrożone, bez przydziału, do rozliczenia, finanse miesiąca (przychód, koszty z materiałami i robocizną, wynik), wykonanie planu miesięcznego, obciążenie, rentowność projektów – wyłącznie z danych systemu.
- Migracje `db/017_erp_operacje.sql`, `db/018_erp_magazyn.sql` (tylko dodają). Testy: `test/erp-operacje.js` (112 sprawdzeń); cały zestaw zielony; przegląd interfejsu (komputer, telefon) bez błędów.

### Etap 6 – Ubezpieczenia: rejestr podpisanych polis (zrobione)

- Dział Ubezpieczenia = rejestr polis (bez ofert, kalkulatorów, integracji z towarzystwami). Platforma szkoleniowa przeniesiona bez zmian do modułu **Szkolenia** (menu).
- **Polisa**: klient z wspólnej kartoteki CRM (wyszukiwanie po nazwisku, firmie, telefonie, e-mailu albo nowy klient w formularzu), numer, towarzystwo, rodzaj, opis, daty podpisania i ochrony, kwota całkowita, procent marży, uwagi, dokument (PDF/JPG/PNG, z wersjami).
- **Zysk = kwota × marża / 100**: podgląd na bieżąco w formularzu, walidacja i przeliczenie w backendzie (arytmetyka całkowita), zapis w bazie jako kolumna wyliczana `round(kwota × marża / 100, 2)` – nie da się go rozjechać z kwotą i marżą ani nadpisać.
- **Statusy** liczone z dat (zawsze aktualne): aktywna → zbliża się koniec (≤ 30 dni) → zakończona; „odnowiona” tylko po potwierdzeniu użytkownika (odnowienie z karty polisy albo powiązanie z istniejącą polisą tego samego klienta).
- **Historia zmian**: każda zmiana pola z wartością przed i po (z przeliczonym zyskiem), odnowienia, zakończenia, dokumenty, przypomnienia.
- **Przypomnienia 30 dni przed końcem ochrony**: harmonogram w tle (Europe/Warsaw, także bez zalogowanych), jedno na polisę i datę końca (UNIQUE w bazie), nadrabiane po przerwie, bez polis odnowionych i zakończonych; nowa data końca = nowe przypomnienie. Powiadomienie w dzwonku (i push/e-mail według ustawień konta), alert w Command Center, zakładki **Polisy do odnowienia** i **Przypomnienia** (historia, oznaczanie jako obsłużone). Odbiorcy: lista w ustawieniach albo administratorzy, właściciele, kierownicy + osoba rejestrująca. SMS – architektura gotowa (kanał w kolejce powiadomień), bez integracji.
- **Pulpit**: liczba polis, kwota polis, zysk MXT, średnia kwota, średnia marża (i ważona), kończące się w 30 dniach, przypomnienia do obsłużenia, podział na towarzystwa i rodzaje, ostatnie 12 miesięcy; filtry okresu, towarzystwa, rodzaju, klienta.
- **Finanse**: kwota polisy nie jest przychodem MXT (baza odrzuca wpisy finansowe działu Ubezpieczenia); wynik działu = zysk z marży.
- Migracja `db/019_erp_ubezpieczenia.sql`. Testy `test/erp-ubezpieczenia.js` (81 sprawdzeń: dodawanie, edycja, klient, zysk i zaokrąglenia, filtry, przypomnienie dokładnie 30 dni przed, przełom roku i czas letni, brak duplikatów, odnowione i zakończone bez przypomnień, nadrabianie, historia, dzwonek, główny panel, dokument, oddzielenie od finansów, uprawnienia).
