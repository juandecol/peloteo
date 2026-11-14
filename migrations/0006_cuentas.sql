-- Cuentas de jugadores (preparadas, todavía desactivadas).
--
-- Hoy los jugadores no se registran: los identifica la cookie visitor_id.
-- Estas tablas dejan lista la base para cuentas opcionales con ingreso por
-- enlace enviado al correo (sin contraseñas). Mientras ACCOUNTS_ENABLED no
-- esté activo, nada las usa y el sitio funciona igual que antes.

CREATE TABLE users (
  id              TEXT PRIMARY KEY CHECK (id LIKE 'U-%'),
  -- Correo verificado (en minúsculas): es el identificador de la cuenta.
  email           TEXT NOT NULL UNIQUE,
  initials        TEXT,
  whatsapp        TEXT,
  whatsapp_opt_in INTEGER NOT NULL DEFAULT 0 CHECK (whatsapp_opt_in IN (0, 1)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  last_login_at   TEXT
);

-- Nivel del jugador por deporte (nombre normalizado, por ejemplo "tenis").
CREATE TABLE user_levels (
  user_id   TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  sport_key TEXT NOT NULL,
  level     INTEGER NOT NULL CHECK (level BETWEEN 1 AND 5),
  PRIMARY KEY (user_id, sport_key)
);

-- Enlaces de ingreso enviados por correo: se guarda solo el SHA-256 del token.
-- visitor_id es el navegador que lo pidió: sus partidos pasan a la cuenta.
CREATE TABLE login_links (
  id         TEXT PRIMARY KEY CHECK (id LIKE 'K-%'),
  email      TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  visitor_id TEXT,
  expires_at TEXT NOT NULL,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX login_links_email ON login_links(email, created_at);

-- Sesiones de jugadores: la base guarda el SHA-256 del token, no el token.
CREATE TABLE user_sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX user_sessions_user ON user_sessions(user_id);

-- Cada cupo puede pertenecer a una cuenta (nulo para quien juega sin cuenta).
ALTER TABLE players ADD COLUMN user_id TEXT REFERENCES users(id);
CREATE INDEX players_user ON players(user_id);
-- Una cuenta no puede ocupar dos cupos del mismo encuentro.
CREATE UNIQUE INDEX players_game_user ON players(game_id, user_id) WHERE user_id IS NOT NULL;
