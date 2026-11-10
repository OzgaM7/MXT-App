-- MXT Business OS – etap 1: role, działy, zadania, Approval Center, audyt, ustawienia systemowe.
-- Migracja jest idempotentna i nie usuwa danych: można ją uruchamiać wielokrotnie.

-- ---------- role (RBAC) ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'uzytkownik';
DO $$ BEGIN
  ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('administrator', 'uzytkownik'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
UPDATE users SET role = 'administrator' WHERE login IN ('m.ozga', 'p.krajewski') AND role <> 'administrator';

-- ---------- działy ----------
CREATE TABLE IF NOT EXISTS departments (
  id         text PRIMARY KEY,          -- ten sam identyfikator co w adresie /dzial/<id>
  name       text NOT NULL,
  sort_order int  NOT NULL DEFAULT 0,
  has_agents boolean NOT NULL DEFAULT false
);
INSERT INTO departments (id, name, sort_order, has_agents) VALUES
  ('podzielniki-i-montaze', 'Podzielniki i Montaże', 1, true),
  ('sprzedaz-czesci-i-eksport', 'Sprzedaż części i eksport', 2, true),
  ('ubezpieczenia', 'Ubezpieczenia', 3, false)
ON CONFLICT (id) DO NOTHING;

-- ---------- zadania ----------
CREATE TABLE IF NOT EXISTS tasks (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title          text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description    text NOT NULL DEFAULT '',
  department_id  text REFERENCES departments(id),
  status         text NOT NULL DEFAULT 'nowe' CHECK (status IN ('nowe', 'w_toku', 'zakonczone', 'anulowane')),
  priority       text NOT NULL DEFAULT 'normalny' CHECK (priority IN ('niski', 'normalny', 'wysoki', 'pilny')),
  assignee_type  text CHECK (assignee_type IN ('user', 'agent')),
  assignee_id    text,                  -- id użytkownika albo identyfikator agenta (etap 2)
  due_date       date,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  completed_at   timestamptz
);
CREATE INDEX IF NOT EXISTS tasks_status_idx ON tasks(status);
CREATE INDEX IF NOT EXISTS tasks_assignee_idx ON tasks(assignee_type, assignee_id);

-- ---------- Approval Center ----------
-- Każda operacja wiążąca (poziom 2) czeka tu na decyzję administratora.
-- payload_hash = SHA-256 z (typ operacji, treść, dokument, wersja); decyzja dotyczy dokładnie tej wersji.
CREATE TABLE IF NOT EXISTS approvals (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_type    text NOT NULL,
  level             smallint NOT NULL CHECK (level BETWEEN 0 AND 3),
  title             text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  description       text NOT NULL DEFAULT '',
  department_id     text REFERENCES departments(id),
  amount            numeric(14, 2),
  currency          text,
  payload           jsonb NOT NULL DEFAULT '{}'::jsonb,
  document_id       uuid,               -- powiązany dokument (moduł dokumentów – etap 3)
  document_version  int,
  version           int NOT NULL DEFAULT 1,
  payload_hash      text NOT NULL,
  requested_by_type text NOT NULL CHECK (requested_by_type IN ('user', 'agent', 'system')),
  requested_by      text NOT NULL,      -- id użytkownika albo agenta
  status            text NOT NULL DEFAULT 'oczekuje'
                    CHECK (status IN ('oczekuje', 'zatwierdzona', 'odrzucona', 'wykonana', 'wycofana')),
  decided_by        uuid REFERENCES users(id),
  decided_at        timestamptz,
  decided_version   int,
  decided_hash      text,
  decision_note     text,
  auto_rule_id      uuid,
  executed_at       timestamptz,
  executed_by       text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals(status, created_at DESC);

-- Historia każdej akceptacji: kto, kiedy, co zrobił i na jakiej wersji.
CREATE TABLE IF NOT EXISTS approval_events (
  id           bigserial PRIMARY KEY,
  approval_id  uuid NOT NULL REFERENCES approvals(id) ON DELETE CASCADE,
  ts           timestamptz NOT NULL DEFAULT now(),
  actor_type   text NOT NULL,
  actor_id     text,
  actor_label  text,
  event        text NOT NULL,           -- utworzenie, zmiana, zatwierdzenie, odrzucenie, wykonanie, wycofanie
  version      int NOT NULL,
  payload_hash text NOT NULL,
  note         text
);
CREATE INDEX IF NOT EXISTS approval_events_idx ON approval_events(approval_id, ts);

-- Poziom 3: stałe zgody administratora na ograniczone i odwracalne operacje.
CREATE TABLE IF NOT EXISTS approval_rules (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_type  text NOT NULL,
  description     text NOT NULL DEFAULT '',
  max_amount      numeric(14, 2) NOT NULL CHECK (max_amount > 0),
  currency        text NOT NULL DEFAULT 'PLN',
  max_per_day     int NOT NULL CHECK (max_per_day BETWEEN 1 AND 100),
  valid_until     date NOT NULL,
  is_active       boolean NOT NULL DEFAULT true,
  created_by      uuid NOT NULL REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);

-- ---------- rejestr operacji (Security & Audit) ----------
CREATE TABLE IF NOT EXISTS audit_logs (
  id           bigserial PRIMARY KEY,
  ts           timestamptz NOT NULL DEFAULT now(),
  actor_type   text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system', 'anonim')),
  actor_id     text,
  actor_label  text,
  action       text NOT NULL,
  resource     text,
  resource_id  text,
  status       text NOT NULL CHECK (status IN ('ok', 'odmowa', 'blad')),
  ip           text,
  details      jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS audit_ts_idx ON audit_logs(ts DESC);
CREATE INDEX IF NOT EXISTS audit_status_idx ON audit_logs(status, ts DESC);

-- ---------- ustawienia systemowe (m.in. wyłącznik agentów) ----------
CREATE TABLE IF NOT EXISTS system_settings (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_by  uuid REFERENCES users(id),
  updated_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO system_settings (key, value) VALUES ('agents_stopped', '{"stopped": false}')
ON CONFLICT (key) DO NOTHING;

ALTER TABLE departments ENABLE ROW LEVEL SECURITY;
ALTER TABLE tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;
ALTER TABLE system_settings ENABLE ROW LEVEL SECURITY;
