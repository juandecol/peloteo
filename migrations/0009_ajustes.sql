-- Ajustes del sitio que el administrador cambia desde Configuración (2026-11-14).
-- Cada ajuste es una fila clave/valor; los valores son texto ("1" o "0" para sí/no).

CREATE TABLE settings (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Pedir el WhatsApp de los jugadores en el formulario (para que los compañeros
-- de un partido confirmado se escriban). Apagado hasta que el administrador lo active.
INSERT INTO settings (key, value) VALUES ('whatsapp_contact', '0');
