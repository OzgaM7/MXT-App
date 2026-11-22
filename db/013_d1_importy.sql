-- Dział Podzielniki i Montaże: wczytywanie montaży z umowy lub harmonogramu (PDF / skan / zdjęcie).
-- Każde wczytanie zostaje zapisane: plik (jako PDF), dane odczytane automatycznie i to, co użytkownik zatwierdził.
-- Idempotentna, nie usuwa danych.
CREATE TABLE IF NOT EXISTS doc_imports (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  file_name     text NOT NULL,
  mime          text NOT NULL,                                  -- typ oryginalnego pliku
  file_pdf      bytea NOT NULL,                                 -- dokument zapisany jako PDF (zdjęcie → PDF)
  file_size     int NOT NULL,
  sha256        text NOT NULL,
  mode          text NOT NULL CHECK (mode IN ('ai', 'reczny')),  -- odczyt automatyczny (Claude) albo formularz ręczny
  extracted     jsonb,                                          -- dane odczytane przez model (przed poprawkami użytkownika)
  ai_model      text,
  ai_usage      jsonb,
  ai_cost_usd   numeric(10, 4),
  ai_note       text NOT NULL DEFAULT '',                       -- np. dlaczego odczyt był ręczny
  status        text NOT NULL DEFAULT 'odczytany' CHECK (status IN ('odczytany', 'zatwierdzony')),
  result        jsonb,                                          -- utworzone: kontrakt, montaże, dokument
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  confirmed_at  timestamptz
);
CREATE INDEX IF NOT EXISTS doc_imports_created_idx ON doc_imports(created_at DESC);
ALTER TABLE doc_imports ENABLE ROW LEVEL SECURITY;
