-- MXT Business OS – etap 4: kolejka zadań w tle, harmonogram (dzienny raport zarządu), poczta wychodząca,
-- reguły automatyzacji i integracje (n8n), oceny pracy agentów (karta wyników). Idempotentna, nie usuwa danych.

-- Kolejka zadań w tle (PostgreSQL, FOR UPDATE SKIP LOCKED – bezpieczna przy kilku instancjach serwera).
CREATE TABLE IF NOT EXISTS jobs (
  id           bigserial PRIMARY KEY,
  kind         text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  status       text NOT NULL DEFAULT 'oczekuje' CHECK (status IN ('oczekuje', 'w_toku', 'ok', 'blad')),
  run_at       timestamptz NOT NULL DEFAULT now(),
  attempts     int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 5,
  last_error   text,
  result       jsonb,
  locked_at    timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  finished_at  timestamptz
);
CREATE INDEX IF NOT EXISTS jobs_pending_idx ON jobs(run_at) WHERE status = 'oczekuje';

-- Jedno uruchomienie zadania cyklicznego na dzień (np. raport dzienny) – nawet przy kilku instancjach.
CREATE TABLE IF NOT EXISTS scheduled_runs (
  job       text NOT NULL,
  run_date  date NOT NULL,
  job_id    bigint REFERENCES jobs(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job, run_date)
);

-- Ustawienia dziennego raportu zarządu (godzina ustawiana przez administratora).
INSERT INTO system_settings (key, value) VALUES ('daily_report', '{"enabled": false, "time": "07:30", "timezone": "Europe/Warsaw", "recipients": []}')
ON CONFLICT (key) DO NOTHING;

-- Poczta wychodząca (SMTP). Bez konfiguracji SMTP wiadomości są zapisywane w trybie testowym („symulowany”).
CREATE TABLE IF NOT EXISTS mail_outbox (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  to_addr          text NOT NULL,
  subject          text NOT NULL,
  body_text        text NOT NULL,
  attachments      jsonb NOT NULL DEFAULT '[]'::jsonb,   -- [{document_id, version, filename}] albo [{kind:'offer', offer_id, version}]
  customer_id      uuid REFERENCES customers(id) ON DELETE SET NULL,
  communication_id uuid REFERENCES communications(id) ON DELETE SET NULL,
  related_type     text,
  related_id       uuid,
  status           text NOT NULL DEFAULT 'do_wyslania' CHECK (status IN ('do_wyslania', 'wyslany', 'symulowany', 'blad')),
  error            text,
  message_id       text,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  sent_at          timestamptz
);
CREATE INDEX IF NOT EXISTS mail_outbox_created_idx ON mail_outbox(created_at DESC);
ALTER TABLE communications ADD COLUMN IF NOT EXISTS email_from text;
ALTER TABLE communications ADD COLUMN IF NOT EXISTS email_to text;
ALTER TABLE communications ADD COLUMN IF NOT EXISTS message_id text;
CREATE UNIQUE INDEX IF NOT EXISTS communications_message_id_uq ON communications(message_id) WHERE message_id IS NOT NULL;

-- Reguły automatyzacji: zdarzenie w systemie → działanie (zadanie, powiadomienie e-mail, webhook n8n).
CREATE TABLE IF NOT EXISTS automations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 120),
  event         text NOT NULL,
  action        text NOT NULL CHECK (action IN ('zadanie', 'email', 'webhook')),
  params        jsonb NOT NULL DEFAULT '{}'::jsonb,
  secret_hash   text,                 -- dla webhooków: podpis HMAC (sekret pokazywany raz)
  secret_enc    text,                 -- sekret zaszyfrowany kluczem serwera (do podpisywania)
  is_active     boolean NOT NULL DEFAULT true,
  runs          int NOT NULL DEFAULT 0,
  last_run_at   timestamptz,
  last_error    text,
  created_by    uuid NOT NULL REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Tokeny integracji (n8n, skrzynka pocztowa): w bazie wyłącznie skrót SHA-256.
CREATE TABLE IF NOT EXISTS integration_tokens (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  token_hash   text NOT NULL UNIQUE,
  token_hint   text NOT NULL,
  scopes       text[] NOT NULL,
  is_active    boolean NOT NULL DEFAULT true,
  last_used_at timestamptz,
  created_by   uuid NOT NULL REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);

-- Oceny wyników pracy agentów (karta wyników).
CREATE TABLE IF NOT EXISTS agent_feedback (
  run_id     uuid NOT NULL REFERENCES agent_runs(id) ON DELETE CASCADE,
  user_id    uuid NOT NULL REFERENCES users(id),
  rating     smallint NOT NULL CHECK (rating IN (-1, 1)),
  comment    text NOT NULL DEFAULT '',
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, user_id)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['jobs','scheduled_runs','mail_outbox','automations','integration_tokens','agent_feedback'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
