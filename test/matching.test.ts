import { test } from "node:test";
import assert from "node:assert/strict";
import {
  cancelByToken,
  cancelByVisitor,
  createGame,
  joinGame,
  MatchError,
  searchGames,
  validateAcceptedLevels,
  validateCapacity,
  validatePlayer,
  type CreateGameInput,
  type PlayerInput,
} from "../src/lib/matching.ts";
import { getDayAvailability } from "../src/lib/availability.ts";
import { emptyGamesDb, type TestDb } from "./helpers/db.ts";

const now = { date: "2026-11-16", minutes: 10 * 60 }; // lunes 10:00
const DAY = "2026-11-17";
const ALL = [1, 2, 3, 4, 5];

const me = (over: Partial<PlayerInput> = {}): PlayerInput => ({
  initials: "mt",
  level: 3,
  email: "MT@Example.com ",
  ...over,
});

/** Partido de tenis (capacidad 2) el martes a las 18:00, acepta todos los niveles. */
const tenis = (over: Partial<CreateGameInput> = {}): CreateGameInput => ({
  sport_id: "D-TEN01",
  date: DAY,
  time: "18:00",
  accepted_levels: ALL,
  player: me(),
  ...over,
});

/** Partido de pádel a las 18:30 con la capacidad indicada. */
const padel = (capacity: number, over: Partial<CreateGameInput> = {}): CreateGameInput =>
  tenis({ sport_id: "D-PAD01", time: "18:30", capacity, ...over });

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (err: unknown) => {
    assert.ok(err instanceof MatchError, String(err));
    assert.equal(err.code, code);
    return true;
  });
}

const gameRow = (db: TestDb, id: string) =>
  db.get<{ status: string; court_id: string | null }>("SELECT status, court_id FROM games WHERE id = ?", id)!;

