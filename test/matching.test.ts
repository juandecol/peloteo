import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cancelByToken,
  cancelByVisitor,
  createGame,
  joinGame,
  MatchError,
  searchGames,
  validatePlayer,
  type PlayerInput,
} from "../src/lib/matching.ts";
import { getDayAvailability } from "../src/lib/availability.ts";
import { emptyGamesDb } from "./helpers/db.ts";

const now = { date: "2026-11-16", minutes: 10 * 60 }; // lunes 10:00
const DAY = "2026-11-17";

const me = (over: Partial<PlayerInput> = {}): PlayerInput => ({
  initials: "mt",
  level: 3,
  email: "MT@Example.com ",
  ...over,
});

const tenis = (over: Record<string, unknown> = {}) => ({
  sport_id: "D-TEN01",
  date: DAY,
  time: "18:00",
  player: me(),
  ...over,
});

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof MatchError, String(err));
    assert.equal(err.code, code);
    return true;
  });
}

// ---------------------------------------------------------------
// Validación
// ---------------------------------------------------------------

test("validación: normaliza iniciales, email y WhatsApp", () => {
  const p = validatePlayer(
    { initials: "j.p.", level: "2", email: " JP@Mail.CL", whatsapp: "+56 9 1234 5678", whatsapp_opt_in: true },
    [1, 2, 3],
  );
  assert.deepEqual(p, { initials: "JP", level: 2, email: "jp@mail.cl", whatsapp: "+56912345678", whatsapp_opt_in: 1 });
});

test("validación: acepta letras con tilde y ñ", () => {
  assert.equal(validatePlayer(me({ initials: "ñá" }), [3]).initials, "ÑÁ");
});

test("validación: rechaza datos inválidos con el campo correspondiente", () => {
  const field = (input: PlayerInput) => {
    try {
      validatePlayer(input, [1, 2, 3, 4, 5]);
      return null;
    } catch (e) {
      return (e as MatchError).field;
    }
  };
  assert.equal(field(me({ initials: "M" })), "initials");
  assert.equal(field(me({ initials: "ABCDE" })), "initials");
  assert.equal(field(me({ level: 6 })), "level");
  assert.equal(field(me({ level: "x" })), "level");
  assert.equal(field(me({ email: "sin-arroba" })), "email");
  assert.equal(field(me({ whatsapp: "1234" })), "whatsapp");
  assert.equal(field(me()), null);
});

test("validación: el nivel debe tener categoría en el deporte", () => {
  assert.throws(() => validatePlayer(me({ level: 4 }), [1, 2, 3]), MatchError);
});

test("validación: sin WhatsApp no hay opt-in", () => {
  assert.equal(validatePlayer(me({ whatsapp_opt_in: true }), [3]).whatsapp_opt_in, 0);
});

// ---------------------------------------------------------------
// Abrir partido
// ---------------------------------------------------------------

test("abrir: asigna la primera cancha libre y deja el encuentro abierto", async () => {
  const db = emptyGamesDb();
  const r = await createGame(db, tenis(), "V-1", now);
  assert.equal(r.game.court_id, "C-T1SM1");
  assert.equal(r.game.status, "abierto");
  assert.equal(r.game.capacity, 2);
  assert.equal(r.game.missing, 1);
  assert.equal(r.game.mine, true);
  assert.match(r.game.id, /^E-[A-Z2-9]{5}$/);
  assert.match(r.player_id, /^J-[A-Z2-9]{5}$/);
  assert.match(r.cancel_token, /^[0-9a-f]{32}$/);
  assert.deepEqual(r.notices, [{ event: "partido_publicado", game_id: r.game.id, player_ids: [r.player_id] }]);
  const row = db.get<{ email: string; initials: string }>("SELECT email, initials FROM players WHERE id = ?", r.player_id);
  assert.deepEqual({ ...row }, { email: "mt@example.com", initials: "MT" });
});

test("abrir: pádel usa capacidad 4", async () => {
  const db = emptyGamesDb();
  const r = await createGame(db, tenis({ sport_id: "D-PAD01", time: "18:30" }), "V-1", now);
  assert.equal(r.game.capacity, 4);
  assert.equal(r.game.court_id, "C-PASM4");
});

test("abrir: el segundo partido del mismo turno toma la siguiente cancha y el tercero no cabe", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, tenis(), "V-1", now);
  const b = await createGame(db, tenis(), "V-2", now);
  assert.equal(a.game.court_id, "C-T1SM1");
  assert.equal(b.game.court_id, "C-T2SM2");
  // La cancha 3 está en mantención: no se asigna.
  await rejects(createGame(db, tenis(), "V-3", now), "turno_ocupado");
  assert.equal(db.count("SELECT count(*) AS n FROM games"), 2);
  assert.equal(db.count("SELECT count(*) AS n FROM players"), 2);
});

