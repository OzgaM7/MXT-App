-- MXT ERP – etap 4: dział Ciepłomierze i podzielniki. Lokale, kartoteka i historia urządzeń, odczyty per urządzenie,
-- projekty (budżet, zespół, historia), rozliczanie zleceń (montaż, serwis, odczyt), wspólny rejestr zleceń,
-- plany miesięczne, pracownicy (nieobecności, czas pracy). Idempotentna, tylko dodaje (bez usuwania danych).

-- ---------- lokale ----------
CREATE TABLE IF NOT EXISTS units (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id uuid NOT NULL REFERENCES buildings(id),
  number      text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),   -- numer lokalu, np. 12, 3A, U1
  floor       text NOT NULL DEFAULT '',
  occupant    text NOT NULL DEFAULT '',                                -- lokator / właściciel (do kontaktu przy odczycie)
  phone       text NOT NULL DEFAULT '',
  area_m2     numeric(8, 2) CHECK (area_m2 IS NULL OR area_m2 >= 0),
  notes       text NOT NULL DEFAULT '',
  is_active   boolean NOT NULL DEFAULT true,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS units_building_number_uidx ON units (building_id, lower(number));

-- ---------- urządzenia: producent, lokal, historia ----------
ALTER TABLE devices ADD COLUMN IF NOT EXISTS manufacturer text NOT NULL DEFAULT '';
ALTER TABLE devices ADD COLUMN IF NOT EXISTS unit_id uuid REFERENCES units(id) ON DELETE SET NULL;
ALTER TABLE devices ADD COLUMN IF NOT EXISTS radio_id text NOT NULL DEFAULT '';          -- identyfikator radiowy (odczyt zdalny)
ALTER TABLE devices ADD COLUMN IF NOT EXISTS legalization_until date;                     -- ważność legalizacji (ciepłomierze, wodomierze)
CREATE INDEX IF NOT EXISTS devices_unit_idx ON devices(unit_id);
CREATE TABLE IF NOT EXISTS device_events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id     uuid NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('montaz', 'demontaz', 'wymiana', 'serwis', 'odczyt', 'zmiana_statusu', 'legalizacja', 'przeniesienie', 'inne')),
  event_date    date NOT NULL DEFAULT current_date,
  description   text NOT NULL DEFAULT '',
  related_type  text,
  related_id    uuid,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS device_events_device_idx ON device_events(device_id, event_date DESC);

-- ---------- odczyty per urządzenie ----------
ALTER TABLE readings ADD COLUMN IF NOT EXISTS settled_at timestamptz;
ALTER TABLE readings ADD COLUMN IF NOT EXISTS invoice_no text NOT NULL DEFAULT '';
CREATE TABLE IF NOT EXISTS device_readings (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  device_id    uuid NOT NULL REFERENCES devices(id),
  schedule_id  uuid REFERENCES reading_schedules(id),
  reading_id   uuid REFERENCES readings(id),                       -- sesja odczytu budynku (gdy zapisana)
  read_at      date NOT NULL,
  value        numeric(16, 3),                                     -- NULL = brak odczytu (np. brak dostępu)
  status       text NOT NULL DEFAULT 'ok' CHECK (status IN ('ok', 'brak', 'podejrzany')),
  anomaly      text NOT NULL DEFAULT '',                           -- powód oznaczenia „podejrzany”
  source       text NOT NULL DEFAULT 'reczny' CHECK (source IN ('reczny', 'mobilny', 'radiowy', 'import')),
  note         text NOT NULL DEFAULT '',
  read_by      uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (value IS NULL OR value >= 0),
  CHECK (status <> 'ok' OR value IS NOT NULL)
);
CREATE UNIQUE INDEX IF NOT EXISTS device_readings_once_uidx ON device_readings (device_id, read_at);
CREATE INDEX IF NOT EXISTS device_readings_schedule_idx ON device_readings (schedule_id, read_at);