/** Completa un partido de tenis (2 jugadores) en el turno indicado. */
async function fullTenis(db: TestDb, time: string, v1: string, v2: string) {
  const a = await createGame(db, tenis({ time }), v1, now);
  return joinGame(db, a.game.id, me(), v2, now);
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
      validatePlayer(input, ALL);
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

test("cantidad de jugadores: una de las permitidas por el deporte", () => {
  assert.equal(validateCapacity(undefined, [2]), 2); // una sola opción: se usa esa
  assert.equal(validateCapacity("4", [2, 4]), 4);
  assert.equal(validateCapacity(2, [2, 4]), 2);
  assert.throws(() => validateCapacity(undefined, [2, 4]), MatchError); // hay que elegir
  assert.throws(() => validateCapacity(4, [2]), MatchError);
  assert.throws(() => validateCapacity(3, [2, 4]), MatchError);
});

test("niveles aceptados: al menos uno, del deporte e incluido el propio", () => {
  assert.deepEqual(validateAcceptedLevels([4, 3, 3], ALL, 3), [3, 4]);
  assert.throws(() => validateAcceptedLevels([], ALL, 3), MatchError);
  assert.throws(() => validateAcceptedLevels(undefined, ALL, 3), MatchError);
  assert.throws(() => validateAcceptedLevels([4, 5], ALL, 3), MatchError);
  assert.throws(() => validateAcceptedLevels([3, 6], ALL, 3), MatchError);
  assert.throws(() => validateAcceptedLevels([3, 5], [1, 2, 3, 4], 3), MatchError);
});

// ---------------------------------------------------------------
// Abrir partido
// ---------------------------------------------------------------

test("abrir: el encuentro queda abierto y sin cancha", async () => {
  const db = emptyGamesDb();
  const r = await createGame(db, tenis({ accepted_levels: [2, 3, 4] }), "V-1", now);
  assert.equal(r.game.court_id, null);
  assert.equal(r.game.status, "abierto");
  assert.equal(r.game.capacity, 2);
  assert.deepEqual(r.game.accepted_levels, [2, 3, 4]);
  assert.equal(r.game.missing, 1);
  assert.equal(r.game.mine, true);
  assert.match(r.game.id, /^E-[A-Z2-9]{5}$/);
  assert.match(r.player_id, /^J-[A-Z2-9]{5}$/);
  assert.match(r.cancel_token, /^[0-9a-f]{32}$/);
  assert.deepEqual(r.notices, [{ event: "partido_publicado", game_id: r.game.id, player_ids: [r.player_id] }]);
  const row = db.get<{ email: string; initials: string }>("SELECT email, initials FROM players WHERE id = ?", r.player_id);
  assert.deepEqual({ ...row }, { email: "mt@example.com", initials: "MT" });
});

test("abrir: un partido abierto no le quita la cancha a otros", async () => {
  const db = emptyGamesDb();
  // Tenis tiene 2 canchas operativas a las 18:00: se pueden abrir más de 2 partidos.
  for (const v of ["V-1", "V-2", "V-3"]) await createGame(db, tenis(), v, now);
  const slot = (await getDayAvailability(db, "D-TEN01", DAY, now)).find((s) => s.time === "18:00")!;
  assert.equal(slot.free_courts, 2);
  assert.equal(slot.open_games.length, 3);
});

test("abrir: pádel permite elegir 2 o 4 jugadores; tenis solo 2", async () => {
  const db = emptyGamesDb();
  assert.equal((await createGame(db, padel(4), "V-1", now)).game.capacity, 4);
  assert.equal((await createGame(db, padel(2), "V-2", now)).game.capacity, 2);
  await rejects(createGame(db, tenis({ sport_id: "D-PAD01", time: "18:30" }), "V-3", now), "datos_invalidos");
  await rejects(createGame(db, tenis({ capacity: 4 }), "V-3", now), "datos_invalidos");
});

test("abrir: solo si queda al menos una cancha libre en el turno", async () => {
  const db = emptyGamesDb();
  await fullTenis(db, "18:00", "V-1", "V-2"); // confirma la cancha 1
  await fullTenis(db, "18:00", "V-3", "V-4"); // confirma la cancha 2
  // La cancha 3 está en mantención: no queda ninguna libre.
  await rejects(createGame(db, tenis(), "V-5", now), "turno_ocupado");
  // Otro turno sigue disponible.
  await createGame(db, tenis({ time: "19:00" }), "V-5", now);
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

test("abrir: rechaza deporte inexistente, fecha inválida, niveles y datos del jugador", async () => {
  const db = emptyGamesDb();
  await rejects(createGame(db, tenis({ sport_id: "D-NOPE" }), "V-1", now), "deporte_no_existe");
  await rejects(createGame(db, tenis({ date: "2026-11-31" }), "V-1", now), "datos_invalidos");
  await rejects(createGame(db, tenis({ player: me({ email: "x" }) }), "V-1", now), "datos_invalidos");
  await rejects(createGame(db, tenis({ accepted_levels: [1, 2] }), "V-1", now), "datos_invalidos");
  assert.equal(db.count("SELECT count(*) AS n FROM games"), 0);
});

test("concurrencia: con una cancha libre, dos jugadores pueden abrir partido a la vez", async () => {
  const db = emptyGamesDb();
  await fullTenis(db, "18:00", "V-1", "V-2"); // queda 1 cancha libre
  const results = await Promise.allSettled([
    createGame(db, tenis(), "V-3", now),
    createGame(db, tenis(), "V-4", now),
  ]);
  // Abrir no retiene cancha: ambos quedan abiertos y compiten al completarse.
  assert.ok(results.every((r) => r.status === "fulfilled"));
});

test("concurrencia: el índice único impide dos confirmados en la misma cancha y turno", () => {
  const db = emptyGamesDb();
  const insert = `INSERT INTO games (id, venue_id, sport_id, court_id, date, time, capacity, accepted_levels, status)
                  VALUES (?, 'L-SM001', 'D-TEN01', 'C-T1SM1', '2026-11-17', '18:00', 2, '3', 'confirmado')`;
  db.raw.prepare(insert).run("E-AAAAA");
  assert.throws(() => db.raw.prepare(insert).run("E-BBBBB"), /UNIQUE constraint failed/);
  // Un encuentro cancelado no bloquea la cancha.
  db.exec("UPDATE games SET status = 'cancelado' WHERE id = 'E-AAAAA'");
  db.raw.prepare(insert).run("E-BBBBB");
});

test("base de datos: confirmado exige cancha; abierto y sin cancha no la tienen", () => {
  const db = emptyGamesDb();
  const ins = (id: string, court: string | null, status: string) =>
    db.raw
      .prepare(
        `INSERT INTO games (id, venue_id, sport_id, court_id, date, time, capacity, accepted_levels, status)
         VALUES (?, 'L-SM001', 'D-TEN01', ?, '2026-11-17', '18:00', 2, '3', ?)`,
      )
      .run(id, court, status);
  assert.throws(() => ins("E-AAAAA", null, "confirmado"), /CHECK constraint failed/);
  assert.throws(() => ins("E-BBBBB", "C-T1SM1", "abierto"), /CHECK constraint failed/);
  assert.throws(() => ins("E-CCCCC", "C-T1SM1", "sin_cancha"), /CHECK constraint failed/);
  ins("E-DDDDD", null, "abierto");
});

// ---------------------------------------------------------------
// Unirse
// ---------------------------------------------------------------

test("unirse: al completarse se asigna la primera cancha libre y se confirma", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, tenis(), "V-1", now);
  const b = await joinGame(db, a.game.id, me({ initials: "RS", level: 4 }), "V-2", now);
  assert.equal(b.game.status, "confirmado");
  assert.equal(b.game.court_id, "C-T1SM1");
  assert.equal(b.game.missing, 0);
  assert.deepEqual(b.game.players, [
    { initials: "MT", level: 3 },
    { initials: "RS", level: 4 },
  ]);
  assert.deepEqual(b.notices, [
    { event: "jugador_se_sumo", game_id: a.game.id, player_ids: [a.player_id] },
    { event: "partido_confirmado", game_id: a.game.id, player_ids: [a.player_id, b.player_id] },
  ]);
  // El segundo partido confirmado del turno toma la cancha 2.
  const c = await fullTenis(db, "18:00", "V-3", "V-4");
  assert.equal(c.game.court_id, "C-T2SM2");
});

test("unirse: si al completarse no queda cancha, el encuentro queda sin cancha y se avisa", async () => {
  const db = emptyGamesDb();
  // Se abren tres partidos mientras hay canchas libres...
  const a = await createGame(db, tenis(), "V-1", now);
  const b = await createGame(db, tenis(), "V-2", now);
  const c = await createGame(db, tenis(), "V-3", now);
  // ...y se completan: solo hay 2 canchas operativas.
  await joinGame(db, a.game.id, me(), "V-4", now);
  await joinGame(db, b.game.id, me(), "V-5", now);
  const r = await joinGame(db, c.game.id, me(), "V-6", now);
  assert.equal(r.game.status, "sin_cancha");
  assert.equal(r.game.court_id, null);
  assert.deepEqual(r.notices[1], {
    event: "partido_sin_cancha",
    game_id: c.game.id,
    player_ids: [c.player_id, r.player_id],
  });
  // Un encuentro sin cancha no admite más jugadores.
  await rejects(joinGame(db, c.game.id, me(), "V-7", now), "encuentro_completo");
});

test("unirse: pádel de 4 sigue abierto hasta el cuarto jugador", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, padel(4), "V-1", now);
  const b = await joinGame(db, a.game.id, me(), "V-2", now);
  assert.equal(b.game.status, "abierto");
  assert.equal(b.game.court_id, null);
  assert.equal(b.game.missing, 2);
  assert.equal(b.notices.length, 1);
  await joinGame(db, a.game.id, me(), "V-3", now);
  const d = await joinGame(db, a.game.id, me(), "V-4", now);
  assert.equal(d.game.status, "confirmado");
  assert.equal(d.game.court_id, "C-PASM4");
  await rejects(joinGame(db, a.game.id, me(), "V-5", now), "encuentro_completo");
});

