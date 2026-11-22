-- Strefa GHOST: osobne hasło wejścia (konto powiązane z kontem MXT) i odblokowanie tylko w bieżącej sesji MXT.
-- Migracja uruchamia się przy każdym wdrożeniu – wszystkie polecenia są idempotentne.
CREATE TABLE IF NOT EXISTS ghost_accounts (
  user_id          uuid        PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  password_hash    text,                                -- NULL: hasło ustawia właściciel przy pierwszym wejściu
  is_active        boolean     NOT NULL DEFAULT true,
  created_at       timestamptz NOT NULL DEFAULT now(),
  password_set_at  timestamptz,
  last_login_at    timestamptz
);
ALTER TABLE ghost_accounts ENABLE ROW LEVEL SECURITY;

-- Do kiedy GHOST jest odblokowany w danej sesji (wylogowanie z MXT usuwa sesję, więc i odblokowanie).
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS ghost_until timestamptz;

-- Na start konto GHOST ma tylko m.ozga (tylko przy pierwszym wdrożeniu – później konta zmienia się świadomie).
INSERT INTO ghost_accounts (user_id)
  SELECT id FROM users WHERE login = 'm.ozga' AND NOT EXISTS (SELECT 1 FROM ghost_accounts)
  ON CONFLICT (user_id) DO NOTHING;
