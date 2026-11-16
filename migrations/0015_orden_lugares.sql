-- Orden y visibilidad de los lugares en el selector del inicio (2026-11-16).
-- sort_order: número entero que define el administrador: menor aparece primero (y es el
-- elegido por defecto). Con el mismo número, orden alfabético. Los lugares existentes quedan en 0.
-- visible: si el lugar se ofrece a los jugadores (1/0). Permite crear un lugar y publicarlo
-- después. Los lugares existentes quedan visibles.

ALTER TABLE venues ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 999);
ALTER TABLE venues ADD COLUMN visible INTEGER NOT NULL DEFAULT 1 CHECK (visible IN (0, 1));