test("unirse: pádel de 2 se confirma con el segundo jugador", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, padel(2), "V-1", now);
  const b = await joinGame(db, a.game.id, me(), "V-2", now);
  assert.equal(b.game.status, "confirmado");
});

test("unirse: solo jugadores de los niveles aceptados", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, tenis({ accepted_levels: [3, 4] }), "V-1", now);
  await assert.rejects(joinGame(db, a.game.id, me({ level: 2 }), "V-2", now), (err: unknown) => {
    assert.ok(err instanceof MatchError);
    assert.equal(err.code, "nivel_no_aceptado");
    assert.equal(err.message, "Este partido busca jugadores de niveles 3 y 4.");
    return true;
  });
  await rejects(joinGame(db, a.game.id, me({ level: 5 }), "V-2", now), "nivel_no_aceptado");
  const ok = await joinGame(db, a.game.id, me({ level: 4 }), "V-2", now);
  assert.equal(ok.game.status, "confirmado");
});

test("unirse: un visitante no puede ocupar dos cupos del mismo encuentro", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, padel(4), "V-1", now);
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
  const a = await createGame(db, tenis({ accepted_levels: [1, 2, 3, 4] }), "V-1", now);
  db.exec("DELETE FROM categories WHERE sport_id = 'D-TEN01' AND level = 4");
  await rejects(joinGame(db, a.game.id, me({ level: 4 }), "V-2", now), "datos_invalidos");
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

