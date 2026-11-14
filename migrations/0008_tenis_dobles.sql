-- Tenis también se juega en dobles (2026-11-14): quien abre un partido de tenis
-- elige singles (2 jugadores) o dobles (4), igual que en pádel.
-- Aplica a todos los deportes llamados "tenis" (sin importar mayúsculas ni
-- espacios) que hoy solo admiten 2. Desde el admin se puede cambiar por deporte.

UPDATE sports SET match_sizes = '2,4'
WHERE lower(trim(name)) IN ('tenis', 'tennis') AND match_sizes = '2';
