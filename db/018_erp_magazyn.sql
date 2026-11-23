-- MXT ERP – etap 4/5: wspólny magazyn (materiały do montaży i serwisów, części samochodowe), dostawcy,
-- dokumenty magazynowe (PZ przyjęcie, WZ wydanie na zewnątrz, RW wydanie na zlecenie, ZW zwrot ze zlecenia, MM przesunięcie,
-- INW inwentaryzacja), rezerwacje; wspólny rejestr zleceń (widok) i księga kosztów (widok). Idempotentna, tylko dodaje.

CREATE TABLE IF NOT EXISTS suppliers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  tax_id        text NOT NULL DEFAULT '',
  email         text NOT NULL DEFAULT '',
  phone         text NOT NULL DEFAULT '',
  address       text NOT NULL DEFAULT '',
  contact       text NOT NULL DEFAULT '',
  payment_days  int NOT NULL DEFAULT 14 CHECK (payment_days BETWEEN 0 AND 365),
  notes         text NOT NULL DEFAULT '',
  is_active     boolean NOT NULL DEFAULT true,
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS suppliers_name_uidx ON suppliers (lower(name));

CREATE TABLE IF NOT EXISTS warehouses (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code        text NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9-]{1,12}$'),
  name        text NOT NULL,
  kind        text NOT NULL DEFAULT 'glowny' CHECK (kind IN ('glowny', 'samochod', 'punkt', 'inny')),
  is_active   boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);
INSERT INTO warehouses (code, name, kind) VALUES ('MAG', 'Magazyn główny', 'glowny') ON CONFLICT (code) DO NOTHING;

CREATE TABLE IF NOT EXISTS stock_items (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sku              text NOT NULL UNIQUE CHECK (length(sku) BETWEEN 1 AND 60),     -- indeks magazynowy
  name             text NOT NULL CHECK (length(name) BETWEEN 2 AND 200),
  kind             text NOT NULL DEFAULT 'material' CHECK (kind IN ('material', 'czesc', 'urzadzenie', 'inne')),
  department_id    text REFERENCES departments(id),                               -- NULL = wspólne
  unit             text NOT NULL DEFAULT 'szt.' CHECK (length(unit) BETWEEN 1 AND 10),
  category         text NOT NULL DEFAULT '',
  manufacturer     text NOT NULL DEFAULT '',
  catalog_no       text NOT NULL DEFAULT '',                                      -- numer katalogowy producenta
  replacement_nos  text[] NOT NULL DEFAULT '{}',                                  -- numery zamienników
  vehicle_type     text NOT NULL DEFAULT '' CHECK (vehicle_type IN ('', 'osobowe', 'ciezarowe', 'uniwersalne')),
  description      text NOT NULL DEFAULT '',
  purchase_price   numeric(14, 2) NOT NULL DEFAULT 0 CHECK (purchase_price >= 0), -- ostatnia cena zakupu netto
  sale_price       numeric(14, 2) NOT NULL DEFAULT 0 CHECK (sale_price >= 0),     -- cena sprzedaży netto
  avg_cost         numeric(14, 4) NOT NULL DEFAULT 0 CHECK (avg_cost >= 0),       -- średni ważony koszt zakupu (wycena wydań)
  min_qty          numeric(14, 3) NOT NULL DEFAULT 0 CHECK (min_qty >= 0),
  supplier_id      uuid REFERENCES suppliers(id),
  location         text NOT NULL DEFAULT '',                                      -- domyślna lokalizacja (regał, półka)
  is_active        boolean NOT NULL DEFAULT true,
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_items_name_idx ON stock_items (lower(name));
CREATE INDEX IF NOT EXISTS stock_items_catalog_idx ON stock_items (lower(catalog_no));

-- Stan w magazynie: ilość nie może spaść poniżej zera ani poniżej rezerwacji (kontrola w bazie, nie tylko w aplikacji).
CREATE TABLE IF NOT EXISTS stock_levels (
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  item_id       uuid NOT NULL REFERENCES stock_items(id),
  qty           numeric(14, 3) NOT NULL DEFAULT 0 CHECK (qty >= 0),
  reserved      numeric(14, 3) NOT NULL DEFAULT 0 CHECK (reserved >= 0),
  location      text NOT NULL DEFAULT '',
  PRIMARY KEY (warehouse_id, item_id),
  CHECK (reserved <= qty)
);

CREATE TABLE IF NOT EXISTS stock_docs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number           text NOT NULL UNIQUE,
  kind             text NOT NULL CHECK (kind IN ('PZ', 'WZ', 'RW', 'ZW', 'MM', 'INW')),
  doc_date         date NOT NULL DEFAULT current_date,
  warehouse_id     uuid NOT NULL REFERENCES warehouses(id),
  to_warehouse_id  uuid REFERENCES warehouses(id),          -- MM
  supplier_id      uuid REFERENCES suppliers(id),           -- PZ
  customer_id      uuid REFERENCES customers(id),           -- WZ
  invoice_no       text NOT NULL DEFAULT '',                -- PZ: faktura dostawcy (zobowiązanie)
  due_date         date,
  paid_at          date,
  project_id       uuid REFERENCES projects(id),
  related_type     text CHECK (related_type IS NULL OR related_type IN ('installation', 'service_order', 'reading', 'project', 'sale', 'purchase_order', 'part_order', 'part_return', 'inventory')),
  related_id       uuid,
  total_value      numeric(14, 2) NOT NULL DEFAULT 0,       -- wartość w cenach ewidencyjnych (zakupu)
  note             text NOT NULL DEFAULT '',
  status           text NOT NULL DEFAULT 'zatwierdzony' CHECK (status IN ('zatwierdzony', 'anulowany')),
  created_by       uuid REFERENCES users(id),
  created_at       timestamptz NOT NULL DEFAULT now(),
  CHECK (kind <> 'MM' OR (to_warehouse_id IS NOT NULL AND to_warehouse_id <> warehouse_id))
);
CREATE INDEX IF NOT EXISTS stock_docs_related_idx ON stock_docs (related_type, related_id);
CREATE INDEX IF NOT EXISTS stock_docs_project_idx ON stock_docs (project_id);
CREATE INDEX IF NOT EXISTS stock_docs_kind_date_idx ON stock_docs (kind, doc_date);