test("concurrencia: dos partidos se completan a la vez con una sola cancha libre", async () => {
  const db = emptyGamesDb();
  await fullTenis(db, "18:00", "V-1", "V-2"); // queda solo la cancha 2
  const a = await createGame(db, tenis(), "V-3", now);
  const b = await createGame(db, tenis(), "V-4", now);
  const [ra, rb] = await Promise.all([
    joinGame(db, a.game.id, me(), "V-5", now),
    joinGame(db, b.game.id, me(), "V-6", now),
  ]);
  assert.deepEqual([ra.game.status, rb.game.status].sort(), ["confirmado", "sin_cancha"]);
  assert.equal(db.count("SELECT count(*) AS n FROM games WHERE status = 'confirmado' AND court_id = 'C-T2SM2'"), 1);
});

// ---------------------------------------------------------------
// Cancelar
// ---------------------------------------------------------------

test("cancelar: si el encuentro queda sin jugadores se elimina", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, tenis(), "V-1", now);
  const r = await cancelByVisitor(db, a.game.id, "V-1", now);
  assert.deepEqual(r, { game_id: a.game.id, game_deleted: true, reopened: false, notices: [] });
  assert.equal(db.count("SELECT count(*) AS n FROM games"), 0);
});

test("cancelar: un encuentro confirmado vuelve a abierto, libera la cancha y se avisa al resto", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, tenis(), "V-1", now);
  const b = await joinGame(db, a.game.id, me(), "V-2", now);
  const r = await cancelByVisitor(db, a.game.id, "V-2", now);
  assert.equal(r.reopened, true);
  assert.equal(r.game_deleted, false);
  assert.deepEqual(r.notices, [{ event: "cupo_cancelado", game_id: a.game.id, player_ids: [a.player_id] }]);
  assert.deepEqual({ ...gameRow(db, a.game.id) }, { status: "abierto", court_id: null });
  const slot = (await getDayAvailability(db, "D-TEN01", DAY, now)).find((s) => s.time === "18:00")!;
  assert.equal(slot.free_courts, 2);
  // El cupo liberado puede volver a tomarse.
  const c = await joinGame(db, a.game.id, me(), "V-3", now);
  assert.equal(c.game.status, "confirmado");
  assert.ok(!db.get("SELECT 1 FROM players WHERE id = ?", b.player_id));
});

test("cancelar: un encuentro sin cancha vuelve a abierto y se avisa al resto", async () => {
  const db = emptyGamesDb();
  const games = [];
  for (const v of ["V-1", "V-2", "V-3"]) games.push(await createGame(db, tenis(), v, now));
  await joinGame(db, games[0]!.game.id, me(), "V-4", now);
  await joinGame(db, games[1]!.game.id, me(), "V-5", now);
  const c = await joinGame(db, games[2]!.game.id, me(), "V-6", now);
  assert.equal(c.game.status, "sin_cancha");
  const r = await cancelByVisitor(db, c.game.id, "V-6", now);
  assert.equal(r.reopened, true);
  assert.deepEqual(r.notices, [{ event: "cupo_cancelado", game_id: c.game.id, player_ids: [games[2]!.player_id] }]);
  assert.equal(gameRow(db, c.game.id).status, "abierto");
});

