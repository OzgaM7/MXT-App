-- MXT ERP – etap 3 (fundamenty): nowe role, kartoteka pracownika na koncie, klient „osoba prywatna”,
-- zapisane widoki list, nazwy działów zgodne ze strukturą firmy. Idempotentna, tylko dodaje (bez usuwania danych).

-- ---------- role: właściciel, magazynier, księgowość, dostęp ograniczony ----------
-- Lista rozszerzana tylko, gdy nie zawiera jeszcze nowych ról (ponowne uruchomienie starszych migracji jej nie zawęzi).
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_role_check' AND pg_get_constraintdef(oid) LIKE '%magazynier%') THEN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
    ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('administrator', 'wlasciciel', 'uzytkownik', 'kierownik', 'rozliczajacy',
      'ksiegowosc', 'magazynier', 'monter', 'serwisant', 'odczyty', 'ograniczony'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_extra_roles_check' AND pg_get_constraintdef(oid) LIKE '%magazynier%') THEN
    ALTER TABLE users DROP CONSTRAINT IF EXISTS users_extra_roles_check;
    ALTER TABLE users ADD CONSTRAINT users_extra_roles_check CHECK (extra_roles <@ ARRAY['wlasciciel', 'uzytkownik', 'kierownik', 'rozliczajacy',
      'ksiegowosc', 'magazynier', 'monter', 'serwisant', 'odczyty']::text[]);
  END IF;
END $$;

-- ---------- kartoteka pracownika (na koncie użytkownika – jedna osoba = jedno konto) ----------
ALTER TABLE users ADD COLUMN IF NOT EXISTS position    text NOT NULL DEFAULT '';            -- stanowisko
ALTER TABLE users ADD COLUMN IF NOT EXISTS hourly_rate numeric(10, 2) CHECK (hourly_rate IS NULL OR hourly_rate >= 0);   -- koszt godziny pracy (PLN)
ALTER TABLE users ADD COLUMN IF NOT EXISTS employment  text NOT NULL DEFAULT '';            -- umowa o pracę / zlecenie / B2B
ALTER TABLE users ADD COLUMN IF NOT EXISTS hired_at    date;
ALTER TABLE users ADD COLUMN IF NOT EXISTS hr_notes    text NOT NULL DEFAULT '';

-- ---------- klienci: osoba prywatna (np. ubezpieczenia, serwis u lokatora) ----------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'customers_kind_check' AND pg_get_constraintdef(oid) LIKE '%osoba_prywatna%') THEN
    ALTER TABLE customers DROP CONSTRAINT IF EXISTS customers_kind_check;
    ALTER TABLE customers ADD CONSTRAINT customers_kind_check CHECK (kind IN ('osoba_prywatna', 'firma', 'wspolnota', 'spoldzielnia', 'zarzadca', 'klient_zagraniczny', 'inny'));
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS customers_name_idx ON customers (lower(name));
CREATE INDEX IF NOT EXISTS customers_phone_idx ON customers (phone) WHERE phone <> '';
CREATE INDEX IF NOT EXISTS customers_email_idx ON customers (lower(email)) WHERE email <> '';
CREATE INDEX IF NOT EXISTS service_orders_customer_idx ON service_orders (customer_id);
CREATE INDEX IF NOT EXISTS service_orders_building_idx ON service_orders (building_id);

-- ---------- zapisane widoki list (filtry i sortowanie użytkownika) ----------
CREATE TABLE IF NOT EXISTS user_views (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  module      text NOT NULL CHECK (module ~ '^[a-z0-9_.-]{2,60}$'),
  name        text NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  params      jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, module, name)
);
ALTER TABLE user_views ENABLE ROW LEVEL SECURITY;

-- ---------- nazwy działów zgodne ze strukturą firmy (identyfikatory i adresy bez zmian) ----------
UPDATE departments SET name = 'Ciepłomierze i podzielniki' WHERE id = 'podzielniki-i-montaze' AND name <> 'Ciepłomierze i podzielniki';
UPDATE departments SET name = 'Sprzedaż części samochodowych' WHERE id = 'sprzedaz-czesci-i-eksport' AND name <> 'Sprzedaż części samochodowych';
