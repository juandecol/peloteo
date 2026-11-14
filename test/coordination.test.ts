import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { getDayAvailability } from "../src/lib/availability.ts";
import { renderEmail } from "../src/lib/email.ts";
import { cancelByVisitor, createGame, joinGame, MatchError, type CreateGameInput, type PlayerInput } from "../src/lib/matching.ts";
import { loadNoticeGame } from "../src/lib/notify.ts";
import { localNow } from "../src/lib/time.ts";
import { emptyGamesDb } from "./helpers/db.ts";

// Modo "coordinacion": Peloteo no conoce la ocupación real de las canchas. Las
// canchas configuradas solo definen el horario y cuántos partidos pueden
// confirmarse a la vez; un partido completo se confirma sin cancha.

// Lunes 16 de noviembre de 2026, 10:00 en Santiago. Tenis tiene 2 canchas operativas.
const now = localNow(new Date("2026-11-16T13:00:00Z"));
const DAY = "2026-11-17";
const C = "coordinacion" as const;

const me = (over: Partial<PlayerInput> = {}): PlayerInput => ({ initials: "MT", level: 3, email: "mt@example.com", ...over });
const tenis = (over: Partial<CreateGameInput> = {}): CreateGameInput => ({
  sport_id: "D-TEN01",
  capacity: 2, // tenis admite singles (2) o dobles (4): migración 0008
  date: DAY,
  time: "18:00",
  accepted_levels: [1, 2, 3, 4, 5],
  player: me(),
  ...over,
});

async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(p, (err: unknown) => err instanceof MatchError && err.code === code);
}

test("coordinación: al completarse se confirma sin cancha", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, tenis(), "V-1", now, C);
  const b = await joinGame(db, a.game.id, me({ initials: "RS" }), "V-2", now, C);
  assert.equal(b.game.status, "confirmado");
  assert.equal(b.game.court_id, null);
  assert.deepEqual(b.notices.map((n) => n.event), ["partido_confirmado"]);
});

test("coordinación: a la misma hora se confirman como máximo tantos partidos como canchas", async () => {
  const db = emptyGamesDb();
  // Los abiertos no ocupan: se pueden abrir varios a la misma hora.
  const games = [];
  for (const v of ["V-1", "V-2", "V-3"]) games.push(await createGame(db, tenis(), v, now, C));
  const slot = async () => (await getDayAvailability(db, "D-TEN01", DAY, now, null, C)).find((s) => s.time === "18:00")!;
  assert.equal((await slot()).free_courts, 2);

  assert.equal((await joinGame(db, games[0]!.game.id, me(), "V-4", now, C)).game.status, "confirmado");
  assert.equal((await slot()).free_courts, 1);
  assert.equal((await joinGame(db, games[1]!.game.id, me(), "V-5", now, C)).game.status, "confirmado");
  assert.equal((await slot()).free_courts, 0);
  // El tercero ya no cabe: queda completo sin cancha.
  const third = await joinGame(db, games[2]!.game.id, me(), "V-6", now, C);
  assert.equal(third.game.status, "sin_cancha");
  // Y no se puede abrir otro a esa hora.
  await rejects(createGame(db, tenis(), "V-7", now, C), "turno_ocupado");
  // Otra hora sigue disponible.
  assert.equal((await createGame(db, tenis({ time: "19:00" }), "V-7", now, C)).game.status, "abierto");
});

test("coordinación: un bloqueo de cancha reduce los partidos posibles a esa hora", async () => {
  const db = emptyGamesDb();
  db.exec(`INSERT INTO court_blocks (id, court_id, date, start_time, end_time) VALUES ('B-AAAAA', 'C-T1SM1', '${DAY}', '18:00', '19:00')`);
  const a = await createGame(db, tenis(), "V-1", now, C);
  const b = await createGame(db, tenis(), "V-2", now, C);
  assert.equal((await joinGame(db, a.game.id, me(), "V-3", now, C)).game.status, "confirmado");
  assert.equal((await joinGame(db, b.game.id, me(), "V-4", now, C)).game.status, "sin_cancha");
});

test("coordinación: cancelar un cupo de un confirmado lo reabre y libera su lugar", async () => {
  const db = emptyGamesDb();
  const a = await createGame(db, tenis(), "V-1", now, C);
  await joinGame(db, a.game.id, me(), "V-2", now, C);
  const r = await cancelByVisitor(db, a.game.id, "V-2", now);
  assert.equal(r.reopened, true);
  const row = db.get<{ status: string; court_id: string | null }>("SELECT status, court_id FROM games WHERE id = ?", a.game.id)!;
  assert.deepEqual({ ...row }, { status: "abierto", court_id: null });
});

test("coordinación: rutas con COURT_MODE, y correos que piden reservar con el club", async () => {
  const db = emptyGamesDb();
  const app = createApp({ now: () => new Date("2026-11-16T13:00:00Z") });
  const env = { DB: db, COURT_MODE: "coordinacion" };
  const req = async (method: string, path: string, body?: unknown, cookie = "") => {
    const res = await app.request(path, { method, headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) }, body: body ? JSON.stringify(body) : undefined }, env);
    return { json: (await res.json()) as any, cookie: (res.headers.get("Set-Cookie") ?? "").split(";")[0]! };
  };
  assert.equal((await req("GET", "/api/today")).json.court_mode, "coordinacion");
  const a = await req("POST", "/api/games", tenis());
  const b = await req("POST", `/api/games/${a.json.game.id}/join`, { player: me({ initials: "RS", email: "rs@example.com" }) });
  assert.equal(b.json.game.status, "confirmado");
  assert.equal(b.json.game.court, null);
  // El contacto del compañero sí se comparte.
  assert.equal(b.json.game.players.find((p: any) => !p.me).email, "mt@example.com");

  const game = (await loadNoticeGame(db, a.json.game.id))!;
  game.court_mode = "coordinacion";
  const confirmed = renderEmail("partido_confirmado", game.players[0]!, game, "https://peloteo.cl");
  assert.match(confirmed.text, /reserven la cancha directamente con el club/);
  assert.ok(!/^Cancha:/m.test(confirmed.text));
  const published = renderEmail("partido_publicado", game.players[0]!, game, "https://peloteo.cl");
  assert.match(published.text, /reserven la cancha con el club/);
  assert.ok(!published.text.includes("asignamos la primera cancha"));
});
