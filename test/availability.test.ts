import { test } from "node:test";
import assert from "node:assert/strict";
import {
  blockCoversSlot,
  courtSlots,
  dayAvailability,
  getDayAvailability,
  getMonthSummary,
  parseDays,
  type Court,
  type PublicGame,
} from "../src/lib/availability.ts";
import { emptyGamesDb } from "./helpers/db.ts";

const court = (over: Partial<Court> = {}): Court => ({
  id: "C-AAAAA",
  name: "Cancha 1",
  status: "operativa",
  open_time: "08:00",
  close_time: "21:00",
  slot_minutes: 60,
  days: "0,1,2,3,4,5,6",
  available_from: null,
  available_to: null,
  ...over,
});

const game = (over: Partial<PublicGame> = {}): PublicGame => ({
  id: "E-AAAAA",
  date: "2026-11-17",
  time: "18:00",
  court_id: null,
  capacity: 2,
  accepted_levels: [1, 2, 3, 4, 5],
  status: "abierto",
  players: [{ initials: "MT", level: 3 }],
  missing: 1,
  mine: false,
  ...over,
});

const now = { date: "2026-11-16", minutes: 10 * 60 }; // lunes 10:00

test("turnos de 60 minutos: el último termina justo al cierre", () => {
  const slots = courtSlots(court(), "2026-11-17");
  assert.equal(slots[0], "08:00");
  assert.equal(slots.at(-1), "20:00");
  assert.equal(slots.length, 13);
});

test("turnos de 90 minutos: no se genera un turno que termine después del cierre", () => {
  const slots = courtSlots(court({ slot_minutes: 90 }), "2026-11-17");
  assert.deepEqual(slots, ["08:00", "09:30", "11:00", "12:30", "14:00", "15:30", "17:00", "18:30"]);
});

test("turnos de 120 minutos", () => {
  assert.deepEqual(courtSlots(court({ slot_minutes: 120, open_time: "09:00", close_time: "14:00" }), "2026-11-17"), [
    "09:00",
    "11:00",
  ]);
});

test("canchas en mantención o cerradas no generan turnos", () => {
  assert.deepEqual(courtSlots(court({ status: "mantencion" }), "2026-11-17"), []);
  assert.deepEqual(courtSlots(court({ status: "cerrada" }), "2026-11-17"), []);
});

test("solo en los días de operación (0 = domingo)", () => {
  const weekdays = court({ days: "1,2,3,4,5" });
  assert.equal(courtSlots(weekdays, "2026-11-15").length, 0); // domingo
  assert.equal(courtSlots(weekdays, "2026-11-16").length, 13); // lunes
  assert.deepEqual(parseDays(" 1, 3,x,9,6"), [1, 3, 6]);
});

test("solo dentro del rango de fechas de la cancha", () => {
  const c = court({ available_from: "2026-11-20", available_to: "2026-11-25" });
  assert.equal(courtSlots(c, "2026-11-19").length, 0);
  assert.equal(courtSlots(c, "2026-11-20").length, 13);
  assert.equal(courtSlots(c, "2026-11-25").length, 13);
  assert.equal(courtSlots(c, "2026-11-26").length, 0);
});

test("día: los encuentros abiertos no ocupan cancha; los confirmados sí", () => {
  const courts = [court({ id: "C-1" }), court({ id: "C-2", name: "Cancha 2" })];
  const open = game({ id: "E-OPEN1" });
  const confirmed = game({ id: "E-CONF1", court_id: "C-1", status: "confirmado", missing: 0 });
  const slots = dayAvailability(courts, [open, confirmed], "2026-11-17", now);
  const s18 = slots.find((s) => s.time === "18:00")!;
  assert.equal(s18.free_courts, 1);
  assert.deepEqual(s18.open_games.map((g) => g.id), ["E-OPEN1"]);
  assert.equal(s18.full, false);
  assert.equal(slots.find((s) => s.time === "08:00")!.free_courts, 2);
});

test("día: los encuentros sin cancha no aparecen como abiertos ni ocupan cancha", () => {
  const sinCancha = game({ status: "sin_cancha", missing: 0 });
  const s18 = dayAvailability([court()], [sinCancha], "2026-11-17", now).find((s) => s.time === "18:00")!;
  assert.equal(s18.free_courts, 1);
  assert.equal(s18.open_games.length, 0);
});

test("día: un turno sin canchas libres ni encuentros abiertos queda completo", () => {
  const courts = [court({ id: "C-1" })];
  const confirmed = game({ court_id: "C-1", status: "confirmado", missing: 0 });
  const s18 = dayAvailability(courts, [confirmed], "2026-11-17", now).find((s) => s.time === "18:00")!;
  assert.equal(s18.free_courts, 0);
  assert.equal(s18.open_games.length, 0);
  assert.equal(s18.full, true);
});

test("día: hoy se omiten los turnos con más de 15 minutos de iniciados", () => {
  const at = { date: "2026-11-16", minutes: 9 * 60 + 15 }; // 09:15
  const times = dayAvailability([court()], [], "2026-11-16", at).map((s) => s.time);
  assert.equal(times[0], "09:00");
  assert.ok(!times.includes("08:00"));
  const later = { date: "2026-11-16", minutes: 9 * 60 + 16 };
  assert.equal(dayAvailability([court()], [], "2026-11-16", later)[0]!.time, "10:00");
});

