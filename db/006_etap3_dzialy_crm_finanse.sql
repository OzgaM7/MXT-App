-- MXT Business OS – etap 3: CRM, komunikacja, dokumenty z wersjami (Knowledge Base), finanse, kursy walut,
-- dział Podzielniki i Montaże, dział Sprzedaż części i eksport, reklamacje. Idempotentna, nie usuwa danych.

-- numeracja dokumentów (OF/2026/001, PO/2026/001, ...)
CREATE TABLE IF NOT EXISTS doc_counters (k text PRIMARY KEY, n int NOT NULL);

-- ---------- CRM ----------
CREATE TABLE IF NOT EXISTS customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind          text NOT NULL CHECK (kind IN ('wspolnota', 'spoldzielnia', 'zarzadca', 'firma', 'klient_zagraniczny', 'inny')),
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  tax_id        text NOT NULL DEFAULT '',            -- NIP / VAT ID
  country       text NOT NULL DEFAULT 'PL',
  address       text NOT NULL DEFAULT '',
  email         text NOT NULL DEFAULT '',
  phone         text NOT NULL DEFAULT '',
  language      text NOT NULL DEFAULT 'pl',
  contacts      jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{imie, funkcja, email, telefon}]
  departments   text[] NOT NULL DEFAULT '{}',
  notes         text NOT NULL DEFAULT '',
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS customers_name_idx ON customers (lower(name));