-- ---------- zlecenia serwisowe: projekt, urządzenie, lokal, rozliczenie, statusy „rozliczone” i „zamknięte” ----------
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id);
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS device_id uuid REFERENCES devices(id) ON DELETE SET NULL;
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS unit_id uuid REFERENCES units(id) ON DELETE SET NULL;
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS settled_at timestamptz;
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS invoice_no text NOT NULL DEFAULT '';
ALTER TABLE service_orders ADD COLUMN IF NOT EXISTS closed_at timestamptz;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'service_orders_status_check' AND pg_get_constraintdef(oid) LIKE '%rozliczone%') THEN
    ALTER TABLE service_orders DROP CONSTRAINT IF EXISTS service_orders_status_check;
    ALTER TABLE service_orders ADD CONSTRAINT service_orders_status_check CHECK (status IN ('nowe', 'oczekuje', 'przypisane', 'zaplanowane', 'w_realizacji',
      'ponowna_wizyta', 'wykonane', 'zatwierdzone', 'rozliczone', 'zamkniete', 'anulowane'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS service_orders_project_idx ON service_orders(project_id);
CREATE INDEX IF NOT EXISTS service_orders_device_idx ON service_orders(device_id);

-- ---------- montaże: rozliczenie po zleceniu ----------
ALTER TABLE installations ADD COLUMN IF NOT EXISTS settled_at timestamptz;
ALTER TABLE installations ADD COLUMN IF NOT EXISTS invoice_no text NOT NULL DEFAULT '';
CREATE INDEX IF NOT EXISTS installations_project_idx ON installations(project_id);

-- ---------- finanse: powiązanie wpisu z pojedynczym zleceniem serwisowym i odczytem ----------
ALTER TABLE finance ADD COLUMN IF NOT EXISTS service_order_id uuid REFERENCES service_orders(id);
ALTER TABLE finance ADD COLUMN IF NOT EXISTS reading_id uuid REFERENCES readings(id);
CREATE INDEX IF NOT EXISTS finance_project_idx ON finance(project_id);
CREATE INDEX IF NOT EXISTS finance_installation_idx ON finance(installation_id);
CREATE INDEX IF NOT EXISTS finance_service_order_idx ON finance(service_order_id);

-- ---------- projekty: budżet, kierownik, zespół, historia ----------
ALTER TABLE projects ADD COLUMN IF NOT EXISTS manager_id uuid REFERENCES users(id);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS billing text NOT NULL DEFAULT 'po_zleceniu';   -- po_zleceniu | miesiecznie | ryczalt
DO $$ BEGIN
  ALTER TABLE projects ADD CONSTRAINT projects_billing_check CHECK (billing IN ('po_zleceniu', 'miesiecznie', 'ryczalt'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE TABLE IF NOT EXISTS project_budget (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('przychod', 'koszt')),
  category    text NOT NULL CHECK (category IN ('montaz', 'serwis', 'odczyty', 'materialy', 'robocizna', 'transport', 'podwykonawcy', 'inne')),
  amount      numeric(14, 2) NOT NULL CHECK (amount >= 0),
  note        text NOT NULL DEFAULT '',
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, kind, category)
);
CREATE TABLE IF NOT EXISTS project_members (
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  role        text NOT NULL DEFAULT '',            -- np. kierownik robót, monter, rozliczający
  added_by    uuid REFERENCES users(id),
  added_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, user_id)
);
CREATE TABLE IF NOT EXISTS project_events (
  id          bigserial PRIMARY KEY,
  project_id  uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind        text NOT NULL,                       -- utworzenie, budzet, zespol, zlecenie, rozliczenie, protokol, material, czas, notatka, status
  text        text NOT NULL,
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_events_project_idx ON project_events(project_id, created_at DESC);

-- ---------- plany miesięczne działu ----------
CREATE TABLE IF NOT EXISTS monthly_plans (
  month       date NOT NULL CHECK (extract(day FROM month) = 1),
  metric      text NOT NULL CHECK (metric IN ('montaze', 'urzadzenia', 'serwisy', 'odczyty', 'przychod')),
  target      numeric(14, 2) NOT NULL CHECK (target >= 0),
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (month, metric)
);

-- ---------- pracownicy: nieobecności i czas pracy ----------
CREATE TABLE IF NOT EXISTS absences (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid NOT NULL REFERENCES users(id),
  kind       text NOT NULL CHECK (kind IN ('urlop', 'l4', 'szkolenie', 'delegacja', 'inne')),
  date_from  date NOT NULL,
  date_to    date NOT NULL,
  note       text NOT NULL DEFAULT '',
  created_by uuid REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (date_to >= date_from)
);
CREATE INDEX IF NOT EXISTS absences_user_idx ON absences(user_id, date_from);
CREATE TABLE IF NOT EXISTS time_entries (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES users(id),
  work_date     date NOT NULL,
  hours         numeric(5, 2) NOT NULL CHECK (hours > 0 AND hours <= 24),
  related_type  text NOT NULL DEFAULT 'inne' CHECK (related_type IN ('installation', 'service_order', 'reading', 'project', 'inne')),
  related_id    uuid,
  project_id    uuid REFERENCES projects(id),
  rate          numeric(10, 2) NOT NULL DEFAULT 0 CHECK (rate >= 0),     -- stawka godzinowa w chwili wpisu (koszt robocizny)
  cost          numeric(14, 2) NOT NULL DEFAULT 0 CHECK (cost >= 0),
  note          text NOT NULL DEFAULT '',
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS time_entries_user_idx ON time_entries(user_id, work_date);
CREATE INDEX IF NOT EXISTS time_entries_project_idx ON time_entries(project_id);
CREATE INDEX IF NOT EXISTS time_entries_related_idx ON time_entries(related_type, related_id);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['units', 'device_events', 'device_readings', 'project_budget', 'project_members', 'project_events', 'monthly_plans', 'absences', 'time_entries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
