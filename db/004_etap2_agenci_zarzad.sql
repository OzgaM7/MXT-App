-- MXT Business OS – etap 2: agenci AI, ustawienia i wersje promptów, uruchomienia (koszty), pamięć,
-- posiedzenia Zarządu AI (protokoły, decyzje) i raporty. Idempotentna, nie usuwa danych.

CREATE TABLE IF NOT EXISTS agents (
  id            text PRIMARY KEY,                 -- ceo, cfo, coo, cso, handlowiec, ...
  name          text NOT NULL,
  title         text NOT NULL,
  agent_group   text NOT NULL CHECK (agent_group IN ('zarzad', 'dzial')),
  department_id text REFERENCES departments(id),
  sort_order    int  NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS agent_settings (
  agent_id      text PRIMARY KEY REFERENCES agents(id),
  display_name  text NOT NULL,
  avatar        text NOT NULL DEFAULT '',         -- skrót wyświetlany w awatarze
  avatar_color  text NOT NULL DEFAULT '#141a3a',
  model         text NOT NULL DEFAULT 'claude-opus-5-5',
  temperature   numeric(3, 2) NOT NULL DEFAULT 0.30 CHECK (temperature BETWEEN 0 AND 1),
  effort        text NOT NULL DEFAULT 'medium' CHECK (effort IN ('low', 'medium', 'high')),
  cost_limit    numeric(10, 2) NOT NULL DEFAULT 50 CHECK (cost_limit >= 0),   -- USD miesięcznie
  is_active     boolean NOT NULL DEFAULT true,
  updated_by    uuid REFERENCES users(id),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS agent_prompt_versions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        text NOT NULL REFERENCES agents(id),
  prompt_text     text NOT NULL CHECK (length(prompt_text) BETWEEN 1 AND 20000),
  version         int  NOT NULL,
  author_user_id  uuid REFERENCES users(id),      -- NULL = wersja dostarczona z systemem
  created_at      timestamptz NOT NULL DEFAULT now(),
  is_default      boolean NOT NULL DEFAULT false,
  is_current      boolean NOT NULL DEFAULT false,
  restored_from   int,                            -- numer wersji, z której przywrócono treść
  UNIQUE (agent_id, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS agent_prompt_current_uq ON agent_prompt_versions(agent_id) WHERE is_current;
CREATE UNIQUE INDEX IF NOT EXISTS agent_prompt_default_uq ON agent_prompt_versions(agent_id) WHERE is_default;

-- Każde wywołanie agenta: koszt, tokeny, wersja promptu, tryb (test / live). Podstawa limitów kosztów i AI Workforce.
CREATE TABLE IF NOT EXISTS agent_runs (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id        text NOT NULL REFERENCES agents(id),
  kind            text NOT NULL CHECK (kind IN ('test_promptu', 'zadanie', 'posiedzenie', 'raport')),
  mode            text NOT NULL CHECK (mode IN ('test', 'live')),
  model           text NOT NULL,
  prompt_version  int,
  status          text NOT NULL CHECK (status IN ('ok', 'blad', 'odmowa', 'zablokowane')),
  input_tokens    int NOT NULL DEFAULT 0,
  output_tokens   int NOT NULL DEFAULT 0,
  cost_usd        numeric(12, 6) NOT NULL DEFAULT 0,
  input_summary   text NOT NULL DEFAULT '',
  output          text NOT NULL DEFAULT '',
  tool_calls      jsonb NOT NULL DEFAULT '[]'::jsonb,
  error           text,
  task_id         uuid REFERENCES tasks(id) ON DELETE SET NULL,
  meeting_id      uuid,
  user_id         uuid REFERENCES users(id),
  duration_ms     int,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_runs_agent_idx ON agent_runs(agent_id, created_at DESC);
CREATE INDEX IF NOT EXISTS agent_runs_task_idx ON agent_runs(task_id);

-- Pamięć agentów, rozdzielona zakresem: osobista (jeden agent), działowa (dział), korporacyjna (cała firma).
CREATE TABLE IF NOT EXISTS agent_memory (
  id            bigserial PRIMARY KEY,
  scope         text NOT NULL CHECK (scope IN ('osobista', 'dzialowa', 'korporacyjna')),
  agent_id      text REFERENCES agents(id),
  department_id text REFERENCES departments(id),
  content       text NOT NULL CHECK (length(content) BETWEEN 1 AND 4000),
  source        text NOT NULL DEFAULT '',
  created_by    text NOT NULL DEFAULT '',
  created_at    timestamptz NOT NULL DEFAULT now(),
  CHECK ((scope = 'osobista' AND agent_id IS NOT NULL) OR (scope = 'dzialowa' AND department_id IS NOT NULL) OR scope = 'korporacyjna')
);
CREATE INDEX IF NOT EXISTS agent_memory_fts ON agent_memory USING gin (to_tsvector('simple', content));

-- pgvector (pamięć semantyczna): dodawany, jeśli rozszerzenie jest dostępne w bazie (Supabase: tak).
DO $$ BEGIN
  CREATE EXTENSION IF NOT EXISTS vector;
  ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS embedding vector(1024);
EXCEPTION WHEN OTHERS THEN
  RAISE NOTICE 'pgvector niedostępny – pamięć działa na wyszukiwaniu pełnotekstowym';
END $$;

-- Posiedzenia Zarządu AI i protokoły.
CREATE TABLE IF NOT EXISTS board_meetings (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  topic           text NOT NULL CHECK (length(topic) BETWEEN 3 AND 300),
  context         text NOT NULL DEFAULT '',
  status          text NOT NULL DEFAULT 'w_toku' CHECK (status IN ('w_toku', 'oczekuje_decyzji', 'zakonczone', 'blad')),
  convened_by     uuid NOT NULL REFERENCES users(id),
  mode            text NOT NULL,
  recommendation  text,
  approval_id     uuid REFERENCES approvals(id),
  error           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  finished_at     timestamptz
);
CREATE TABLE IF NOT EXISTS board_contributions (
  id              bigserial PRIMARY KEY,
  meeting_id      uuid NOT NULL REFERENCES board_meetings(id) ON DELETE CASCADE,
  seq             int NOT NULL,
  agent_id        text NOT NULL REFERENCES agents(id),
  stage           text NOT NULL CHECK (stage IN ('otwarcie', 'stanowisko', 'rekomendacja', 'pominiete')),
  content         text NOT NULL,
  prompt_version  int,
  run_id          uuid REFERENCES agent_runs(id),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS board_contrib_idx ON board_contributions(meeting_id, seq);

-- Decyzje administratorów dotyczące rekomendacji zarządu (powiązane z Approval Center).
CREATE TABLE IF NOT EXISTS decisions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id   uuid REFERENCES board_meetings(id) ON DELETE SET NULL,
  approval_id  uuid NOT NULL REFERENCES approvals(id),
  title        text NOT NULL,
  status       text NOT NULL CHECK (status IN ('zatwierdzona', 'odrzucona')),
  decided_by   uuid NOT NULL REFERENCES users(id),
  note         text,
  decided_at   timestamptz NOT NULL DEFAULT now()
);

-- Raporty Zarządu AI dla administratorów.
CREATE TABLE IF NOT EXISTS board_reports (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  content     text NOT NULL,
  agent_id    text NOT NULL REFERENCES agents(id),
  mode        text NOT NULL,
  run_id      uuid REFERENCES agent_runs(id),
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_prompt_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_contributions ENABLE ROW LEVEL SECURITY;
ALTER TABLE decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE board_reports ENABLE ROW LEVEL SECURITY;
