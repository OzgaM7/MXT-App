-- Asystent telefoniczny (MXT Recepcja AI): rozmowy przekazane przez bota i zgłoszenia z telefonu.
-- Bot wysyła po każdej rozmowie jedno zdarzenie na POST /api/asystent/webhook (klucz w system_settings, tylko skrót).
-- Migracja uruchamia się przy każdym wdrożeniu – wszystkie polecenia są idempotentne.
CREATE TABLE IF NOT EXISTS phone_calls (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_sid               text NOT NULL UNIQUE,             -- identyfikator rozmowy u operatora (np. Twilio CallSid) – bez duplikatów
  started_at             timestamptz NOT NULL,
  ended_at               timestamptz,
  duration_s             int CHECK (duration_s >= 0),
  caller_phone           text NOT NULL DEFAULT '',
  department             text NOT NULL DEFAULT 'inne' CHECK (department IN ('podzielniki', 'ubezpieczenia', 'czesci', 'taxi', 'inne')),
  outcome                text NOT NULL DEFAULT 'informacja'
                         CHECK (outcome IN ('rezerwacja', 'zgloszenie', 'przekazanie', 'oddzwonienie', 'informacja', 'przerwana')),
  transferred            boolean NOT NULL DEFAULT false,   -- rozmowa przekazana pracownikowi
  summary                text NOT NULL DEFAULT '',
  transcript             jsonb,                            -- [{rola: asystent|klient, tekst, czas?}] – usuwana po okresie przechowywania
  transcript_deleted_at  timestamptz,
  avg_response_ms        int CHECK (avg_response_ms >= 0), -- średni czas odpowiedzi asystentki
  is_test                boolean NOT NULL DEFAULT false,   -- rozmowa testowa: bez zleceń i powiadomień, poza statystykami
  review_status          text NOT NULL DEFAULT 'nowa' CHECK (review_status IN ('nowa', 'sprawdzona', 'blad_danych')),
  review_note            text NOT NULL DEFAULT '',
  reviewed_by            uuid REFERENCES users(id),
  reviewed_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phone_calls_started_idx ON phone_calls(started_at DESC);
ALTER TABLE phone_calls ENABLE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS phone_requests (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id           uuid NOT NULL REFERENCES phone_calls(id) ON DELETE CASCADE,
  kind              text NOT NULL CHECK (kind IN ('wizyta_serwisowa', 'rozmowa_agent', 'zapytanie_czesci', 'oddzwonienie', 'taxi', 'inne')),
  department        text NOT NULL DEFAULT 'inne' CHECK (department IN ('podzielniki', 'ubezpieczenia', 'czesci', 'taxi', 'inne')),
  caller_name       text NOT NULL DEFAULT '',
  phone             text NOT NULL DEFAULT '',
  address           text NOT NULL DEFAULT '',
  city              text NOT NULL DEFAULT '',
  unit              text NOT NULL DEFAULT '',
  description       text NOT NULL DEFAULT '',
  details           jsonb NOT NULL DEFAULT '{}',           -- np. pojazd, VIN, część
  urgent            boolean NOT NULL DEFAULT false,
  slot_at           timestamptz,                           -- termin uzgodniony z klientem w rozmowie
  slot_minutes      int CHECK (slot_minutes BETWEEN 5 AND 480),
  status            text NOT NULL DEFAULT 'nowe' CHECK (status IN ('nowe', 'w_toku', 'zalatwione', 'anulowane')),
  note              text NOT NULL DEFAULT '',
  handled_by        uuid REFERENCES users(id),
  handled_at        timestamptz,
  service_order_id  uuid REFERENCES service_orders(id),    -- wizyta serwisowa → zlecenie w module Serwisy
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS phone_requests_status_idx ON phone_requests(status, created_at DESC);
CREATE INDEX IF NOT EXISTS phone_requests_call_idx ON phone_requests(call_id);
ALTER TABLE phone_requests ENABLE ROW LEVEL SECURITY;

-- Ustawienia: skrót klucza webhooka (sam klucz pokazywany jest raz), okres przechowywania transkrypcji (RODO, plan: 90 dni).
INSERT INTO system_settings (key, value) VALUES ('asystent', '{"retention_days": 90}') ON CONFLICT (key) DO NOTHING;
