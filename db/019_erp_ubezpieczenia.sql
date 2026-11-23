-- MXT ERP – etap 6: Ubezpieczenia – wyłącznie rejestr podpisanych polis (bez ofert, kalkulatorów i integracji z towarzystwami).
-- Wspólna kartoteka klientów (customers), zysk = kwota polisy × marża % / 100 (kolumna wyliczana przez bazę, 2 miejsca po przecinku),
-- historia zmian, odnowienia potwierdzane przez użytkownika, przypomnienia 30 dni przed końcem ochrony (bez duplikatów).
-- Kwota polisy NIE jest przychodem MXT – nie trafia do tabeli finance (finance ma CHECK department_id <> 'ubezpieczenia').
-- Idempotentna, tylko dodaje.

CREATE TABLE IF NOT EXISTS policies (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number          text NOT NULL CHECK (length(number) BETWEEN 1 AND 60),
  customer_id     uuid NOT NULL REFERENCES customers(id),
  insurer         text NOT NULL CHECK (length(insurer) BETWEEN 2 AND 120),          -- towarzystwo ubezpieczeniowe
  insurance_type  text NOT NULL CHECK (length(insurance_type) BETWEEN 2 AND 80),    -- rodzaj ubezpieczenia
  description     text NOT NULL DEFAULT '',                                         -- zakres, przedmiot ubezpieczenia
  signed_at       date NOT NULL,
  start_date      date NOT NULL,
  end_date        date NOT NULL,
  total_amount    numeric(14, 2) NOT NULL CHECK (total_amount >= 0),               -- kwota całkowita polisy
  margin_pct      numeric(7, 4) NOT NULL CHECK (margin_pct >= 0 AND margin_pct <= 100),
  profit          numeric(14, 2) GENERATED ALWAYS AS (round(total_amount * margin_pct / 100, 2)) STORED,
  notes           text NOT NULL DEFAULT '',
  document_id     uuid REFERENCES documents(id),
  previous_id     uuid REFERENCES policies(id),                                     -- polisa, którą ta zastępuje (odnowienie)
  renewed_by      uuid REFERENCES policies(id),                                     -- nowa polisa, która zastąpiła tę
  renewed_at      timestamptz,
  closed_at       timestamptz,                                                      -- ręcznie oznaczona jako zakończona (np. klient nie odnawia)
  close_reason    text NOT NULL DEFAULT '',
  created_by      uuid REFERENCES users(id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CHECK (end_date >= start_date),
  CHECK (renewed_by IS NULL OR renewed_by <> id),
  CHECK (previous_id IS NULL OR previous_id <> id)
);
CREATE UNIQUE INDEX IF NOT EXISTS policies_insurer_number_uidx ON policies (lower(insurer), lower(number));
CREATE INDEX IF NOT EXISTS policies_customer_idx ON policies (customer_id);
CREATE INDEX IF NOT EXISTS policies_end_idx ON policies (end_date) WHERE renewed_by IS NULL AND closed_at IS NULL;

-- Historia zmian polisy (każda zmiana pól z wartością przed i po).
CREATE TABLE IF NOT EXISTS policy_events (
  id          bigserial PRIMARY KEY,
  policy_id   uuid NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  kind        text NOT NULL CHECK (kind IN ('utworzenie', 'zmiana', 'odnowienie', 'zakonczenie', 'wznowienie', 'dokument', 'przypomnienie', 'obsluga_przypomnienia')),
  changes     jsonb NOT NULL DEFAULT '{}'::jsonb,
  note        text NOT NULL DEFAULT '',
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS policy_events_policy_idx ON policy_events (policy_id, id DESC);

-- Przypomnienia: jedno na polisę i datę końca ochrony (zmiana daty końca = nowe przypomnienie dla nowej daty).
CREATE TABLE IF NOT EXISTS policy_reminders (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  policy_id     uuid NOT NULL REFERENCES policies(id) ON DELETE CASCADE,
  kind          text NOT NULL DEFAULT '30_dni' CHECK (kind IN ('30_dni')),
  end_date      date NOT NULL,                     -- data końca ochrony, której dotyczy przypomnienie
  due_date      date NOT NULL,                     -- planowany dzień przypomnienia (koniec − 30 dni)
  generated_on  date NOT NULL,                     -- dzień wygenerowania (Europe/Warsaw); później niż due_date = nadrobione po przerwie
  days_left     int NOT NULL,
  recipients    int NOT NULL DEFAULT 0,
  generated_at  timestamptz NOT NULL DEFAULT now(),
  handled_at    timestamptz,
  handled_by    uuid REFERENCES users(id),
  handled_note  text NOT NULL DEFAULT '',
  UNIQUE (policy_id, kind, end_date)
);
CREATE INDEX IF NOT EXISTS policy_reminders_open_idx ON policy_reminders (generated_at DESC) WHERE handled_at IS NULL;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['policies', 'policy_events', 'policy_reminders'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- Status liczony z dat (zawsze aktualny, także bez logowania): odnowiona > zakończona > zbliża się koniec (≤ 30 dni) > aktywna.
CREATE OR REPLACE VIEW policies_v AS
SELECT p.*, c.name AS customer_name, c.phone AS customer_phone, c.email AS customer_email, c.kind AS customer_kind,
  (p.end_date - (now() AT TIME ZONE 'Europe/Warsaw')::date) AS days_left,
  CASE WHEN p.renewed_by IS NOT NULL THEN 'odnowiona'
       WHEN p.closed_at IS NOT NULL OR p.end_date < (now() AT TIME ZONE 'Europe/Warsaw')::date THEN 'zakonczona'
       WHEN p.end_date - (now() AT TIME ZONE 'Europe/Warsaw')::date <= 30 THEN 'konczy_sie'
       ELSE 'aktywna' END AS status
FROM policies p JOIN customers c ON c.id = p.customer_id;