test("día: fuera del rango agendable no hay turnos", () => {
  assert.deepEqual(dayAvailability([court()], [], "2026-12-02", now), []);
  assert.deepEqual(dayAvailability([court()], [], "2026-11-15", now), []);
});

test("datos de ejemplo: tenis en Santa Martina usa 2 canchas (la 3 está en mantención)", async () => {
  const db = emptyGamesDb();
  const slots = await getDayAvailability(db, "D-TEN01", "2026-11-17", now);
  assert.equal(slots.length, 13);
  assert.ok(slots.every((s) => s.free_courts === 2));
});

test("resumen del mes: solo días agendables y marca los que tienen encuentros abiertos", async () => {
  const db = emptyGamesDb();
  db.exec(`INSERT INTO games (id, venue_id, sport_id, date, time, capacity, accepted_levels)
           VALUES ('E-AAAAA', 'L-SM001', 'D-TEN01', '2026-11-20', '18:00', 2, '1,2,3,4,5');
           INSERT INTO players (id, game_id, visitor_id, initials, level, email, cancel_token)
           VALUES ('J-AAAAA', 'E-AAAAA', 'V-1', 'MT', 3, 'mt@example.com', 'aaaa');`);
  const nov = await getMonthSummary(db, "D-TEN01", "2026-11", now);
  assert.equal(nov[0]!.date, "2026-11-16");
  assert.equal(nov.at(-1)!.date, "2026-11-30");
  assert.equal(nov.find((d) => d.date === "2026-11-20")!.open_games, 1);
  assert.equal(nov.find((d) => d.date === "2026-11-21")!.open_games, 0);
  assert.ok(nov.every((d) => d.available));
  const dec = await getMonthSummary(db, "D-TEN01", "2026-12", now);
  assert.deepEqual(dec.map((d) => d.date), ["2026-12-01"]);
});

// ---------------------------------------------------------------
// Bloqueos
// ---------------------------------------------------------------

const block = (start_time: string, end_time: string, court_id = "C-AAAAA", date = "2026-11-17") => ({
  court_id,
  date,
  start_time,
  end_time,
});

test("bloqueo: cubre los turnos que se cruzan con su rango, aunque sea en parte", () => {
  const b = block("18:30", "20:00");
  assert.ok(!blockCoversSlot(b, "2026-11-17", "17:00", 60)); // 17:00-18:00
  assert.ok(!blockCoversSlot(b, "2026-11-17", "17:30", 60)); // termina justo cuando empieza el bloqueo
  assert.ok(blockCoversSlot(b, "2026-11-17", "18:00", 60)); // 18:00-19:00 se cruza
  assert.ok(blockCoversSlot(b, "2026-11-17", "19:00", 60));
  assert.ok(!blockCoversSlot(b, "2026-11-17", "20:00", 60)); // empieza justo al terminar
  assert.ok(!blockCoversSlot(b, "2026-11-17", "17:00", 90)); // 17:00-18:30 termina justo al empezar
  assert.ok(blockCoversSlot(b, "2026-11-17", "17:30", 90)); // 17:30-19:00 se cruza
  assert.ok(!blockCoversSlot(b, "2026-11-18", "18:00", 60)); // otro día
});

test("día: una cancha bloqueada no cuenta como libre", () => {
  const courts = [court({ id: "C-1" }), court({ id: "C-2", name: "Cancha 2" })];
  const slots = dayAvailability(courts, [], "2026-11-17", now, [block("18:00", "20:00", "C-1")]);
  assert.equal(slots.find((s) => s.time === "17:00")!.free_courts, 2);
  assert.equal(slots.find((s) => s.time === "18:00")!.free_courts, 1);
  assert.equal(slots.find((s) => s.time === "19:00")!.free_courts, 1);
  assert.equal(slots.find((s) => s.time === "20:00")!.free_courts, 2);
});

test("día: si todas las canchas están bloqueadas, el turno no se ofrece", () => {
  const slots = dayAvailability([court({ id: "C-1" })], [], "2026-11-17", now, [block("08:00", "10:00", "C-1")]);
  const s8 = slots.find((s) => s.time === "08:00")!;
  assert.equal(s8.free_courts, 0);
  assert.equal(s8.full, true);
});

test("resumen del mes: un día bloqueado entero queda no disponible", async () => {
  const db = emptyGamesDb();
  db.exec(`INSERT INTO court_blocks (id, court_id, date, start_time, end_time) VALUES
           ('B-AAAAA', 'C-T1SM1', '2026-11-20', '00:00', '24:00'),
           ('B-BBBBB', 'C-T2SM2', '2026-11-20', '00:00', '24:00')`);
  const nov = await getMonthSummary(db, "D-TEN01", "2026-11", now);
  assert.equal(nov.find((d) => d.date === "2026-11-20")!.available, false);
  assert.equal(nov.find((d) => d.date === "2026-11-21")!.available, true);
  const day = await getDayAvailability(db, "D-TEN01", "2026-11-20", now);
  assert.ok(day.every((s) => s.free_courts === 0));
});
