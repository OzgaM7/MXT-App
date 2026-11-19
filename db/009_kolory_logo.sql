-- Kolorystyka z nowego logo MXT (czerń, czerwień MXT, złoto MXT Ubezpieczenia).
-- Domyślne kolory awatarów agentów: granat → czerń, fiolet → złoto, niebieski → czerwień MXT.
-- Zmieniane są tylko wartości dawnych domyślnych kolorów; kolory wybrane przez administratora z nowej palety zostają.
-- Migracja jest idempotentna (bezpieczne ponowne uruchomienie przy każdym wdrożeniu).
ALTER TABLE agent_settings ALTER COLUMN avatar_color SET DEFAULT '#1a1a1a';
UPDATE agent_settings SET avatar_color = CASE avatar_color
    WHEN '#141a3a' THEN '#1a1a1a'
    WHEN '#5b3fd1' THEN '#8a6d1f'
    WHEN '#1f6feb' THEN '#c8131c'
  END
  WHERE avatar_color IN ('#141a3a', '#5b3fd1', '#1f6feb');
