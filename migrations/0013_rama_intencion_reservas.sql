-- Rama e intención de juego de cada cupo, y enlace de reservas de cada lugar (2026-11-16).
-- La rama (masculina o femenina) y la intención (diversión, salud o competitivo) son
-- informativas: se muestran junto al nivel, no limitan quién se une. Son obligatorias al
-- anotarse; los cupos anteriores quedan sin dato (NULL) y no muestran nada.
ALTER TABLE players ADD COLUMN rama TEXT CHECK (rama IS NULL OR rama IN ('masculina', 'femenina'));
ALTER TABLE players ADD COLUMN intent TEXT CHECK (intent IS NULL OR intent IN ('diversion', 'salud', 'competitivo'));

-- Dirección donde se reserva la cancha en línea (opcional). Por ahora solo se edita en el admin.
ALTER TABLE venues ADD COLUMN booking_url TEXT NOT NULL DEFAULT '';
