-- MXT ERP – etap 7 i 5: sprzedaż części samochodowych (zamówienia z rezerwacją, wydanie WZ, faktura, płatność, zwroty,
-- reklamacje) oraz zakupy (zamówienia do dostawców, przyjęcia częściowe). Księga kosztów rozszerzona o koszt sprzedanych części.
-- Idempotentna, tylko dodaje.

CREATE TABLE IF NOT EXISTS part_orders (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number            text NOT NULL UNIQUE,
  customer_id       uuid NOT NULL REFERENCES customers(id),
  warehouse_id      uuid NOT NULL REFERENCES warehouses(id),
  status            text NOT NULL DEFAULT 'nowe' CHECK (status IN ('nowe', 'potwierdzone', 'wydane', 'zafakturowane', 'anulowane')),
  order_date        date NOT NULL DEFAULT current_date,
  offer_id          uuid REFERENCES offers(id),
  vehicle           text NOT NULL DEFAULT '',                  -- pojazd: marka, model, VIN
  note              text NOT NULL DEFAULT '',
  total_net         numeric(14, 2) NOT NULL DEFAULT 0,
  total_cost        numeric(14, 2) NOT NULL DEFAULT 0,         -- koszt sprzedanych części (wycena wydania WZ)
  wz_doc_id         uuid REFERENCES stock_docs(id),
  invoice_no        text NOT NULL DEFAULT '',
  invoice_date      date,
  due_date          date,
  paid_at           date,
  finance_id        uuid REFERENCES finance(id),
  sale_id           uuid REFERENCES sales_history(id),
  cancel_reason     text NOT NULL DEFAULT '',
  created_by        uuid REFERENCES users(id),
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS part_orders_customer_idx ON part_orders (customer_id);
CREATE INDEX IF NOT EXISTS part_orders_status_idx ON part_orders (status, order_date);

CREATE TABLE IF NOT EXISTS part_order_lines (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id        uuid NOT NULL REFERENCES part_orders(id) ON DELETE CASCADE,
  item_id         uuid NOT NULL REFERENCES stock_items(id),
  qty             numeric(14, 3) NOT NULL CHECK (qty > 0),
  unit_price      numeric(14, 2) NOT NULL CHECK (unit_price >= 0),                 -- cena sprzedaży netto
  discount_pct    numeric(5, 2) NOT NULL DEFAULT 0 CHECK (discount_pct BETWEEN 0 AND 100),
  line_net        numeric(14, 2) GENERATED ALWAYS AS (round(qty * unit_price * (100 - discount_pct) / 100, 2)) STORED,
  reservation_id  uuid REFERENCES stock_reservations(id),
  unit_cost       numeric(14, 4),                                                  -- koszt jednostkowy w chwili wydania
  returned_qty    numeric(14, 3) NOT NULL DEFAULT 0 CHECK (returned_qty >= 0),
  CHECK (returned_qty <= qty)
);
CREATE INDEX IF NOT EXISTS part_order_lines_order_idx ON part_order_lines (order_id);
CREATE INDEX IF NOT EXISTS part_order_lines_item_idx ON part_order_lines (item_id);

CREATE TABLE IF NOT EXISTS part_returns (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number        text NOT NULL UNIQUE,
  order_id      uuid NOT NULL REFERENCES part_orders(id),
  return_date   date NOT NULL DEFAULT current_date,
  reason        text NOT NULL CHECK (length(reason) BETWEEN 2 AND 1000),
  restock       boolean NOT NULL DEFAULT true,                 -- towar wraca na stan (sprawny) albo nie (wadliwy)
  refund_net    numeric(14, 2) NOT NULL DEFAULT 0 CHECK (refund_net >= 0),
  lines         jsonb NOT NULL DEFAULT '[]'::jsonb,            -- [{line_id, item_id, qty, unit_price, unit_cost}]
  stock_doc_id  uuid REFERENCES stock_docs(id),
  finance_id    uuid REFERENCES finance(id),
  created_by    uuid REFERENCES users(id),
  created_at    timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE finance ADD COLUMN IF NOT EXISTS part_order_id uuid REFERENCES part_orders(id);
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS part_order_id uuid REFERENCES part_orders(id);

-- ---------- zakupy: zamówienia do dostawców, przyjęcia (PZ) częściowe ----------
CREATE TABLE IF NOT EXISTS purchase_orders (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  number         text NOT NULL UNIQUE,
  supplier_id    uuid NOT NULL REFERENCES suppliers(id),
  warehouse_id   uuid NOT NULL REFERENCES warehouses(id),
  status         text NOT NULL DEFAULT 'szkic' CHECK (status IN ('szkic', 'zamowione', 'czesciowo', 'przyjete', 'anulowane')),
  order_date     date NOT NULL DEFAULT current_date,
  expected_date  date,
  note           text NOT NULL DEFAULT '',
  total_net      numeric(14, 2) NOT NULL DEFAULT 0,
  created_by     uuid REFERENCES users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS purchase_order_lines (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id      uuid NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  item_id       uuid NOT NULL REFERENCES stock_items(id),
  qty           numeric(14, 3) NOT NULL CHECK (qty > 0),
  unit_price    numeric(14, 2) NOT NULL CHECK (unit_price >= 0),
  received_qty  numeric(14, 3) NOT NULL DEFAULT 0 CHECK (received_qty >= 0)
);
CREATE INDEX IF NOT EXISTS purchase_order_lines_order_idx ON purchase_order_lines (order_id);

DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['part_orders', 'part_order_lines', 'part_returns', 'purchase_orders', 'purchase_order_lines'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
  END LOOP;
END $$;

-- ---------- księga kosztów: + koszt sprzedanych części (WZ) i jego korekta przy zwrocie na stan (ZW do zwrotu klienta) ----------
CREATE OR REPLACE VIEW cost_ledger AS
SELECT 'finanse'::text AS source, f.id, f.department_id, f.entry_date AS cost_date, f.category, f.description, f.amount_pln AS amount,
  f.project_id, f.installation_id, f.service_order_id, f.reading_id
FROM finance f WHERE f.kind = 'koszt'
UNION ALL
SELECT 'magazyn', m.id,
  CASE WHEN d.kind = 'WZ' OR d.related_type IN ('part_order', 'part_return') THEN coalesce(i.department_id, 'sprzedaz-czesci-i-eksport')
       ELSE coalesce(p.department_id, i.department_id, 'podzielniki-i-montaze') END,
  d.doc_date, CASE WHEN d.kind = 'WZ' OR d.related_type IN ('part_order', 'part_return') THEN 'koszt_sprzedanych' ELSE 'materialy' END,
  d.number || ' · ' || i.name, round(-m.value, 2),
  d.project_id, CASE WHEN d.related_type = 'installation' THEN d.related_id END, CASE WHEN d.related_type = 'service_order' THEN d.related_id END,
  CASE WHEN d.related_type = 'reading' THEN d.related_id END
FROM stock_moves m JOIN stock_docs d ON d.id = m.doc_id JOIN stock_items i ON i.id = m.item_id LEFT JOIN projects p ON p.id = d.project_id
WHERE d.kind IN ('RW', 'ZW', 'WZ') AND d.status = 'zatwierdzony'
UNION ALL
SELECT 'czas', t.id, coalesce(p.department_id, CASE WHEN t.related_type IN ('installation', 'service_order', 'reading') THEN 'podzielniki-i-montaze' END), t.work_date, 'robocizna',
  'Czas pracy ' || t.hours || ' h', t.cost, t.project_id, CASE WHEN t.related_type = 'installation' THEN t.related_id END,
  CASE WHEN t.related_type = 'service_order' THEN t.related_id END, CASE WHEN t.related_type = 'reading' THEN t.related_id END
FROM time_entries t LEFT JOIN projects p ON p.id = t.project_id WHERE t.cost > 0;
