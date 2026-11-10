-- MXT: konta startowe. Hasło początkowe każdego konta: 1234 (zapisane wyłącznie jako hash bcrypt, koszt 12).
-- must_change_password = true: przygotowane do wymuszenia zmiany hasła w kolejnym etapie.
-- ON CONFLICT DO NOTHING: ponowne uruchomienie nie nadpisuje haseł zmienionych przez użytkowników.

INSERT INTO users (login, password_hash, must_change_password) VALUES
  ('m.ozga', '$2b$12$usHYM1fYIQfkvIYjq7adHuH/UkPGe17PDok4UFnN6DOnmzUQW5GKW', true),
  ('p.krajewski', '$2b$12$RSnnNYINoLGTP7WQleeG4.dvoHKkCHeyXRnT7fBocjQHZ/xEG5qEK', true),
  ('m.ozga1', '$2b$12$HrgsJ9Ip69fEEpqLlDhiw.tcNAhq8lJ1qlrHAq7.ZZBCihA/meUPS', true),
  ('k.kretkowska', '$2b$12$KEbNZoOfT7SML8wnzla/dOgYj8iW6hZOb5ZZbwHnq78kBDGYsRk8q', true)
ON CONFLICT (login) DO NOTHING;
