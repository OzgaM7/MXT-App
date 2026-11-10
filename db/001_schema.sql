-- MXT: schemat bazy danych (PostgreSQL 13+ / Supabase)
-- Uruchamiany przez `npm run migrate` albo ręcznie w edytorze SQL Supabase.

CREATE TABLE IF NOT EXISTS users (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  login                text        NOT NULL UNIQUE,
  password_hash        text        NOT NULL,
  must_change_password boolean     NOT NULL DEFAULT true,
  created_at           timestamptz NOT NULL DEFAULT now()
);

-- Sesje logowania: w bazie trzymany jest tylko skrót SHA-256 tokenu z ciasteczka.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash  text        PRIMARY KEY,
  user_id     uuid        NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions(expires_at);

-- Supabase: tabele są dostępne tylko dla serwera aplikacji (połączenie bezpośrednie),
-- nie przez publiczne API Supabase. Włączenie RLS bez polityk blokuje dostęp z kluczem "anon".
ALTER TABLE users ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
