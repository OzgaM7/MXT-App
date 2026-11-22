-- Rozbudowa działu Podzielniki i Montaże – odczyty: terminy i wykonanie (bez wartości odczytów).
-- Obiekt = budynek z ewidencji (tabela buildings), klient = customers – bez osobnych duplikatów danych.
-- Idempotentna, nie usuwa danych.

-- ---------- rola: obsługa odczytów ----------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check' AND pg_get_constraintdef(oid) LIKE '%odczyty%') THEN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('administrator', 'uzytkownik', 'kierownik', 'rozliczajacy', 'monter', 'serwisant', 'odczyty'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_extra_roles_check' AND pg_get_constraintdef(oid) LIKE '%odczyty%') THEN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_extra_roles_check;
    ALTER TABLE users ADD CONSTRAINT users_extra_roles_check CHECK (extra_roles <@ ARRAY['uzytkownik', 'kierownik', 'rozliczajacy', 'monter', 'serwisant', 'odczyty']::text[]);
  END IF;
END $$;

-- ---------- harmonogram odczytów obiektu ----------
-- Jeden budynek może mieć kilka harmonogramów (np. podzielniki raz w roku, wodomierze co pół roku).
CREATE TABLE IF NOT EXISTS reading_schedules (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  building_id    uuid NOT NULL REFERENCES buildings(id),
  customer_id    uuid REFERENCES customers(id),                 -- zleceniodawca odczytów (domyślnie wspólnota budynku)
  scope          text NOT NULL DEFAULT 'podzielniki' CHECK (scope IN ('podzielniki', 'wodomierze', 'cieplomierze', 'wszystkie', 'inne')),
  method         text NOT NULL DEFAULT 'radiowy' CHECK (method IN ('radiowy', 'wizualny', 'zdalny', 'inny')),
  cycle_months   int NOT NULL DEFAULT 12 CHECK (cycle_months BETWEEN 1 AND 60),
  next_due       date NOT NULL,                                 -- kolejny termin odczytu
  last_done      date,                                          -- data ostatniego odczytu (z historii)
  assigned_to    uuid REFERENCES users(id),                     -- osoba odpowiedzialna / wykonująca
  remind_days    int CHECK (remind_days BETWEEN 0 AND 120),     -- wyprzedzenie przypomnienia; NULL = ustawienie domyślne
  contact        text NOT NULL DEFAULT '',                      -- np. zarządca, gospodarz, telefon
  access_notes   text NOT NULL DEFAULT '',                      -- dostęp: klucze, kod do bramy, godziny
  notes          text NOT NULL DEFAULT '',
  is_active      boolean NOT NULL DEFAULT true,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS reading_schedules_building_scope_uidx ON reading_schedules(building_id, scope);
CREATE INDEX IF NOT EXISTS reading_schedules_due_idx ON reading_schedules(next_due) WHERE is_active;

-- ---------- wykonane odczyty (historia, tylko dopisywanie; cofnięcie oznacza wpis, nie usuwa go) ----------
CREATE TABLE IF NOT EXISTS readings (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  schedule_id    uuid NOT NULL REFERENCES reading_schedules(id),
  due_date       date NOT NULL,                                 -- termin, którego dotyczył odczyt
  done_at        date NOT NULL,                                 -- data wykonania
  done_by        uuid REFERENCES users(id),                     -- kto wykonał
  result         text NOT NULL DEFAULT 'pelny' CHECK (result IN ('pelny', 'czesciowy')),
  missing_units  int NOT NULL DEFAULT 0 CHECK (missing_units >= 0),   -- lokale bez odczytu (np. brak dostępu)
  note           text NOT NULL DEFAULT '',
  prev_next_due  date NOT NULL,                                 -- termin przed wpisem (do cofnięcia)
  prev_last_done date,
  next_due       date NOT NULL,                                 -- ustawiony kolejny termin
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  cancelled_at   timestamptz,
  cancelled_by   uuid REFERENCES users(id),
  cancel_reason  text NOT NULL DEFAULT '',
  CHECK (next_due > done_at)
);
CREATE INDEX IF NOT EXISTS readings_schedule_idx ON readings(schedule_id, done_at DESC);

-- Ustawienia: domyślne wyprzedzenie przypomnień (dni) i domyślny cykl.
INSERT INTO system_settings (key, value) VALUES ('readings', '{"remind_days": 14, "cycle_months": 12}') ON CONFLICT (key) DO NOTHING;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['reading_schedules', 'readings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
