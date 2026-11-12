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

test("migración 0002: players_per_match pasa a match_sizes; pádel de ejemplo admite 2 o 4", () => {
  const db = new TestDb();
  const sports = db.raw.prepare("SELECT id, match_sizes FROM sports ORDER BY id").all();
  assert.deepEqual(
    sports.map((s) => ({ ...s })),
    [
      { id: "D-PAD01", match_sizes: "2,4" },
      { id: "D-TEN01", match_sizes: "2" },
      { id: "D-TEN02", match_sizes: "2" },
    ],
  );
  const cols = db.raw.prepare("PRAGMA table_info(sports)").all().map((c) => (c as { name: string }).name);
  assert.ok(!cols.includes("players_per_match"));
  assert.throws(() => db.exec("UPDATE sports SET match_sizes = '3' WHERE id = 'D-TEN01'"), /CHECK constraint failed/);
});

test("migración 0002: borrar un encuentro sigue borrando sus jugadores en cascada", () => {
  const db = new TestDb();
  db.exec("DELETE FROM games WHERE id = 'E-DEMO3'");
  assert.equal(db.count("SELECT count(*) AS n FROM players WHERE game_id = 'E-DEMO3'"), 0);
  assert.equal(db.count("SELECT count(*) AS n FROM players"), 2);
});
