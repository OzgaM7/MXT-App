-- MXT – poprawki po audycie produkcyjnym (24.11.2026). Idempotentna, tylko dodaje (kolumny, indeksy, rozszerzona lista wartości).

-- ---------- klienci: archiwizacja i anonimizacja (RODO) ----------
ALTER TABLE customers ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE customers ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES users(id);
ALTER TABLE customers ADD COLUMN IF NOT EXISTS archive_reason text NOT NULL DEFAULT '';
ALTER TABLE customers ADD COLUMN IF NOT EXISTS anonymized_at timestamptz;
CREATE INDEX IF NOT EXISTS customers_active_idx ON customers (lower(name)) WHERE archived_at IS NULL;

-- ---------- budynki: archiwizacja ----------
ALTER TABLE buildings ADD COLUMN IF NOT EXISTS archived_at timestamptz;
ALTER TABLE buildings ADD COLUMN IF NOT EXISTS archived_by uuid REFERENCES users(id);

-- ---------- historia polis: anulowanie błędnie wpisanej polisy ----------
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'policy_events_kind_check' AND pg_get_constraintdef(oid) LIKE '%anulowanie%') THEN
    ALTER TABLE policy_events DROP CONSTRAINT IF EXISTS policy_events_kind_check;
    ALTER TABLE policy_events ADD CONSTRAINT policy_events_kind_check CHECK (kind IN ('utworzenie', 'zmiana', 'odnowienie', 'zakonczenie', 'wznowienie', 'dokument',
      'przypomnienie', 'obsluga_przypomnienia', 'anulowanie', 'przywrocenie'));
  END IF;
END $$;

-- ---------- indeksy kluczy obcych używanych w zestawieniach i filtrach (audyt: Rentowność 14,7 s → 0,46 s) ----------
CREATE INDEX IF NOT EXISTS finance_building_idx ON finance (building_id);
CREATE INDEX IF NOT EXISTS finance_customer_idx ON finance (customer_id);
CREATE INDEX IF NOT EXISTS finance_offer_idx ON finance (offer_id);
CREATE INDEX IF NOT EXISTS finance_part_order_idx ON finance (part_order_id);
CREATE INDEX IF NOT EXISTS finance_reading_idx ON finance (reading_id);
CREATE INDEX IF NOT EXISTS finance_sale_idx ON finance (sale_id);
CREATE INDEX IF NOT EXISTS finance_invoice_idx ON finance (lower(trim(invoice_no))) WHERE invoice_no <> '';
CREATE INDEX IF NOT EXISTS installations_building_idx ON installations (building_id);
CREATE INDEX IF NOT EXISTS buildings_customer_idx ON buildings (customer_id);
CREATE INDEX IF NOT EXISTS complaints_building_idx ON complaints (building_id);
CREATE INDEX IF NOT EXISTS complaints_customer_idx ON complaints (customer_id);
CREATE INDEX IF NOT EXISTS complaints_installation_idx ON complaints (installation_id);
CREATE INDEX IF NOT EXISTS offers_customer_idx ON offers (customer_id);
CREATE INDEX IF NOT EXISTS projects_customer_idx ON projects (customer_id);
CREATE INDEX IF NOT EXISTS projects_manager_idx ON projects (manager_id);
CREATE INDEX IF NOT EXISTS reading_schedules_customer_idx ON reading_schedules (customer_id);
CREATE INDEX IF NOT EXISTS reading_schedules_project_idx ON reading_schedules (project_id);
CREATE INDEX IF NOT EXISTS reading_schedules_assigned_idx ON reading_schedules (assigned_to);
CREATE INDEX IF NOT EXISTS sales_history_customer_idx ON sales_history (customer_id);
CREATE INDEX IF NOT EXISTS service_orders_unit_idx ON service_orders (unit_id);
CREATE INDEX IF NOT EXISTS service_orders_complaint_idx ON service_orders (complaint_id);
CREATE INDEX IF NOT EXISTS stock_docs_customer_idx ON stock_docs (customer_id);
CREATE INDEX IF NOT EXISTS stock_docs_supplier_idx ON stock_docs (supplier_id);
CREATE INDEX IF NOT EXISTS stock_docs_warehouse_idx ON stock_docs (warehouse_id);
CREATE INDEX IF NOT EXISTS stock_items_supplier_idx ON stock_items (supplier_id);
CREATE INDEX IF NOT EXISTS stock_levels_item_idx ON stock_levels (item_id);
CREATE INDEX IF NOT EXISTS stock_moves_warehouse_idx ON stock_moves (warehouse_id);
CREATE INDEX IF NOT EXISTS stock_reservations_item_idx ON stock_reservations (item_id);
CREATE INDEX IF NOT EXISTS part_orders_warehouse_idx ON part_orders (warehouse_id);
CREATE INDEX IF NOT EXISTS part_returns_order_idx ON part_returns (order_id);
CREATE INDEX IF NOT EXISTS purchase_orders_supplier_idx ON purchase_orders (supplier_id);
CREATE INDEX IF NOT EXISTS purchase_order_lines_item_idx ON purchase_order_lines (item_id);
CREATE INDEX IF NOT EXISTS export_documents_customer_idx ON export_documents (customer_id);
CREATE INDEX IF NOT EXISTS mail_outbox_customer_idx ON mail_outbox (customer_id);
CREATE INDEX IF NOT EXISTS device_readings_reading_idx ON device_readings (reading_id);
CREATE INDEX IF NOT EXISTS tasks_department_idx ON tasks (department_id);
CREATE INDEX IF NOT EXISTS policies_previous_idx ON policies (previous_id);

