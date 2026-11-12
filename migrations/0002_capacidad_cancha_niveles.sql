-- Decisiones del 2026-11-12:
-- 1. Cada deporte define las cantidades de jugadores permitidas (2, 4 o ambas);
--    quien abre el partido elige una.
-- 2. Un encuentro abierto no tiene cancha: se asigna al completarse. Si al
--    completarse no queda cancha, pasa a 'sin_cancha'. La restricción única de
--    cancha, fecha y hora aplica solo a encuentros confirmados.
-- 3. Quien abre el partido define los niveles que acepta.

-- ---------------------------------------------------------------
-- sports: players_per_match → match_sizes ("2", "4" o "2,4")
-- ---------------------------------------------------------------

ALTER TABLE sports ADD COLUMN match_sizes TEXT NOT NULL DEFAULT '2'
  CHECK (match_sizes IN ('2', '4', '2,4'));
UPDATE sports SET match_sizes = CAST(players_per_match AS TEXT);
ALTER TABLE sports DROP COLUMN players_per_match;

-- Pádel de ejemplo: se juega de a 2 o de a 4.
UPDATE sports SET match_sizes = '2,4' WHERE id = 'D-PAD01';

-- ---------------------------------------------------------------
-- games: court_id opcional, accepted_levels y estado 'sin_cancha'
-- ---------------------------------------------------------------
-- SQLite no permite cambiar columnas ni CHECK con ALTER TABLE: se reconstruye.
-- Al borrar la tabla vieja, ON DELETE CASCADE vaciaría players (incluso con
-- defer_foreign_keys), así que se respaldan antes y se restauran después.

CREATE TABLE players_backup AS SELECT * FROM players;

CREATE TABLE games_new (
  id              TEXT PRIMARY KEY CHECK (id LIKE 'E-%'),
  venue_id        TEXT NOT NULL REFERENCES venues(id),
  sport_id        TEXT NOT NULL REFERENCES sports(id),
  court_id        TEXT REFERENCES courts(id),
  date            TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  time            TEXT NOT NULL CHECK (time GLOB '[0-2][0-9]:[0-5][0-9]'),
  capacity        INTEGER NOT NULL CHECK (capacity IN (2, 4)),
  -- Niveles que acepta quien abrió el partido: "1,2,3" (1 avanzado ... 5 principiante).
  accepted_levels TEXT NOT NULL CHECK (length(accepted_levels) > 0),
  status          TEXT NOT NULL DEFAULT 'abierto'
                  CHECK (status IN ('abierto', 'sin_cancha', 'confirmado', 'cancelado')),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  -- Un encuentro confirmado siempre tiene cancha; uno abierto o sin cancha, nunca.
  CHECK (status <> 'confirmado' OR court_id IS NOT NULL),
  CHECK (status NOT IN ('abierto', 'sin_cancha') OR court_id IS NULL)
);

INSERT INTO games_new
  (id, venue_id, sport_id, court_id, date, time, capacity, accepted_levels, status, created_at)
SELECT id, venue_id, sport_id,
       CASE WHEN status IN ('confirmado', 'cancelado') THEN court_id END,
       date, time, capacity, '1,2,3,4,5', status, created_at
FROM games;

DROP TABLE games;
ALTER TABLE games_new RENAME TO games;

-- Defensa contra la doble reserva: una cancha, un encuentro confirmado por turno.
CREATE UNIQUE INDEX games_court_slot ON games(court_id, date, time)
  WHERE status = 'confirmado';
CREATE INDEX games_sport_date ON games(sport_id, date, time);

INSERT INTO players SELECT * FROM players_backup;
DROP TABLE players_backup;
