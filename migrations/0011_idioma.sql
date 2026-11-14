-- Sitio en español e inglés (2026-11-14).
-- Cada cupo guarda el idioma de quien se anotó, para enviarle los correos en ese
-- idioma; los cupos existentes quedan en español.
ALTER TABLE players ADD COLUMN lang TEXT NOT NULL DEFAULT 'es' CHECK (lang IN ('es', 'en'));

-- Texto opcional en inglés de cada categoría (si falta, se muestra el texto en español).
ALTER TABLE categories ADD COLUMN label_en TEXT CHECK (label_en IS NULL OR length(trim(label_en)) > 0);

-- Textos en inglés de las categorías actuales (se pueden cambiar en Configuración).
UPDATE categories SET label_en = 'Training for Wimbledon' WHERE label = 'Estoy entrenando para Wimbledon';
UPDATE categories SET label_en = 'I play club tournaments' WHERE label = 'Compito en torneos del club';
UPDATE categories SET label_en = 'I play sets and sometimes win' WHERE label = 'Juego sets y a veces gano';
UPDATE categories SET label_en = 'Just hitting, no drama' WHERE label = 'Peloteo sin drama';
UPDATE categories SET label_en = 'I can barely get the ball over' WHERE label = 'Apenas logro pasar la pelota';
UPDATE categories SET label_en = 'Almost ready for the pro tour' WHERE label = 'Me falta poco para el circuito pro';
UPDATE categories SET label_en = 'I play leagues and tournaments' WHERE label = 'Juego ligas y torneos';
UPDATE categories SET label_en = 'I build points and use the walls' WHERE label = 'Armo puntos y uso las paredes';
UPDATE categories SET label_en = 'The walls use me' WHERE label = 'Las paredes me usan a mí';
UPDATE categories SET label_en = 'I still hit it with the frame' WHERE label = 'Todavía le pego con el marco';
