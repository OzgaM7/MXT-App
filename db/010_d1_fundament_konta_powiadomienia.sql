-- Rozbudowa działu Podzielniki i Montaże – etap 1 (fundament): role i konta pracowników, powiązanie kont z instalatorami,
-- powiadomienia (w aplikacji, push, e-mail), archiwum anulowanych wpisów finansowych. Idempotentna, nie usuwa danych.

-- ---------- role i konta ----------
-- Rola główna (users.role) + role dodatkowe (users.extra_roles), np. monter, który też rozlicza.
-- Administrator jest zawsze rolą główną (sprawdzenia w Approval Center opierają się na users.role).
-- Lista ról rozszerzana tylko, gdy jest starsza (kolejne migracje, np. 011 – serwisant, dopisują role; ponowne
-- uruchomienie tej migracji nie może jej zawęzić).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check' AND pg_get_constraintdef(oid) LIKE '%monter%') THEN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('administrator', 'uzytkownik', 'kierownik', 'rozliczajacy', 'monter'));
  END IF;
END $$;
ALTER TABLE users ADD COLUMN IF NOT EXISTS extra_roles text[] NOT NULL DEFAULT '{}';
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_extra_roles_check CHECK (extra_roles <@ ARRAY['uzytkownik', 'kierownik', 'rozliczajacy', 'monter']::text[]);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
ALTER TABLE users ADD COLUMN IF NOT EXISTS full_name    text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS email        text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS phone        text NOT NULL DEFAULT '';
ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active    boolean NOT NULL DEFAULT true;   -- konta się nie usuwa, tylko dezaktywuje
ALTER TABLE users ADD COLUMN IF NOT EXISTS notify_email boolean NOT NULL DEFAULT false;  -- kopia powiadomień na e-mail
ALTER TABLE users ADD COLUMN IF NOT EXISTS created_by   uuid REFERENCES users(id);
ALTER TABLE users ADD COLUMN IF NOT EXISTS updated_at   timestamptz NOT NULL DEFAULT now();

-- ---------- instalator ↔ konto ----------
-- Instalator z kontem w aplikacji widzi montaże swojej ekipy („Moje montaże”) i dostaje powiadomienia o przydziałach.
ALTER TABLE installers ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS installers_user_uidx ON installers(user_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS installations_crew_date_idx ON installations(crew_id, planned_date);
CREATE INDEX IF NOT EXISTS devices_installation_idx ON devices(installation_id);
CREATE INDEX IF NOT EXISTS devices_building_idx ON devices(building_id);

-- ---------- powiadomienia ----------
-- dedup_key: to samo powiadomienie (np. przypomnienie o terminie) nie trafia do tej samej osoby drugi raz.
CREATE TABLE IF NOT EXISTS notifications (
  id            bigserial PRIMARY KEY,
  user_id       uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind          text NOT NULL,
  title         text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  body          text NOT NULL DEFAULT '',
  link          text NOT NULL DEFAULT '' CHECK (link = '' OR link ~ '^/[a-z0-9/_?=&.-]*$'),
  related_type  text,
  related_id    uuid,
  dedup_key     text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  read_at       timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedup_uidx ON notifications(user_id, dedup_key) WHERE dedup_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS notifications_user_idx ON notifications(user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS notifications_unread_idx ON notifications(user_id) WHERE read_at IS NULL;

-- Subskrypcje Web Push (jedno konto może mieć kilka urządzeń).
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  endpoint    text NOT NULL UNIQUE CHECK (endpoint ~ '^https://'),
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  user_agent  text NOT NULL DEFAULT '',
  created_at  timestamptz NOT NULL DEFAULT now(),
  last_ok_at  timestamptz
);
CREATE INDEX IF NOT EXISTS push_subscriptions_user_idx ON push_subscriptions(user_id);

-- ---------- finanse: anulowanie zamiast usuwania ----------
-- Anulowany wpis znika z sum i zestawień, ale zostaje w archiwum z powodem, autorem i datą (pełna kopia danych).
CREATE TABLE IF NOT EXISTS finance_cancelled (
  id            uuid PRIMARY KEY,                 -- id anulowanego wpisu z tabeli finance
  data          jsonb NOT NULL,                   -- pełna kopia wpisu z chwili anulowania
  reason        text NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  cancelled_by  uuid REFERENCES users(id),
  cancelled_at  timestamptz NOT NULL DEFAULT now()
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['notifications', 'push_subscriptions', 'finance_cancelled'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
