-- Rozbudowa działu Podzielniki i Montaże – zlecenia serwisowe (osobny proces, niezależny od dużych montaży).
-- Termin przydzielenia serwisanta: 14 dni kalendarzowych od daty otrzymania (assign_due), termin realizacji – osobna wartość (due_date).
-- Status realizacji jest oddzielony od informacji o przekroczeniu terminów (te są wyliczane, nie zapisywane jako status).
-- Idempotentna, nie usuwa danych.

-- ---------- rola serwisanta ----------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check' AND pg_get_constraintdef(oid) LIKE '%serwisant%') THEN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('administrator', 'uzytkownik', 'kierownik', 'rozliczajacy', 'monter', 'serwisant'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_extra_roles_check' AND pg_get_constraintdef(oid) LIKE '%serwisant%') THEN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_extra_roles_check;
    ALTER TABLE users ADD CONSTRAINT users_extra_roles_check CHECK (extra_roles <@ ARRAY['uzytkownik', 'kierownik', 'rozliczajacy', 'monter', 'serwisant']::text[]);
  END IF;
END $$;

-- ---------- zlecenia serwisowe ----------
CREATE TABLE IF NOT EXISTS service_orders (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number                text NOT NULL UNIQUE,                       -- SR/2026/001
  received_at           date NOT NULL DEFAULT current_date,         -- data otrzymania zgłoszenia
  assign_due            date NOT NULL,                              -- termin graniczny przydzielenia serwisanta
  due_date              date,                                       -- termin realizacji (osobno od terminu przydzielenia)
  planned_date          date,                                       -- zaplanowana wizyta
  priority              text NOT NULL DEFAULT 'normalny' CHECK (priority IN ('niski', 'normalny', 'wysoki', 'pilny')),
  status                text NOT NULL DEFAULT 'nowe' CHECK (status IN ('nowe', 'oczekuje', 'przypisane', 'zaplanowane', 'w_realizacji',
                          'ponowna_wizyta', 'wykonane', 'zatwierdzone', 'anulowane')),
  customer_id           uuid REFERENCES customers(id),
  building_id           uuid REFERENCES buildings(id),
  complaint_id          uuid REFERENCES complaints(id),
  client_name           text NOT NULL DEFAULT '',
  address               text NOT NULL DEFAULT '',
  city                  text NOT NULL DEFAULT '',
  unit                  text NOT NULL DEFAULT '',                   -- lokal / mieszkanie
  contact_name          text NOT NULL DEFAULT '',
  contact_phone         text NOT NULL DEFAULT '',
  contact_email         text NOT NULL DEFAULT '',
  description           text NOT NULL CHECK (length(description) BETWEEN 3 AND 4000),
  assigned_to           uuid REFERENCES users(id),
  assigned_at           timestamptz,
  completed_at          timestamptz,
  approved_at           timestamptz,
  approved_by           uuid REFERENCES users(id),
  cancel_reason         text NOT NULL DEFAULT '',
  protocol_document_id  uuid REFERENCES documents(id),
  signature_png         bytea,                                      -- podpis potwierdzającego (protokół)
  created_by            uuid REFERENCES users(id),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CHECK (assign_due >= received_at),
  CHECK (status IN ('nowe', 'oczekuje', 'anulowane') OR assigned_to IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS service_orders_status_idx ON service_orders(status);
CREATE INDEX IF NOT EXISTS service_orders_assignee_idx ON service_orders(assigned_to, status);
CREATE INDEX IF NOT EXISTS service_orders_unassigned_idx ON service_orders(assign_due) WHERE status IN ('nowe', 'oczekuje');

-- Historia działań (tylko dopisywanie): zmiany statusu, przydziały, terminy, notatki, czynności, zdjęcia, protokół.
CREATE TABLE IF NOT EXISTS service_events (
  id           bigserial PRIMARY KEY,
  order_id     uuid NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
  kind         text NOT NULL,
  from_status  text,
  to_status    text,
  note         text NOT NULL DEFAULT '',
  data         jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by   uuid REFERENCES users(id),
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_events_order_idx ON service_events(order_id, id);

-- Zdjęcia z telefonu (zmniejszane przed wysłaniem do ok. 1600 px).
CREATE TABLE IF NOT EXISTS service_photos (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id    uuid NOT NULL REFERENCES service_orders(id) ON DELETE CASCADE,
  mime        text NOT NULL CHECK (mime IN ('image/jpeg', 'image/png', 'image/webp')),
  data        bytea NOT NULL,
  size        int NOT NULL,
  caption     text NOT NULL DEFAULT '',
  created_by  uuid REFERENCES users(id),
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS service_photos_order_idx ON service_photos(order_id, created_at);

-- Ustawienia: termin przydzielenia (dni kalendarzowe) i przypomnienia (ile dni przed terminem).
INSERT INTO system_settings (key, value) VALUES ('service', '{"assign_days": 14, "remind_days": [3, 1]}') ON CONFLICT (key) DO NOTHING;

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['service_orders', 'service_events', 'service_photos'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;
