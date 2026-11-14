-- Deporte visible u oculto para los jugadores (2026-11-14).
-- El administrador decide si un deporte se ofrece en el sitio. Aunque esté
-- visible, solo aparece si tiene al menos una cancha operativa, porque las
-- horas salen del horario de sus canchas. Los deportes existentes quedan visibles.

ALTER TABLE sports ADD COLUMN visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1));