test("abrir: rechaza horas que la cancha no genera", async () => {
  const db = emptyGamesDb();
  await rejects(createGame(db, tenis({ time: "18:30" }), "V-1", now), "turno_invalido");
  await rejects(createGame(db, tenis({ time: "21:00" }), "V-1", now), "turno_invalido");
  await rejects(createGame(db, tenis({ time: "07:00" }), "V-1", now), "turno_invalido");
});

test("abrir: rechaza turnos pasados y fuera de los 15 días", async () => {
  const db = emptyGamesDb();
  await rejects(createGame(db, tenis({ date: now.date, time: "09:00" }), "V-1", now), "turno_cerrado");
  await rejects(createGame(db, tenis({ date: "2026-11-15" }), "V-1", now), "turno_cerrado");
  await rejects(createGame(db, tenis({ date: "2026-12-02" }), "V-1", now), "turno_cerrado");
  // Dentro del margen de 15 minutos sí se acepta.
  await createGame(db, tenis({ date: now.date, time: "10:00" }), "V-1", { ...now, minutes: 10 * 60 + 15 });
  // El último día agendable también.
  await createGame(db, tenis({ date: "2026-12-01" }), "V-1", now);
});

test("abrir: rechaza deporte inexistente, fecha inválida y datos del jugador", async () => {
  const db = emptyGamesDb();
  await rejects(createGame(db, tenis({ sport_id: "D-NOPE" }), "V-1", now), "deporte_no_existe");
  await rejects(createGame(db, tenis({ date: "2026-11-31" }), "V-1", now), "datos_invalidos");
  await rejects(createGame(db, tenis({ player: me({ email: "x" }) }), "V-1", now), "datos_invalidos");
  assert.equal(db.count("SELECT count(*) AS n FROM games"), 0);
});

test("concurrencia: dos jugadores piden la última cancha a la vez y solo uno la obtiene", async () => {
  const db = emptyGamesDb();
  await createGame(db, tenis(), "V-1", now); // ocupa la cancha 1
  const results = await Promise.allSettled([
    createGame(db, tenis(), "V-2", now),
    createGame(db, tenis(), "V-3", now),
  ]);
  const ok = results.filter((r) => r.status === "fulfilled");
  const fail = results.filter((r) => r.status === "rejected");
  assert.equal(ok.length, 1);
  assert.equal(fail.length, 1);
  assert.equal(((fail[0] as PromiseRejectedResult).reason as MatchError).code, "turno_ocupado");
  assert.equal(db.count("SELECT count(*) AS n FROM games WHERE date = ? AND time = '18:00'", DAY), 2);
});

test("concurrencia: el índice único impide la doble reserva aunque falle la verificación previa", () => {
  const db = emptyGamesDb();
  const insert = `INSERT INTO games (id, venue_id, sport_id, court_id, date, time, capacity)
                  VALUES (?, 'L-SM001', 'D-TEN01', 'C-T1SM1', '2026-11-17', '18:00', 2)`;
  db.raw.prepare(insert).run("E-AAAAA");
  assert.throws(() => db.raw.prepare(insert).run("E-BBBBB"), /UNIQUE constraint failed/);
  // Un encuentro cancelado no bloquea el turno.
  db.exec("UPDATE games SET status = 'cancelado' WHERE id = 'E-AAAAA'");
  db.raw.prepare(insert).run("E-BBBBB");
});

// ---------------------------------------------------------------
// Unirse
// ---------------------------------------------------------------

test("unirse: al completar la capacidad el encuentro queda confirmado", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, tenis(), "V-1", now);
  const b = await joinGame(db, a.game.id, me({ initials: "RS", level: 4 }), "V-2", now);
  assert.equal(b.game.status, "confirmado");
  assert.equal(b.game.missing, 0);
  assert.deepEqual(b.game.players, [
    { initials: "MT", level: 3 },
    { initials: "RS", level: 4 },
  ]);
  assert.deepEqual(b.notices, [
    { event: "jugador_se_sumo", game_id: a.game.id, player_ids: [a.player_id] },
    { event: "partido_confirmado", game_id: a.game.id, player_ids: [a.player_id, b.player_id] },
  ]);
});

