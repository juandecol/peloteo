-- Segundo factor del administrador (etapa 7): códigos TOTP de una app
-- autenticadora y códigos de respaldo de un solo uso.

-- Último paso de 30 segundos aceptado: un mismo código no se puede usar dos veces.
ALTER TABLE admins ADD COLUMN totp_last_step INTEGER;

-- Códigos de respaldo: se guarda solo el SHA-256 (con el ID del administrador
-- como prefijo), nunca el código. Cada uno sirve una vez.
CREATE TABLE admin_recovery_codes (
  id         TEXT PRIMARY KEY CHECK (id LIKE 'R-%'),
  admin_id   TEXT NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL UNIQUE,
  used_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX admin_recovery_codes_admin ON admin_recovery_codes(admin_id);