test("cancelar: un encuentro abierto con más jugadores sigue abierto", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, padel(4), "V-1", now);
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
  const g34 = await createGame(db, tenis({ time: "18:00", accepted_levels: [3, 4] }), "V-1", now);
  const g4 = await createGame(
    db,
    tenis({ time: "10:00", date: "2026-11-18", accepted_levels: [4, 5], player: me({ level: 4 }) }),
    "V-2",
    now,
  );
  await fullTenis(db, "12:00", "V-3", "V-4"); // confirmado: no aparece
  return { db, g34, g4 };
}

test("búsqueda: solo encuentros que aceptan el nivel del jugador", async () => {
  const { db, g34, g4 } = await searchScenario();
  const n4 = await searchGames(db, { sport_id: "D-TEN01", level: 4 }, "V-9", now);
  assert.deepEqual(n4.map((g) => g.id), [g34.game.id, g4.game.id]);
  const n3 = await searchGames(db, { sport_id: "D-TEN01", level: 3 }, "V-9", now);
  assert.deepEqual(n3.map((g) => g.id), [g34.game.id]);
  assert.deepEqual(await searchGames(db, { sport_id: "D-TEN01", level: 1 }, "V-9", now), []);
  await rejects(searchGames(db, { sport_id: "D-TEN01", level: undefined }, "V-9", now), "datos_invalidos");
});

test("búsqueda: el nivel 1 no coincide con 10 ni 11 (lista separada por comas)", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, tenis({ accepted_levels: [1, 2, 3] }), "V-1", now);
  db.exec(`UPDATE games SET accepted_levels = '2,3' WHERE id = '${a.game.id}'`);
  assert.deepEqual(await searchGames(db, { sport_id: "D-TEN01", level: 1 }, "V-9", now), []);
});

test("búsqueda: filtra por rango de fechas y de horas", async () => {
  const { db, g34, g4 } = await searchScenario();
  const q = { sport_id: "D-TEN01", level: 4 };
  const day = await searchGames(db, { ...q, date_from: DAY, date_to: DAY }, "V-9", now);
  assert.deepEqual(day.map((g) => g.id), [g34.game.id]);
  const morning = await searchGames(db, { ...q, time_from: "07:00", time_to: "11:00" }, "V-9", now);
  assert.deepEqual(morning.map((g) => g.id), [g4.game.id]);
  await rejects(searchGames(db, { ...q, time_from: "12:00", time_to: "09:00" }, "V-9", now), "datos_invalidos");
});

test("búsqueda: excluye los encuentros propios, completos y de otros deportes", async () => {
  const { db, g4 } = await searchScenario();
  const r = await searchGames(db, { sport_id: "D-TEN01", level: 4 }, "V-1", now);
  assert.deepEqual(r.map((g) => g.id), [g4.game.id]);
  assert.deepEqual(await searchGames(db, { sport_id: "D-TEN02", level: 4 }, "V-9", now), []);
});

test("búsqueda: excluye turnos ya cerrados", async () => {
  const { db, g4 } = await searchScenario();
  const later = { date: DAY, minutes: 18 * 60 + 16 };
  const r = await searchGames(db, { sport_id: "D-TEN01", level: 4 }, "V-9", later);
  assert.deepEqual(r.map((g) => g.id), [g4.game.id]);
});

// ---------------------------------------------------------------
// Privacidad
// ---------------------------------------------------------------

test("privacidad: las respuestas públicas solo traen iniciales y nivel", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, tenis({ player: me({ whatsapp: "+56912345678", whatsapp_opt_in: true }) }), "V-1", now);
  const day = await getDayAvailability(db, "D-TEN01", DAY, now, "V-2");
  const found = await searchGames(db, { sport_id: "D-TEN01", level: 3 }, "V-2", now);
  for (const payload of [a.game, day, found]) {
    const text = JSON.stringify(payload);
    assert.ok(!text.includes("example.com"), text);
    assert.ok(!text.includes("56912345678"), text);
    assert.ok(!text.includes("V-1"), text);
    assert.ok(!text.includes(a.cancel_token), text);
  }
  assert.deepEqual(Object.keys(found[0]!.players[0]!).sort(), ["initials", "level"]);
});
