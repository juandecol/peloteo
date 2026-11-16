-- Lugares privados (2026-11-16): 1 si el lugar es un club privado (solo pueden jugar sus
-- socios), 0 si es público. Solo informativo: al publicar o sumarse a un partido se avisa
-- que reservar en peloteo.cl no garantiza el acceso. Los lugares existentes quedan públicos.

ALTER TABLE venues ADD COLUMN private INTEGER NOT NULL DEFAULT 0 CHECK (private IN (0, 1));
