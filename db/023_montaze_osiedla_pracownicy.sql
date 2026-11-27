-- MXT – montaże na osiedlach i przydział pracowników (decyzja właściciela 27.11.2026). Idempotentna, tylko dodaje.
-- Montaż: firma zlecająca (CRM), osiedle / lokalizacja, adresy (jeden na linię), liczba budynków – zamiast jednego budynku z ewidencji.
-- Montaże sprzed zmiany (z budynkiem) działają jak dotąd: nazwa i adres brane z budynku, gdy pól osiedla brak.
-- Wykonawcy: pracownicy działu (dawniej „instalatorzy”) przydzielani do montażu – zamiast ekipy.

ALTER TABLE installations ADD COLUMN IF NOT EXISTS customer_id uuid REFERENCES customers(id);
ALTER TABLE installations ADD COLUMN IF NOT EXISTS site_name text NOT NULL DEFAULT '';
ALTER TABLE installations ADD COLUMN IF NOT EXISTS addresses text NOT NULL DEFAULT '';
ALTER TABLE installations ADD COLUMN IF NOT EXISTS buildings_count int CHECK (buildings_count IS NULL OR buildings_count >= 0);
ALTER TABLE installations ALTER COLUMN building_id DROP NOT NULL;   -- osiedle zamiast pojedynczego budynku (dotychczasowe wpisy bez zmian)
CREATE INDEX IF NOT EXISTS installations_customer_idx ON installations (customer_id);

-- Pracownicy działu (tabela installers): dział, stanowisko, e-mail.
ALTER TABLE installers ADD COLUMN IF NOT EXISTS department_id text NOT NULL DEFAULT 'podzielniki-i-montaze';
ALTER TABLE installers ADD COLUMN IF NOT EXISTS position text NOT NULL DEFAULT '';
ALTER TABLE installers ADD COLUMN IF NOT EXISTS email text NOT NULL DEFAULT '';

-- Przydział pracowników do montażu (wielu pracowników na montaż).
CREATE TABLE IF NOT EXISTS installation_workers (
  installation_id uuid NOT NULL REFERENCES installations(id) ON DELETE CASCADE,
  installer_id    uuid NOT NULL REFERENCES installers(id) ON DELETE CASCADE,
  assigned_by     uuid REFERENCES users(id),
  assigned_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, installer_id)
);
CREATE INDEX IF NOT EXISTS installation_workers_installer_idx ON installation_workers (installer_id);
ALTER TABLE installation_workers ENABLE ROW LEVEL SECURITY;

-- Wspólny rejestr zleceń: montaż bez budynku (osiedle) – nazwa, adres i klient z pól montażu; wykonawcy z przydziału pracowników.
CREATE OR REPLACE VIEW work_orders AS
SELECT 'montaz'::text AS type, x.id, x.number, x.project_id, coalesce(x.customer_id, b.customer_id) AS customer_id, x.building_id,
  coalesce(nullif(x.site_name, ''), b.name) AS object_name,
  coalesce(nullif(replace(x.addresses, E'\n', '; '), ''), b.address || CASE WHEN b.city <> '' THEN ', ' || b.city ELSE '' END) AS address, x.status AS raw_status,
  CASE WHEN x.status = 'anulowany' THEN 'anulowane' WHEN x.settled_at IS NOT NULL THEN 'rozliczone' WHEN x.status IN ('wykonany', 'odebrany') THEN 'wykonane'
       WHEN x.status = 'w_toku' THEN 'w_realizacji'
       WHEN x.crew_id IS NULL AND NOT EXISTS (SELECT 1 FROM installation_workers w WHERE w.installation_id = x.id) THEN 'do_przydzielenia' ELSE 'zaplanowane' END AS status,
  x.created_at::date AS received_at, x.planned_date, coalesce(x.planned_end, x.planned_date) AS due_date,
  NULL::uuid AS assignee_id, x.crew_id,
  coalesce((SELECT string_agg(i.name, ', ' ORDER BY i.name) FROM installation_workers w JOIN installers i ON i.id = w.installer_id WHERE w.installation_id = x.id), cr.name) AS assignee_name,
  x.settled_at, x.invoice_no, x.created_at
FROM installations x LEFT JOIN buildings b ON b.id = x.building_id LEFT JOIN crews cr ON cr.id = x.crew_id
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