-- Communication Hub: korespondencja i notatki (integracja poczty – etap 4)
CREATE TABLE IF NOT EXISTS communications (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid REFERENCES customers(id) ON DELETE CASCADE,
  channel      text NOT NULL CHECK (channel IN ('email', 'telefon', 'spotkanie', 'notatka', 'system')),
  direction    text NOT NULL DEFAULT 'wewnetrzna' CHECK (direction IN ('przychodzaca', 'wychodzaca', 'wewnetrzna')),
  subject      text NOT NULL DEFAULT '',
  body         text NOT NULL DEFAULT '',
  related_type text,
  related_id   uuid,
  agent_id     text REFERENCES agents(id),
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS communications_customer_idx ON communications(customer_id, created_at DESC);

-- ---------- dokumenty z wersjami (protokoły, oferty, dokumenty eksportowe, Knowledge Base, materiały szkoleniowe) ----------
CREATE TABLE IF NOT EXISTS documents (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind             text NOT NULL CHECK (kind IN ('wiedza', 'procedura', 'protokol', 'oferta', 'eksport', 'szkolenie', 'inny')),
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 300),
  department_id    text REFERENCES departments(id),
  related_type     text,
  related_id       uuid,
  current_version  int NOT NULL DEFAULT 0,
  tags             text[] NOT NULL DEFAULT '{}',
  for_agents       boolean NOT NULL DEFAULT false,      -- dostępny dla agentów w Knowledge Base
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS document_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id  uuid NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version      int NOT NULL,
  content      text NOT NULL DEFAULT '',             -- treść tekstowa (KB) lub dane dokumentu (JSON)
  file_data    bytea,                                -- plik (PDF); w kolejnym kroku przeniesienie do S3/MinIO
  file_name    text,
  mime_type    text,
  file_size    int,
  sha256       text,
  note         text NOT NULL DEFAULT '',
  created_by   uuid REFERENCES users(id),
  created_by_agent text REFERENCES agents(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (document_id, version)
);
CREATE INDEX IF NOT EXISTS documents_fts ON document_versions USING gin (to_tsvector('simple', content));

-- ---------- kursy walut (wyłącznie z autoryzowanego źródła – NBP – albo wpis administratora z adnotacją) ----------
CREATE TABLE IF NOT EXISTS currency_rates (
  id              bigserial PRIMARY KEY,
  code            text NOT NULL CHECK (code ~ '^[A-Z]{3}$'),
  rate_pln        numeric(14, 6) NOT NULL CHECK (rate_pln > 0),     -- ile PLN za 1 jednostkę waluty
  effective_date  date NOT NULL,
  table_no        text NOT NULL DEFAULT '',
  source          text NOT NULL,                                    -- 'NBP tabela A' albo 'ręcznie: <login>'
  fetched_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (code, effective_date, source)
);

-- ---------- kontrakty / zlecenia (projects) ----------
CREATE TABLE IF NOT EXISTS projects (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number         text NOT NULL UNIQUE,
  department_id  text NOT NULL REFERENCES departments(id),
  customer_id    uuid REFERENCES customers(id),
  title          text NOT NULL,
  value_net      numeric(14, 2) NOT NULL DEFAULT 0 CHECK (value_net >= 0),
  currency       text NOT NULL DEFAULT 'PLN',
  status         text NOT NULL DEFAULT 'w_realizacji' CHECK (status IN ('oferta', 'w_realizacji', 'zakonczony', 'rozliczony', 'anulowany')),
  start_date     date,
  end_date       date,
  notes          text NOT NULL DEFAULT '',
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- ---------- Dział 1: Podzielniki i Montaże ----------
CREATE TABLE IF NOT EXISTS buildings (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid REFERENCES customers(id),          -- wspólnota / spółdzielnia / zarządca
  name          text NOT NULL,
  address       text NOT NULL,
  city          text NOT NULL DEFAULT '',
  postal_code   text NOT NULL DEFAULT '',
  units_count   int NOT NULL DEFAULT 0 CHECK (units_count >= 0),
  heating_type  text NOT NULL DEFAULT '',
  notes         text NOT NULL DEFAULT '',
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS crews (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name        text NOT NULL UNIQUE,
  leader      text NOT NULL DEFAULT '',
  phone       text NOT NULL DEFAULT '',
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS installers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  crew_id         uuid REFERENCES crews(id) ON DELETE SET NULL,
  name            text NOT NULL,
  phone           text NOT NULL DEFAULT '',
  qualifications  text NOT NULL DEFAULT '',
  is_active       boolean NOT NULL DEFAULT true,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS installations (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                text NOT NULL UNIQUE,
  project_id            uuid REFERENCES projects(id),
  building_id           uuid NOT NULL REFERENCES buildings(id),
  crew_id               uuid REFERENCES crews(id),
  planned_date          date NOT NULL,
  planned_end           date,
  status                text NOT NULL DEFAULT 'zaplanowany' CHECK (status IN ('zaplanowany', 'w_toku', 'wykonany', 'odebrany', 'anulowany')),
  scope                 text NOT NULL DEFAULT '',
  devices_planned       int NOT NULL DEFAULT 0 CHECK (devices_planned >= 0),
  materials             jsonb NOT NULL DEFAULT '[]'::jsonb,     -- [{nazwa, ilosc, jm}]
  protocol_document_id  uuid REFERENCES documents(id),
  accepted_by           text,                                   -- przedstawiciel wspólnoty przy odbiorze
  accepted_at           timestamptz,
  notes                 text NOT NULL DEFAULT '',
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS installations_date_idx ON installations(planned_date);
CREATE TABLE IF NOT EXISTS devices (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id      uuid REFERENCES buildings(id),
  installation_id  uuid REFERENCES installations(id) ON DELETE SET NULL,
  type             text NOT NULL CHECK (type IN ('podzielnik', 'wodomierz', 'cieplomierz', 'modul_radiowy', 'inny')),
  serial_no        text NOT NULL UNIQUE,
  model            text NOT NULL DEFAULT '',
  location         text NOT NULL DEFAULT '',        -- lokal / pomieszczenie / grzejnik
  status           text NOT NULL DEFAULT 'zamontowane' CHECK (status IN ('magazyn', 'zamontowane', 'zdemontowane', 'wadliwe')),
  installed_at     date,
  notes            text NOT NULL DEFAULT '',
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS devices_building_idx ON devices(building_id);

-- ---------- Dział 2: Sprzedaż części i eksport ----------
CREATE TABLE IF NOT EXISTS offers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number           text NOT NULL UNIQUE,
  department_id    text NOT NULL REFERENCES departments(id),
  customer_id      uuid NOT NULL REFERENCES customers(id),
  title            text NOT NULL,
  currency         text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  rate_pln         numeric(14, 6) NOT NULL,            -- kurs z currency_rates (1 dla PLN)
  rate_date        date NOT NULL,
  rate_source      text NOT NULL,
  margin_pct       numeric(6, 2) NOT NULL DEFAULT 0,
  discount_pct     numeric(5, 2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 90),
  items            jsonb NOT NULL DEFAULT '[]'::jsonb,  -- [{nazwa, ilosc, jm, koszt_pln, cena, kod_hs, waga_kg, pochodzenie}]
  total            numeric(14, 2) NOT NULL DEFAULT 0,   -- w walucie oferty, po rabacie
  total_pln        numeric(14, 2) NOT NULL DEFAULT 0,
  cost_pln         numeric(14, 2) NOT NULL DEFAULT 0,
  valid_until      date,
  terms            text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'szkic' CHECK (status IN ('szkic', 'do_akceptacji', 'wyslana', 'przyjeta', 'odrzucona', 'anulowana')),
  version          int NOT NULL DEFAULT 1,
  document_id      uuid REFERENCES documents(id),
  approval_id      uuid REFERENCES approvals(id),
  sent_at          timestamptz,
  created_by       uuid REFERENCES users(id),
  created_by_agent text REFERENCES agents(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sales_history (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number       text NOT NULL UNIQUE,
  customer_id  uuid NOT NULL REFERENCES customers(id),
  offer_id     uuid REFERENCES offers(id),
  sale_date    date NOT NULL DEFAULT current_date,
  currency     text NOT NULL,
  rate_pln     numeric(14, 6) NOT NULL,
  total        numeric(14, 2) NOT NULL,
  total_pln    numeric(14, 2) NOT NULL,
  cost_pln     numeric(14, 2) NOT NULL DEFAULT 0,
  items        jsonb NOT NULL DEFAULT '[]'::jsonb,
  status       text NOT NULL DEFAULT 'w_realizacji' CHECK (status IN ('w_realizacji', 'zrealizowana', 'anulowana')),
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS export_documents (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number               text NOT NULL UNIQUE,
  kind                 text NOT NULL CHECK (kind IN ('faktura_eksportowa', 'specyfikacja_wysylkowa', 'dane_celne')),
  sale_id              uuid REFERENCES sales_history(id),
  offer_id             uuid REFERENCES offers(id),
  customer_id          uuid NOT NULL REFERENCES customers(id),
  document_id          uuid NOT NULL REFERENCES documents(id),
  incoterms            text NOT NULL DEFAULT '',
  destination_country  text NOT NULL DEFAULT '',
  data                 jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by           uuid REFERENCES users(id),
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- ---------- reklamacje (oba działy) ----------
CREATE TABLE IF NOT EXISTS complaints (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number           text NOT NULL UNIQUE,
  department_id    text NOT NULL REFERENCES departments(id),
  customer_id      uuid REFERENCES customers(id),
  building_id      uuid REFERENCES buildings(id),
  device_id        uuid REFERENCES devices(id),
  installation_id  uuid REFERENCES installations(id),
  sale_id          uuid REFERENCES sales_history(id),
  title            text NOT NULL,
  description      text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'zgloszona' CHECK (status IN ('zgloszona', 'w_analizie', 'w_naprawie', 'rozwiazana', 'odrzucona')),
  reported_at      date NOT NULL DEFAULT current_date,
  resolved_at      date,
  resolution       text NOT NULL DEFAULT '',
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);

-- ---------- Finance Intelligence: przychody, koszty, faktury, płatności (działy 1 i 2) ----------
CREATE TABLE IF NOT EXISTS finance (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  department_id    text NOT NULL REFERENCES departments(id) CHECK (department_id <> 'ubezpieczenia'),
  kind             text NOT NULL CHECK (kind IN ('przychod', 'koszt')),
  category         text NOT NULL DEFAULT '',             -- np. faktura, materiały, robocizna, transport
  description      text NOT NULL DEFAULT '',
  amount           numeric(14, 2) NOT NULL CHECK (amount >= 0),
  currency         text NOT NULL DEFAULT 'PLN',
  rate_pln         numeric(14, 6) NOT NULL DEFAULT 1,
  amount_pln       numeric(14, 2) NOT NULL,
  entry_date       date NOT NULL DEFAULT current_date,
  invoice_no       text NOT NULL DEFAULT '',
  due_date         date,
  paid_at          date,
  customer_id      uuid REFERENCES customers(id),
  project_id       uuid REFERENCES projects(id),
  building_id      uuid REFERENCES buildings(id),
  installation_id  uuid REFERENCES installations(id),
  offer_id         uuid REFERENCES offers(id),
  sale_id          uuid REFERENCES sales_history(id),
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS finance_date_idx ON finance(department_id, entry_date);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['doc_counters','customers','communications','documents','document_versions','currency_rates','projects','buildings','crews',
    'installers','installations','devices','offers','sales_history','export_documents','complaints','finance'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
