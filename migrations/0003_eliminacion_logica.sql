-- Eliminación lógica de lugares, deportes y canchas.
-- Los encuentros cancelados se conservan y siguen apuntando a su lugar, deporte
-- y cancha; por eso, al eliminar desde la configuración no se borra la fila: se
-- marca con deleted_at (UTC, ISO 8601) y deja de aparecer en todas partes.

ALTER TABLE venues ADD COLUMN deleted_at TEXT;
ALTER TABLE sports ADD COLUMN deleted_at TEXT;
ALTER TABLE courts ADD COLUMN deleted_at TEXT;

-- Para limpiar sesiones vencidas.
CREATE INDEX sessions_expires ON sessions(expires_at);
