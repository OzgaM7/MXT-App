-- MXT – ochrona przed nadpisaniem cudzych zmian (dwie osoby edytują ten sam wpis). Idempotentna, tylko dodaje.
-- Każdy edytowalny wpis ma znacznik ostatniej zmiany (updated_at), odświeżany automatycznie przy KAŻDEJ zmianie wiersza
-- (także zmianach systemowych). Formularz odsyła znacznik z chwili otwarcia; inny znacznik w bazie = ktoś zapisał w międzyczasie
-- i serwer odrzuca zapis (409) zamiast nadpisać.

ALTER TABLE units ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE devices ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE crews ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE installers ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE sales_history ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

CREATE OR REPLACE FUNCTION mxt_touch_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := clock_timestamp();
  RETURN NEW;
END $$;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['customers', 'buildings', 'installations', 'policies', 'service_orders', 'units', 'devices', 'crews', 'installers',
    'projects', 'offers', 'complaints', 'stock_items', 'suppliers', 'warehouses', 'part_orders', 'purchase_orders', 'reading_schedules',
    'users', 'tasks', 'sales_history'] LOOP
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = t AND column_name = 'updated_at') THEN
      EXECUTE format('DROP TRIGGER IF EXISTS %I ON %I', t || '_touch', t);
      EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION mxt_touch_updated_at()', t || '_touch', t);
    END IF;
  END LOOP;
END $$;
