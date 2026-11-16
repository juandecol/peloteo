-- Horario semanal de cada lugar, horas desactivadas de cada cancha y aceptación de
-- los términos y condiciones (2026-11-16).
--
-- venues.hours: siete tramos separados por ";" (índice 0 = domingo ... 6 = sábado),
-- cada uno "HH:MM-HH:MM" o vacío si el lugar no abre ese día. Texto vacío = sin
-- horario propio: las canchas usan solo el suyo (así quedan los lugares actuales).
-- Ninguna cancha ofrece turnos fuera del horario de su lugar.
ALTER TABLE venues ADD COLUMN hours TEXT NOT NULL DEFAULT '';

-- courts.disabled_slots: turnos semanales desactivados, "día@HH:MM" separados por coma
-- (por ejemplo "1@08:00,6@20:00": lunes 08:00 y sábado 20:00). Vacío = todos activos.
ALTER TABLE courts ADD COLUMN disabled_slots TEXT NOT NULL DEFAULT '';

-- players.terms_accepted: versión (fecha) de los términos que aceptó quien se anotó.
-- Nulo en los cupos anteriores a los términos.
ALTER TABLE players ADD COLUMN terms_accepted TEXT;