test("unirse: pádel sigue abierto hasta el cuarto jugador", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, tenis({ sport_id: "D-PAD01", time: "18:30" }), "V-1", now);
  const b = await joinGame(db, a.game.id, me(), "V-2", now);
  assert.equal(b.game.status, "abierto");
  assert.equal(b.game.missing, 2);
  assert.equal(b.notices.length, 1);
  await joinGame(db, a.game.id, me(), "V-3", now);
  const d = await joinGame(db, a.game.id, me(), "V-4", now);
  assert.equal(d.game.status, "confirmado");
  await rejects(joinGame(db, a.game.id, me(), "V-5", now), "encuentro_completo");
});

test("unirse: un visitante no puede ocupar dos cupos del mismo encuentro", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, tenis({ sport_id: "D-PAD01", time: "18:30" }), "V-1", now);
  await rejects(joinGame(db, a.game.id, me(), "V-1", now), "ya_inscrito");
});

test("unirse: rechaza encuentros inexistentes, cancelados o ya comenzados", async () => {
  const db = emptyGamesDb();
  await rejects(joinGame(db, "E-NOPE1", me(), "V-2", now), "encuentro_no_existe");
  const a = await createGame(db, tenis(), "V-1", now);
  await rejects(joinGame(db, a.game.id, me(), "V-2", { date: DAY, minutes: 18 * 60 + 16 }), "turno_cerrado");
  db.exec(`UPDATE games SET status = 'cancelado' WHERE id = '${a.game.id}'`);
  await rejects(joinGame(db, a.game.id, me(), "V-2", now), "encuentro_cancelado");
});

test("unirse: valida el nivel contra las categorías del deporte", async () => {
  const db = emptyGamesDb();
  db.exec("DELETE FROM categories WHERE sport_id = 'D-TEN01' AND level = 5");
  const a = await createGame(db, tenis(), "V-1", now);
  await rejects(joinGame(db, a.game.id, me({ level: 5 }), "V-2", now), "datos_invalidos");
});

test("concurrencia: dos jugadores toman el último cupo a la vez y solo uno entra", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, tenis(), "V-1", now);
  const results = await Promise.allSettled([
    joinGame(db, a.game.id, me(), "V-2", now),
    joinGame(db, a.game.id, me(), "V-3", now),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  const fail = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.equal((fail.reason as MatchError).code, "encuentro_completo");
  assert.equal(db.count("SELECT count(*) AS n FROM players WHERE game_id = ?", a.game.id), 2);
});

// ---------------------------------------------------------------
// Cancelar
// ---------------------------------------------------------------

test("cancelar: si el encuentro queda sin jugadores se elimina y la cancha se libera", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, tenis(), "V-1", now);
  const r = await cancelByVisitor(db, a.game.id, "V-1", now);
  assert.deepEqual(r, { game_id: a.game.id, game_deleted: true, reopened: false, notices: [] });
  assert.equal(db.count("SELECT count(*) AS n FROM games"), 0);
  const slot = (await getDayAvailability(db, "D-TEN01", DAY, now)).find((s) => s.time === "18:00")!;
  assert.equal(slot.free_courts, 2);
});

test("cancelar: un encuentro confirmado vuelve a abierto y se avisa al resto", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, tenis(), "V-1", now);
  const b = await joinGame(db, a.game.id, me(), "V-2", now);
  const r = await cancelByVisitor(db, a.game.id, "V-2", now);
  assert.equal(r.reopened, true);
  assert.equal(r.game_deleted, false);
  assert.deepEqual(r.notices, [{ event: "cupo_cancelado", game_id: a.game.id, player_ids: [a.player_id] }]);
  assert.equal(db.get<{ status: string }>("SELECT status FROM games WHERE id = ?", a.game.id)!.status, "abierto");
  // El cupo liberado puede volver a tomarse.
  const c = await joinGame(db, a.game.id, me(), "V-3", now);
  assert.equal(c.game.status, "confirmado");
  assert.ok(!db.get("SELECT 1 FROM players WHERE id = ?", b.player_id));
});

test("cancelar: un encuentro abierto con más jugadores sigue abierto", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, tenis({ sport_id: "D-PAD01", time: "18:30" }), "V-1", now);
  await joinGame(db, a.game.id, me(), "V-2", now);
  const r = await cancelByVisitor(db, a.game.id, "V-1", now);
  assert.equal(r.game_deleted, false);
  assert.equal(r.reopened, false);
  assert.equal(db.count("SELECT count(*) AS n FROM players WHERE game_id = ?", a.game.id), 1);
});

