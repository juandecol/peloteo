-- Peloteo: esquema inicial y datos de ejemplo del prototipo.
-- Fechas como YYYY-MM-DD y horas como HH:MM, en hora local de Chile.
-- created_at se guarda en UTC (ISO 8601).

-- ---------------------------------------------------------------
-- Lugares, deportes, categorías y canchas
-- ---------------------------------------------------------------

CREATE TABLE venues (
  id         TEXT PRIMARY KEY CHECK (id LIKE 'L-%'),
  name       TEXT NOT NULL CHECK (length(trim(name)) > 0),
  address    TEXT NOT NULL DEFAULT '',
  maps_url   TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

CREATE TABLE sports (
  id                TEXT PRIMARY KEY CHECK (id LIKE 'D-%'),
  venue_id          TEXT NOT NULL REFERENCES venues(id),
  name              TEXT NOT NULL CHECK (length(trim(name)) > 0),
  players_per_match INTEGER NOT NULL CHECK (players_per_match IN (2, 4)),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX sports_venue ON sports(venue_id);

-- Nivel 1 = avanzado, 5 = principiante. Máximo 5 por deporte (uno por nivel).
CREATE TABLE categories (
  sport_id TEXT NOT NULL REFERENCES sports(id) ON DELETE CASCADE,
  level    INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
  label    TEXT NOT NULL CHECK (length(trim(label)) > 0),
  PRIMARY KEY (sport_id, level)
);

-- days: números separados por coma, 0 = domingo ... 6 = sábado.
CREATE TABLE courts (
  id             TEXT PRIMARY KEY CHECK (id LIKE 'C-%'),
  sport_id       TEXT NOT NULL REFERENCES sports(id),
  venue_id       TEXT NOT NULL REFERENCES venues(id),
  name           TEXT NOT NULL CHECK (length(trim(name)) > 0),
  surface        TEXT NOT NULL DEFAULT '',
  status         TEXT NOT NULL DEFAULT 'operativa'
                 CHECK (status IN ('operativa', 'mantencion', 'cerrada')),
  notes          TEXT NOT NULL DEFAULT '',
  maps_url       TEXT NOT NULL DEFAULT '',
  lat            REAL,
  lng            REAL,
  open_time      TEXT NOT NULL CHECK (open_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  close_time     TEXT NOT NULL CHECK (close_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  slot_minutes   INTEGER NOT NULL CHECK (slot_minutes IN (60, 90, 120)),
  days           TEXT NOT NULL DEFAULT '0,1,2,3,4,5,6',
  available_from TEXT,
  available_to   TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  CHECK (close_time > open_time),
  CHECK (available_from IS NULL OR available_to IS NULL OR available_from <= available_to)
);
CREATE INDEX courts_sport ON courts(sport_id);

-- ---------------------------------------------------------------
-- Encuentros y cupos
-- ---------------------------------------------------------------

CREATE TABLE games (
  id         TEXT PRIMARY KEY CHECK (id LIKE 'E-%'),
  venue_id   TEXT NOT NULL REFERENCES venues(id),
  sport_id   TEXT NOT NULL REFERENCES sports(id),
  court_id   TEXT NOT NULL REFERENCES courts(id),
  date       TEXT NOT NULL CHECK (date GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
  time       TEXT NOT NULL CHECK (time GLOB '[0-2][0-9]:[0-5][0-9]'),
  capacity   INTEGER NOT NULL CHECK (capacity IN (2, 4)),
  status     TEXT NOT NULL DEFAULT 'abierto'
             CHECK (status IN ('abierto', 'confirmado', 'cancelado')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
-- Defensa contra la doble reserva: un solo encuentro vigente por cancha y turno.
CREATE UNIQUE INDEX games_court_slot ON games(court_id, date, time)
  WHERE status <> 'cancelado';
CREATE INDEX games_sport_date ON games(sport_id, date);

CREATE TABLE players (
  id              TEXT PRIMARY KEY CHECK (id LIKE 'J-%'),
  game_id         TEXT NOT NULL REFERENCES games(id) ON DELETE CASCADE,
  visitor_id      TEXT NOT NULL,
  initials        TEXT NOT NULL CHECK (length(initials) BETWEEN 2 AND 4),
  level           INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
  email           TEXT NOT NULL,
  whatsapp        TEXT,
  whatsapp_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (whatsapp_opt_in IN (0, 1)),
  cancel_token    TEXT NOT NULL UNIQUE,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  UNIQUE (game_id, visitor_id)
);
CREATE INDEX players_visitor ON players(visitor_id);

-- ---------------------------------------------------------------
-- Administración
-- ---------------------------------------------------------------

-- password_hash: "pbkdf2-sha256$<iteraciones>$<hash hex>"; password_salt en hex.
CREATE TABLE admins (
  id                   TEXT PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE,
  password_hash        TEXT NOT NULL,
  password_salt        TEXT NOT NULL,
  totp_secret          TEXT,
  totp_enabled         INTEGER NOT NULL DEFAULT 0 CHECK (totp_enabled IN (0, 1)),
  must_change_password INTEGER NOT NULL DEFAULT 1 CHECK (must_change_password IN (0, 1))
);

CREATE TABLE sessions (
  id                   TEXT PRIMARY KEY,
  admin_id             TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  expires_at           TEXT NOT NULL,
  second_factor_passed INTEGER NOT NULL DEFAULT 0 CHECK (second_factor_passed IN (0, 1))
);
CREATE INDEX sessions_admin ON sessions(admin_id);

CREATE TABLE login_attempts (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  username   TEXT NOT NULL,
  ip         TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX login_attempts_lookup ON login_attempts(username, ip, created_at);

-- Administrador inicial admin / admin (PBKDF2-SHA256, 100.000 iteraciones).
-- must_change_password obliga a cambiarla en el primer ingreso.
INSERT INTO admins (id, username, password_hash, password_salt, must_change_password) VALUES
  ('A-ADMIN', 'admin',
   'pbkdf2-sha256$100000$6b47c5bcc56e6c12a030cd4d3e1f12da3f83b9a8e36de43793d907f86bce0245',
   '6c1bd7cceababff49ae5eae997e61946', 1);

-- ---------------------------------------------------------------
-- Datos de ejemplo (los mismos del prototipo)
-- ---------------------------------------------------------------

INSERT INTO venues (id, name, address, maps_url) VALUES
  ('L-SM001', 'Country Club Santa Martina', 'Lo Barnechea, Santiago',
   'https://www.google.com/maps/search/?api=1&query=Country+Club+Santa+Martina'),
  ('L-AR002', 'Club Los Aromos (ejemplo)', 'La Reina, Santiago', '');

INSERT INTO sports (id, venue_id, name, players_per_match) VALUES
  ('D-TEN01', 'L-SM001', 'Tenis', 2),
  ('D-PAD01', 'L-SM001', 'Pádel', 4),
  ('D-TEN02', 'L-AR002', 'Tenis', 2);

INSERT INTO categories (sport_id, level, label) VALUES
  ('D-TEN01', 1, 'Estoy entrenando para Wimbledon'),
  ('D-TEN01', 2, 'Compito en torneos del club'),
  ('D-TEN01', 3, 'Juego sets y a veces gano'),
  ('D-TEN01', 4, 'Peloteo sin drama'),
  ('D-TEN01', 5, 'Apenas logro pasar la pelota'),
  ('D-PAD01', 1, 'Me falta poco para el circuito pro'),
  ('D-PAD01', 2, 'Juego ligas y torneos'),
  ('D-PAD01', 3, 'Armo puntos y uso las paredes'),
  ('D-PAD01', 4, 'Las paredes me usan a mí'),
  ('D-PAD01', 5, 'Todavía le pego con el marco'),
  ('D-TEN02', 1, 'Estoy entrenando para Wimbledon'),
  ('D-TEN02', 2, 'Compito en torneos del club'),
  ('D-TEN02', 3, 'Juego sets y a veces gano'),
  ('D-TEN02', 4, 'Peloteo sin drama'),
  ('D-TEN02', 5, 'Apenas logro pasar la pelota');

INSERT INTO courts (id, sport_id, venue_id, name, surface, status, notes, open_time, close_time, slot_minutes, days) VALUES
  ('C-T1SM1', 'D-TEN01', 'L-SM001', 'Cancha 1', 'Arcilla',           'operativa',  'Con iluminación',    '08:00', '21:00', 60, '0,1,2,3,4,5,6'),
  ('C-T2SM2', 'D-TEN01', 'L-SM001', 'Cancha 2', 'Arcilla',           'operativa',  '',                   '08:00', '21:00', 60, '0,1,2,3,4,5,6'),
  ('C-T3SM3', 'D-TEN01', 'L-SM001', 'Cancha 3', 'Carpeta sintética', 'mantencion', 'Techada',            '08:00', '21:00', 60, '0,1,2,3,4,5,6'),
  ('C-PASM4', 'D-PAD01', 'L-SM001', 'Cancha A', 'Césped sintético',  'operativa',  'Paredes de cristal', '08:00', '21:00', 90, '0,1,2,3,4,5,6'),
  ('C-PBSM5', 'D-PAD01', 'L-SM001', 'Cancha B', 'Césped sintético',  'operativa',  '',                   '08:00', '21:00', 90, '0,1,2,3,4,5,6'),
  ('C-T1AR6', 'D-TEN02', 'L-AR002', 'Cancha 1', 'Cemento',           'operativa',  '',                   '08:00', '21:00', 60, '0,1,2,3,4,5,6');

-- Encuentros de ejemplo a 1 y 2 días de la fecha en que se aplica la migración.
-- La fecha local se aproxima con UTC-3 (horario de verano de Chile).
INSERT INTO games (id, venue_id, sport_id, court_id, date, time, capacity, status) VALUES
  ('E-DEMO1', 'L-SM001', 'D-TEN01', 'C-T1SM1', date('now', '-3 hours', '+1 day'), '18:00', 2, 'abierto'),
  ('E-DEMO2', 'L-SM001', 'D-TEN01', 'C-T2SM2', date('now', '-3 hours', '+2 days'), '10:00', 2, 'abierto'),
  ('E-DEMO3', 'L-SM001', 'D-PAD01', 'C-PASM4', date('now', '-3 hours', '+2 days'), '18:30', 4, 'abierto');

INSERT INTO players (id, game_id, visitor_id, initials, level, email, cancel_token) VALUES
  ('J-DEMO1', 'E-DEMO1', 'V-DEMO1', 'MT', 3, 'mt@example.com', lower(hex(randomblob(16)))),
  ('J-DEMO2', 'E-DEMO2', 'V-DEMO2', 'RS', 4, 'rs@example.com', lower(hex(randomblob(16)))),
  ('J-DEMO3', 'E-DEMO3', 'V-DEMO3', 'CP', 3, 'cp@example.com', lower(hex(randomblob(16)))),
  ('J-DEMO4', 'E-DEMO3', 'V-DEMO4', 'AL', 3, 'al@example.com', lower(hex(randomblob(16)))),
  ('J-DEMO5', 'E-DEMO3', 'V-DEMO5', 'JV', 2, 'jv@example.com', lower(hex(randomblob(16))));
