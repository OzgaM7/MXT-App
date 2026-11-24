'use strict';
// Rentowność budynków, montaży i kontraktów (zakładka „Rentowność”, karty, eksport XLSX).
// Przychody: wpisy finansowe. Koszty: księga kosztów `cost_ledger` – koszty z finansów + materiały wydane z magazynu
// na zlecenie (RW − ZW, po średnim koszcie) + robocizna z ewidencji czasu. Ten sam sposób liczenia co karta projektu,
// pulpit działu i wyniki działów, więc liczby w różnych miejscach się zgadzają. Zakup na magazyn (PZ) nie jest kosztem.
// Wyrażenie SQL dla wiersza z aliasem `x`; `col` = building_id | installation_id | project_id.
const COLS = ['building_id', 'installation_id', 'project_id'];

function PROFIT(col) {
  if (!COLS.includes(col)) throw new Error('PROFIT: nieznana kolumna ' + col);
  const rev = `coalesce((SELECT sum(amount_pln) FROM finance f WHERE f.${col} = x.id AND f.kind = 'przychod'), 0)::float AS przychod`;
  if (col !== 'building_id') return `${rev}, coalesce((SELECT sum(l.amount) FROM cost_ledger l WHERE l.${col} = x.id), 0)::float AS koszt`;
  // Budynek: koszty z finansów przypisane do budynku + materiały i robocizna zleceń w tym budynku (montaże, serwisy, odczyty).
  return `${rev}, (coalesce((SELECT sum(amount_pln) FROM finance f WHERE f.building_id = x.id AND f.kind = 'koszt'), 0)
    + coalesce((SELECT sum(l.amount) FROM cost_ledger l WHERE l.source <> 'finanse' AND (
        l.installation_id IN (SELECT i.id FROM installations i WHERE i.building_id = x.id)
        OR l.service_order_id IN (SELECT s.id FROM service_orders s WHERE s.building_id = x.id)
        OR l.reading_id IN (SELECT r.id FROM readings r JOIN reading_schedules rs ON rs.id = r.schedule_id WHERE rs.building_id = x.id))), 0))::float AS koszt`;
}

module.exports = { PROFIT };
