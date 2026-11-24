#!/bin/sh
# Kopia zapasowa bazy MXT (pg_dump, format „custom”) i sprawdzenie, czy plik da się odczytać.
# Adres bazy podaj w zmiennej DATABASE_URL (na Render: baza → Connections → External Database URL).
# Adresu ani hasła nie zapisuj w tym pliku ani w repozytorium.
#
#   DATABASE_URL='postgresql://…' sh scripts/kopia-bazy.sh            → mxt-RRRRMMDD-GGMM.dump
#   DATABASE_URL='postgresql://…' sh scripts/kopia-bazy.sh plik.dump  → własna nazwa pliku
#
# Odtworzenie do NOWEJ, pustej bazy (nigdy na działającą produkcję bez uzgodnienia):
#   pg_restore --no-owner --no-acl -d 'postgresql://…nowa-baza' plik.dump
set -eu
: "${DATABASE_URL:?Ustaw DATABASE_URL (External Database URL bazy)}"
command -v pg_dump >/dev/null || { echo "Brak pg_dump – zainstaluj klienta PostgreSQL (wersja co najmniej taka jak serwera)."; exit 1; }
out="${1:-mxt-$(date +%Y%m%d-%H%M).dump}"
pg_dump --no-owner --no-acl -Fc -f "$out" "$DATABASE_URL"
tables=$(pg_restore -l "$out" | grep -c ' TABLE DATA ')
echo "Kopia zapisana: $out ($(du -h "$out" | cut -f1)), tabel z danymi: $tables"