-- Pozycje ruchu: ilość ze znakiem (+ przyjęcie, − wydanie), wartość = ilość × koszt jednostkowy.
CREATE TABLE IF NOT EXISTS stock_moves (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doc_id        uuid NOT NULL REFERENCES stock_docs(id),
  item_id       uuid NOT NULL REFERENCES stock_items(id),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  qty           numeric(14, 3) NOT NULL CHECK (qty <> 0),
  unit_cost     numeric(14, 4) NOT NULL DEFAULT 0 CHECK (unit_cost >= 0),
  value         numeric(14, 2) NOT NULL DEFAULT 0,
  unit_price    numeric(14, 2),                              -- WZ: cena sprzedaży netto (przychód liczy moduł sprzedaży)
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stock_moves_item_idx ON stock_moves (item_id, created_at);
CREATE INDEX IF NOT EXISTS stock_moves_doc_idx ON stock_moves (doc_id);

CREATE TABLE IF NOT EXISTS stock_reservations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       uuid NOT NULL REFERENCES stock_items(id),
  warehouse_id  uuid NOT NULL REFERENCES warehouses(id),
  qty           numeric(14, 3) NOT NULL CHECK (qty > 0),
  related_type  text NOT NULL CHECK (related_type IN ('installation', 'service_order', 'project', 'part_order', 'inne')),
  related_id    uuid,
  status        text NOT NULL DEFAULT 'aktywna' CHECK (status IN ('aktywna', 'wydana', 'anulowana')),
  note          text NOT NULL DEFAULT '',
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  closed_at     timestamptz
);
CREATE INDEX IF NOT EXISTS stock_reservations_related_idx ON stock_reservations (related_type, related_id) WHERE status = 'aktywna';

