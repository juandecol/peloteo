-- Modo "coordinación" (2026-11-14): mientras Peloteo no esté conectado al
-- sistema de reservas de los clubes, un partido completo se confirma SIN
-- cancha asignada (los jugadores la reservan con el club). Se quita la regla
-- "un encuentro confirmado siempre tiene cancha"; se mantiene "uno abierto o
-- sin cancha nunca tiene cancha" y la restricción única para confirmados con cancha.
--
-- SQLite no permite cambiar un CHECK con ALTER TABLE: se reconstruye games.
-- Al borrar la tabla vieja, ON DELETE CASCADE vaciaría players, así que se
-- respaldan antes y se restauran después (igual que en 0002).

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
  -- Un encuentro abierto o sin cancha nunca tiene cancha. Uno confirmado puede
  -- tenerla (modo reserva) o no (modo coordinación).
  CHECK (status NOT IN ('abierto', 'sin_cancha') OR court_id IS NULL)
);

INSERT INTO games_new
  (id, venue_id, sport_id, court_id, date, time, capacity, accepted_levels, status, created_at)
SELECT id, venue_id, sport_id, court_id, date, time, capacity, accepted_levels, status, created_at
FROM games;

DROP TABLE games;
ALTER TABLE games_new RENAME TO games;

-- Defensa contra la doble reserva: una cancha, un encuentro confirmado por turno
-- (no aplica a los confirmados sin cancha: NULL no se compara).
CREATE UNIQUE INDEX games_court_slot ON games(court_id, date, time)
  WHERE status = 'confirmado';
CREATE INDEX games_sport_date ON games(sport_id, date, time);

INSERT INTO players SELECT * FROM players_backup;
DROP TABLE players_backup;
