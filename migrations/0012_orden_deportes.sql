-- Orden de los deportes en el selector (2026-11-15).
-- Número entero que define el administrador: menor aparece primero. Con el mismo
-- número, orden alfabético. Los deportes existentes quedan en 0 (alfabético, como hasta ahora).

ALTER TABLE sports ADD COLUMN sort_order INTEGER NOT NULL DEFAULT 0 CHECK (sort_order BETWEEN 0 AND 999);
