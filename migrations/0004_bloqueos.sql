-- Bloqueos de canchas: el administrador bloquea una cancha en una fecha y un
-- rango de horas (por ejemplo, una reserva hecha por otro canal). Un turno que
-- se cruza con un bloqueo no se ofrece ni se asigna.

CREATE TABLE court_blocks (
  id         TEXT PRIMARY KEY CHECK (id LIKE 'B-%'),
  court_id   TEXT NOT NULL REFERENCES courts(id),
  date       TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  start_time TEXT NOT NULL CHECK (start_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  end_time   TEXT NOT NULL CHECK (end_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  reason     TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CHECK (end_time > start_time)
);
CREATE INDEX court_blocks_court_date ON court_blocks(court_id, date);
