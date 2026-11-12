import { test } from "node:test";
import assert from "node:assert/strict";
import {
  addDays,
  datesOfMonth,
  dayOfWeek,
  canStillCancel,
  minutesUntil,
  isDate,
  isDateBookable,
  isSlotOpen,
  isTime,
  lastBookableDate,
  localNow,
} from "../src/lib/time.ts";

test("localNow convierte a hora de Chile en verano (UTC-3)", () => {
  // 15 de enero 2027, 12:30 UTC → 09:30 en Santiago
  assert.deepEqual(localNow(new Date("2027-01-15T12:30:00Z")), { date: "2027-01-15", minutes: 9 * 60 + 30 });
});

test("localNow convierte a hora de Chile en invierno (UTC-4)", () => {
  // 15 de julio 2026, 12:30 UTC → 08:30 en Santiago
  assert.deepEqual(localNow(new Date("2026-07-15T12:30:00Z")), { date: "2026-07-15", minutes: 8 * 60 + 30 });
});

test("localNow cambia de día según la hora local, no la UTC", () => {
  // 13 de noviembre 02:00 UTC = 12 de noviembre 23:00 en Santiago
  assert.deepEqual(localNow(new Date("2026-11-13T02:00:00Z")), { date: "2026-11-12", minutes: 23 * 60 });
});

test("addDays cruza meses y años", () => {
  assert.equal(addDays("2026-11-28", 15), "2026-12-13");
  assert.equal(addDays("2026-12-25", 15), "2027-01-09");
  assert.equal(addDays("2028-02-28", 1), "2028-02-29");
});

test("dayOfWeek usa 0 = domingo", () => {
  assert.equal(dayOfWeek("2026-11-15"), 0); // domingo
  assert.equal(dayOfWeek("2026-11-16"), 1); // lunes
  assert.equal(dayOfWeek("2026-11-21"), 6); // sábado
});

test("datesOfMonth devuelve todos los días del mes", () => {
  assert.equal(datesOfMonth("2026-11").length, 30);
  assert.equal(datesOfMonth("2028-02").at(-1), "2028-02-29");
});

test("isDate e isTime validan formato y valores reales", () => {
  assert.ok(isDate("2026-11-30"));
  assert.ok(!isDate("2026-11-31"));
  assert.ok(!isDate("2026-1-05"));
  assert.ok(isTime("08:00"));
  assert.ok(isTime("24:00"));
  assert.ok(!isTime("24:30"));
  assert.ok(!isTime("8:00"));
});

const now = { date: "2026-11-16", minutes: 10 * 60 }; // lunes 10:00

test("anticipación: se agenda desde hoy hasta hoy + 15", () => {
  assert.equal(lastBookableDate(now), "2026-12-01");
  assert.ok(isDateBookable("2026-11-16", now));
  assert.ok(isDateBookable("2026-12-01", now));
  assert.ok(!isDateBookable("2026-12-02", now));
  assert.ok(!isDateBookable("2026-11-15", now));
});

test("pasado: un turno se acepta hasta 15 minutos después de su inicio", () => {
  assert.ok(isSlotOpen("2026-11-16", "09:45", now)); // comenzó hace 15 min
  assert.ok(!isSlotOpen("2026-11-16", "09:44", now)); // hace 16 min
  assert.ok(isSlotOpen("2026-11-16", "10:00", now));
  assert.ok(isSlotOpen("2026-11-17", "08:00", now));
  assert.ok(!isSlotOpen("2026-11-15", "23:00", now));
  assert.ok(!isSlotOpen("2026-12-02", "10:00", now));
});

test("minutesUntil cuenta minutos hasta el inicio, también entre días", () => {
  assert.equal(minutesUntil("2026-11-16", "11:30", now), 90);
  assert.equal(minutesUntil("2026-11-16", "09:00", now), -60);
  assert.equal(minutesUntil("2026-11-17", "08:00", now), 22 * 60);
  const late = { date: "2026-11-16", minutes: 23 * 60 + 45 };
  assert.equal(minutesUntil("2026-11-17", "00:30", late), 45);
  assert.equal(minutesUntil("2026-12-01", "10:00", { date: "2026-11-30", minutes: 10 * 60 }), 24 * 60);
});

test("cancelar: se puede hasta 1 hora antes del inicio", () => {
  assert.ok(canStillCancel("2026-11-16", "11:00", now)); // falta 1 hora justa
  assert.ok(!canStillCancel("2026-11-16", "10:59", now)); // faltan 59 minutos
  assert.ok(!canStillCancel("2026-11-16", "09:00", now)); // ya comenzó
  assert.ok(canStillCancel("2026-11-17", "08:00", now));
  // Cruza la medianoche: a las 23:45, un partido a las 00:30 ya no se puede cancelar.
  assert.ok(!canStillCancel("2026-11-17", "00:30", { date: "2026-11-16", minutes: 23 * 60 + 45 }));
});