-- ---------- dokumenty magazynowe: anulowanie błędnie wpisanego dokumentu (cofnięcie stanów, ślad kto i dlaczego) ----------
ALTER TABLE stock_docs ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE stock_docs ADD COLUMN IF NOT EXISTS cancelled_by uuid REFERENCES users(id);
ALTER TABLE stock_docs ADD COLUMN IF NOT EXISTS cancel_reason text NOT NULL DEFAULT '';

-- ---------- indeksy pozostałych kluczy obcych w dużych tabelach (autorzy wpisów, powiązania dokumentów) ----------
-- Przyspieszają sprawdzanie historii przy usuwaniu konta i kontrole kluczy obcych przy usuwaniu rekordów bez historii.
CREATE INDEX IF NOT EXISTS tasks_created_by_idx ON tasks (created_by);
CREATE INDEX IF NOT EXISTS installations_created_by_idx ON installations (created_by);
CREATE INDEX IF NOT EXISTS customers_created_by_idx ON customers (created_by);
CREATE INDEX IF NOT EXISTS communications_agent_id_idx ON communications (agent_id);
CREATE INDEX IF NOT EXISTS communications_created_by_idx ON communications (created_by);
CREATE INDEX IF NOT EXISTS documents_department_id_idx ON documents (department_id);
CREATE INDEX IF NOT EXISTS documents_created_by_idx ON documents (created_by);
CREATE INDEX IF NOT EXISTS buildings_created_by_idx ON buildings (created_by);
CREATE INDEX IF NOT EXISTS installations_protocol_document_id_idx ON installations (protocol_document_id);
CREATE INDEX IF NOT EXISTS devices_created_by_idx ON devices (created_by);
CREATE INDEX IF NOT EXISTS finance_created_by_idx ON finance (created_by);
CREATE INDEX IF NOT EXISTS service_orders_approved_by_idx ON service_orders (approved_by);
CREATE INDEX IF NOT EXISTS service_orders_protocol_document_id_idx ON service_orders (protocol_document_id);
CREATE INDEX IF NOT EXISTS service_orders_created_by_idx ON service_orders (created_by);
CREATE INDEX IF NOT EXISTS readings_done_by_idx ON readings (done_by);
CREATE INDEX IF NOT EXISTS readings_created_by_idx ON readings (created_by);
CREATE INDEX IF NOT EXISTS time_entries_created_by_idx ON time_entries (created_by);
CREATE INDEX IF NOT EXISTS stock_docs_to_warehouse_id_idx ON stock_docs (to_warehouse_id);
CREATE INDEX IF NOT EXISTS stock_docs_created_by_idx ON stock_docs (created_by);
CREATE INDEX IF NOT EXISTS policies_document_id_idx ON policies (document_id);
CREATE INDEX IF NOT EXISTS policies_renewed_by_idx ON policies (renewed_by);
CREATE INDEX IF NOT EXISTS policies_created_by_idx ON policies (created_by);
CREATE INDEX IF NOT EXISTS policy_events_created_by_idx ON policy_events (created_by);
CREATE INDEX IF NOT EXISTS part_orders_offer_id_idx ON part_orders (offer_id);
CREATE INDEX IF NOT EXISTS part_orders_wz_doc_id_idx ON part_orders (wz_doc_id);
CREATE INDEX IF NOT EXISTS part_orders_finance_id_idx ON part_orders (finance_id);
CREATE INDEX IF NOT EXISTS part_orders_sale_id_idx ON part_orders (sale_id);
CREATE INDEX IF NOT EXISTS part_orders_created_by_idx ON part_orders (created_by);
