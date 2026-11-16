import { test } from "node:test";
import assert from "node:assert/strict";
import { TestDb } from "./helpers/db.ts";

test("migración 0002: conserva los jugadores y quita la cancha a los encuentros abiertos", () => {
  const db = new TestDb("0001_init.sql");
  db.exec("UPDATE games SET status = 'confirmado' WHERE id = 'E-DEMO1'");
  const before = db.raw.prepare("SELECT * FROM players ORDER BY id").all();
  assert.equal(before.length, 5);

  db.applyMigration("0002_capacidad_cancha_niveles.sql");

  assert.deepEqual(db.raw.prepare("SELECT * FROM players ORDER BY id").all(), before);
  const games = db.raw.prepare("SELECT id, court_id, status, accepted_levels FROM games ORDER BY id").all();
  assert.deepEqual(
    games.map((g) => ({ ...g })),
    [
      { id: "E-DEMO1", court_id: "C-T1SM1", status: "confirmado", accepted_levels: "1,2,3,4,5" },
      { id: "E-DEMO2", court_id: null, status: "abierto", accepted_levels: "1,2,3,4,5" },
      { id: "E-DEMO3", court_id: null, status: "abierto", accepted_levels: "1,2,3,4,5" },
    ],
  );
  assert.deepEqual(db.raw.prepare("PRAGMA foreign_key_check").all(), []);
});

test("migraciones 0002 y 0008: match_sizes; pádel y tenis admiten singles (2) o dobles (4)", () => {
  const db = new TestDb();
  const sports = db.raw.prepare("SELECT id, match_sizes FROM sports ORDER BY id").all();
  assert.deepEqual(
    sports.map((s) => ({ ...s })),
    [
      { id: "D-PAD01", match_sizes: "2,4" },
      { id: "D-TEN01", match_sizes: "2,4" },
      { id: "D-TEN02", match_sizes: "2,4" },
    ],
  );
  const cols = db.raw.prepare("PRAGMA table_info(sports)").all().map((c) => (c as { name: string }).name);
  assert.ok(!cols.includes("players_per_match"));
  assert.throws(() => db.exec("UPDATE sports SET match_sizes = '3' WHERE id = 'D-TEN01'"), /CHECK constraint failed/);
});

test("migración 0010: los deportes existentes quedan visibles y visible solo admite 0 o 1", () => {
  const db = new TestDb();
  assert.equal(db.count("SELECT count(*) AS n FROM sports WHERE visible <> 1"), 0);
  assert.throws(() => db.exec("UPDATE sports SET visible = 2 WHERE id = 'D-TEN01'"), /CHECK constraint failed/);
});

test("migración 0012: los deportes existentes quedan con orden 0 y el orden va de 0 a 999", () => {
  const db = new TestDb();
  assert.equal(db.count("SELECT count(*) AS n FROM sports WHERE sort_order <> 0"), 0);
  assert.throws(() => db.exec("UPDATE sports SET sort_order = -1 WHERE id = 'D-TEN01'"), /CHECK constraint failed/);
  assert.throws(() => db.exec("UPDATE sports SET sort_order = 1000 WHERE id = 'D-TEN01'"), /CHECK constraint failed/);
});

test("migración 0013: cupos anteriores sin rama ni intención; solo valores de la lista; lugares sin enlace de reservas", () => {
  const db = new TestDb();
  assert.equal(db.count("SELECT count(*) AS n FROM players WHERE rama IS NOT NULL OR intent IS NOT NULL"), 0);
  assert.equal(db.count("SELECT count(*) AS n FROM venues WHERE booking_url <> ''"), 0);
  db.exec("UPDATE players SET rama = 'femenina', intent = 'competitivo'");
  assert.throws(() => db.exec("UPDATE players SET rama = 'mixta'"), /CHECK constraint failed/);
  assert.throws(() => db.exec("UPDATE players SET intent = 'ganar'"), /CHECK constraint failed/);
});

test("migración 0002: borrar un encuentro sigue borrando sus jugadores en cascada", () => {
  const db = new TestDb();
  db.exec("DELETE FROM games WHERE id = 'E-DEMO3'");
  assert.equal(db.count("SELECT count(*) AS n FROM players WHERE game_id = 'E-DEMO3'"), 0);
  assert.equal(db.count("SELECT count(*) AS n FROM players"), 2);
});

test("migración 0014: lugares sin horario propio, canchas sin horas desactivadas y cupos anteriores sin términos", () => {
  const db = new TestDb();
  assert.equal(db.count("SELECT count(*) AS n FROM venues WHERE hours <> ''"), 0);
  assert.equal(db.count("SELECT count(*) AS n FROM courts WHERE disabled_slots <> ''"), 0);
  assert.equal(db.count("SELECT count(*) AS n FROM players WHERE terms_accepted IS NOT NULL"), 0);
});

test("migración 0015: los lugares parten en orden 0 (entre 0 y 999) y visibles", () => {
  assert.equal(new TestDb().count("SELECT count(*) AS n FROM venues WHERE visible <> 1"), 0);
  const db = new TestDb();
  assert.equal(db.count("SELECT count(*) AS n FROM venues WHERE sort_order <> 0"), 0);
  assert.throws(() => db.exec("UPDATE venues SET sort_order = 1000 WHERE id = 'L-SM001'"), /CHECK constraint failed/);
});
