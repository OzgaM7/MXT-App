-- MXT Business OS – etap 3: Platforma Szkoleniowa (dział Ubezpieczenia). Idempotentna, nie usuwa danych.

CREATE TABLE IF NOT EXISTS courses (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title         text NOT NULL CHECK (length(title) BETWEEN 2 AND 200),
  description   text NOT NULL DEFAULT '',
  is_published  boolean NOT NULL DEFAULT false,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS modules (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  title       text NOT NULL,
  sort_order  int NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS lessons (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  module_id     uuid NOT NULL REFERENCES modules(id) ON DELETE CASCADE,
  title         text NOT NULL,
  kind          text NOT NULL CHECK (kind IN ('tekst', 'pdf', 'wideo')),
  content       text NOT NULL DEFAULT '',           -- treść lekcji (tekst) lub opis
  video_url     text,                               -- https (YouTube, Vimeo albo plik wideo)
  document_id   uuid REFERENCES documents(id),       -- PDF
  duration_min  int NOT NULL DEFAULT 0,
  sort_order    int NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS quizzes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  module_id   uuid REFERENCES modules(id) ON DELETE CASCADE,
  title       text NOT NULL,
  pass_pct    int NOT NULL DEFAULT 70 CHECK (pass_pct BETWEEN 1 AND 100),
  questions   jsonb NOT NULL DEFAULT '[]'::jsonb,    -- [{pytanie, odpowiedzi: [..], poprawna: indeks}] – poprawne odpowiedzi nie trafiają do przeglądarki
  sort_order  int NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS quiz_results (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  quiz_id     uuid NOT NULL REFERENCES quizzes(id) ON DELETE CASCADE,
  user_id     uuid NOT NULL REFERENCES users(id),
  score_pct   int NOT NULL,
  passed      boolean NOT NULL,
  answers     jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS quiz_results_user_idx ON quiz_results(user_id, quiz_id);
CREATE TABLE IF NOT EXISTS user_progress (
  user_id       uuid NOT NULL REFERENCES users(id),
  lesson_id     uuid NOT NULL REFERENCES lessons(id) ON DELETE CASCADE,
  completed_at  timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, lesson_id)
);
CREATE TABLE IF NOT EXISTS certificates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number      text NOT NULL UNIQUE,
  user_id     uuid NOT NULL REFERENCES users(id),
  course_id   uuid NOT NULL REFERENCES courses(id) ON DELETE CASCADE,
  issued_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, course_id)
);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['courses','modules','lessons','quizzes','quiz_results','user_progress','certificates'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