test("cancelar: con el token del enlace, desde otro dispositivo", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, tenis(), "V-1", now);
  const r = await cancelByToken(db, a.cancel_token, now);
  assert.equal(r.game_deleted, true);
  await rejects(cancelByToken(db, a.cancel_token, now), "cupo_no_existe");
  await rejects(cancelByToken(db, "no-es-un-token", now), "cupo_no_existe");
});

test("cancelar: solo el propio cupo, y no después del inicio", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, tenis(), "V-1", now);
  await rejects(cancelByVisitor(db, a.game.id, "V-2", now), "cupo_no_existe");
  await rejects(cancelByVisitor(db, a.game.id, "V-1", { date: DAY, minutes: 18 * 60 }), "cancelacion_cerrada");
});

test("cancelar: no aplica a encuentros cancelados por el administrador", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, tenis(), "V-1", now);
  db.exec(`UPDATE games SET status = 'cancelado' WHERE id = '${a.game.id}'`);
  await rejects(cancelByVisitor(db, a.game.id, "V-1", now), "encuentro_cancelado");
});

// ---------------------------------------------------------------
// Búsqueda
// ---------------------------------------------------------------

async function searchScenario() {
  const db = emptyGamesDb();
  const g3 = await createGame(db, tenis({ time: "18:00", player: me({ level: 3 }) }), "V-1", now);
  const g4 = await createGame(db, tenis({ time: "10:00", date: "2026-11-18", player: me({ level: 4 }) }), "V-2", now);
  const full = await createGame(db, tenis({ time: "12:00", player: me({ level: 3 }) }), "V-3", now);
  await joinGame(db, full.game.id, me({ level: 3 }), "V-4", now);
  return { db, g3, g4 };
}

test("búsqueda: devuelve encuentros abiertos con algún jugador de los niveles pedidos", async () => {
  const { db, g3, g4 } = await searchScenario();
  const all = await searchGames(db, { sport_id: "D-TEN01" }, "V-9", now);
  assert.deepEqual(all.map((g) => g.id), [g3.game.id, g4.game.id]);
  const lvl4 = await searchGames(db, { sport_id: "D-TEN01", levels: [4, 5] }, "V-9", now);
  assert.deepEqual(lvl4.map((g) => g.id), [g4.game.id]);
});

test("búsqueda: filtra por rango de fechas y de horas", async () => {
  const { db, g3, g4 } = await searchScenario();
  const day = await searchGames(db, { sport_id: "D-TEN01", date_from: DAY, date_to: DAY }, "V-9", now);
  assert.deepEqual(day.map((g) => g.id), [g3.game.id]);
  const morning = await searchGames(db, { sport_id: "D-TEN01", time_from: "07:00", time_to: "11:00" }, "V-9", now);
  assert.deepEqual(morning.map((g) => g.id), [g4.game.id]);
  await rejects(searchGames(db, { sport_id: "D-TEN01", time_from: "12:00", time_to: "09:00" }, "V-9", now), "datos_invalidos");
  await rejects(searchGames(db, { sport_id: "D-TEN01", levels: [] }, "V-9", now), "datos_invalidos");
});

test("búsqueda: excluye los encuentros propios y otros deportes", async () => {
  const { db, g4 } = await searchScenario();
  const r = await searchGames(db, { sport_id: "D-TEN01" }, "V-1", now);
  assert.deepEqual(r.map((g) => g.id), [g4.game.id]);
  assert.deepEqual(await searchGames(db, { sport_id: "D-TEN02" }, "V-9", now), []);
});

test("búsqueda: excluye turnos ya cerrados", async () => {
  const { db, g4 } = await searchScenario();
  const later = { date: DAY, minutes: 18 * 60 + 16 };
  const r = await searchGames(db, { sport_id: "D-TEN01" }, "V-9", later);
  assert.deepEqual(r.map((g) => g.id), [g4.game.id]);
});

// ---------------------------------------------------------------
// Privacidad
// ---------------------------------------------------------------

test("privacidad: las respuestas públicas solo traen iniciales y nivel", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, tenis({ player: me({ whatsapp: "+56912345678", whatsapp_opt_in: true }) }), "V-1", now);
  const day = await getDayAvailability(db, "D-TEN01", DAY, now, "V-2");
  const found = await searchGames(db, { sport_id: "D-TEN01" }, "V-2", now);
  for (const payload of [a.game, day, found]) {
    const text = JSON.stringify(payload);
    assert.ok(!text.includes("example.com"), text);
    assert.ok(!text.includes("56912345678"), text);
    assert.ok(!text.includes("V-1"), text);
    assert.ok(!text.includes(a.cancel_token), text);
  }
  assert.deepEqual(Object.keys(found[0]!.players[0]!).sort(), ["initials", "level"]);
});