ALTER TABLE reading_schedules ADD COLUMN IF NOT EXISTS project_id uuid REFERENCES projects(id);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['suppliers', 'warehouses', 'stock_items', 'stock_levels', 'stock_docs', 'stock_moves', 'stock_reservations'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ---------- wspólny rejestr zleceń: montaż, serwis, odczyt (wspólne statusy, terminy, osoby, rozliczenie) ----------
-- Procesy zostają w swoich tabelach (różne przebiegi); widok daje jedną listę, filtry i rozliczanie.
CREATE OR REPLACE VIEW work_orders AS
SELECT 'montaz'::text AS type, x.id, x.number, x.project_id, b.customer_id, x.building_id, b.name AS object_name,
  b.address || CASE WHEN b.city <> '' THEN ', ' || b.city ELSE '' END AS address, x.status AS raw_status,
  CASE WHEN x.status = 'anulowany' THEN 'anulowane' WHEN x.settled_at IS NOT NULL THEN 'rozliczone' WHEN x.status IN ('wykonany', 'odebrany') THEN 'wykonane'
       WHEN x.status = 'w_toku' THEN 'w_realizacji' WHEN x.crew_id IS NULL THEN 'do_przydzielenia' ELSE 'zaplanowane' END AS status,
  x.created_at::date AS received_at, x.planned_date, coalesce(x.planned_end, x.planned_date) AS due_date,
  NULL::uuid AS assignee_id, x.crew_id, cr.name AS assignee_name, x.settled_at, x.invoice_no, x.created_at
FROM installations x JOIN buildings b ON b.id = x.building_id LEFT JOIN crews cr ON cr.id = x.crew_id
UNION ALL
SELECT 'serwis', o.id, o.number, o.project_id, o.customer_id, o.building_id, coalesce(nullif(o.client_name, ''), b.name),
  o.address || CASE WHEN o.unit <> '' THEN ' lok. ' || o.unit ELSE '' END || CASE WHEN o.city <> '' THEN ', ' || o.city ELSE '' END, o.status,
  CASE o.status WHEN 'nowe' THEN 'nowe' WHEN 'oczekuje' THEN 'do_przydzielenia' WHEN 'przypisane' THEN 'przydzielone' WHEN 'zaplanowane' THEN 'zaplanowane'
    WHEN 'w_realizacji' THEN 'w_realizacji' WHEN 'ponowna_wizyta' THEN 'w_realizacji' WHEN 'wykonane' THEN 'wykonane' WHEN 'zatwierdzone' THEN 'wykonane'
    WHEN 'rozliczone' THEN 'rozliczone' WHEN 'zamkniete' THEN 'zamkniete' ELSE 'anulowane' END,
  o.received_at, o.planned_date, coalesce(o.due_date, CASE WHEN o.status IN ('nowe', 'oczekuje') THEN o.assign_due END),
  o.assigned_to, NULL::uuid, coalesce(nullif(u.full_name, ''), u.login), o.settled_at, o.invoice_no, o.created_at
FROM service_orders o LEFT JOIN buildings b ON b.id = o.building_id LEFT JOIN users u ON u.id = o.assigned_to
UNION ALL
SELECT 'odczyt', s.id, 'OD/' || to_char(s.next_due, 'YYYY/MM') || '/' || upper(substr(s.id::text, 1, 4)), s.project_id, coalesce(s.customer_id, b.customer_id), s.building_id, b.name,
  b.address || CASE WHEN b.city <> '' THEN ', ' || b.city ELSE '' END, 'zaplanowany',
  CASE WHEN s.assigned_to IS NULL THEN 'do_przydzielenia' ELSE 'zaplanowane' END,
  s.created_at::date, s.next_due, s.next_due, s.assigned_to, NULL::uuid, coalesce(nullif(u.full_name, ''), u.login), NULL::timestamptz, ''::text, s.created_at
FROM reading_schedules s JOIN buildings b ON b.id = s.building_id LEFT JOIN users u ON u.id = s.assigned_to WHERE s.is_active
UNION ALL
SELECT 'odczyt', r.id, 'OD/' || to_char(r.done_at, 'YYYY/MM') || '/' || upper(substr(r.id::text, 1, 4)), s.project_id, coalesce(s.customer_id, b.customer_id), s.building_id, b.name,
  b.address || CASE WHEN b.city <> '' THEN ', ' || b.city ELSE '' END, r.result,
  CASE WHEN r.settled_at IS NOT NULL THEN 'rozliczone' ELSE 'wykonane' END,
  r.created_at::date, r.done_at, r.due_date, r.done_by, NULL::uuid, coalesce(nullif(u.full_name, ''), u.login), r.settled_at, r.invoice_no, r.created_at
FROM readings r JOIN reading_schedules s ON s.id = r.schedule_id JOIN buildings b ON b.id = s.building_id LEFT JOIN users u ON u.id = r.done_by
WHERE r.cancelled_at IS NULL;

-- ---------- księga kosztów: finanse + materiały wydane na zlecenia (RW − ZW) + robocizna (czas pracy × stawka) ----------
-- Zakup na magazyn (PZ) nie jest kosztem – kosztem jest materiał wydany na zlecenie lub projekt (bez podwójnego liczenia).
CREATE OR REPLACE VIEW cost_ledger AS
SELECT 'finanse'::text AS source, f.id, f.department_id, f.entry_date AS cost_date, f.category, f.description, f.amount_pln AS amount,
  f.project_id, f.installation_id, f.service_order_id, f.reading_id
FROM finance f WHERE f.kind = 'koszt'
UNION ALL
SELECT 'magazyn', m.id, coalesce(p.department_id, i.department_id, 'podzielniki-i-montaze'), d.doc_date, 'materialy', d.number || ' · ' || i.name, round(-m.value, 2),
  d.project_id, CASE WHEN d.related_type = 'installation' THEN d.related_id END, CASE WHEN d.related_type = 'service_order' THEN d.related_id END,
  CASE WHEN d.related_type = 'reading' THEN d.related_id END
FROM stock_moves m JOIN stock_docs d ON d.id = m.doc_id JOIN stock_items i ON i.id = m.item_id LEFT JOIN projects p ON p.id = d.project_id
WHERE d.kind IN ('RW', 'ZW') AND d.status = 'zatwierdzony'
UNION ALL
SELECT 'czas', t.id, coalesce(p.department_id, CASE WHEN t.related_type IN ('installation', 'service_order', 'reading') THEN 'podzielniki-i-montaze' END), t.work_date, 'robocizna',
  'Czas pracy ' || t.hours || ' h', t.cost, t.project_id, CASE WHEN t.related_type = 'installation' THEN t.related_id END,
  CASE WHEN t.related_type = 'service_order' THEN t.related_id END, CASE WHEN t.related_type = 'reading' THEN t.related_id END
FROM time_entries t LEFT JOIN projects p ON p.id = t.project_id WHERE t.cost > 0;
