import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { channelsFor } from "../src/notices.ts";
import { cancelGame, createBlock } from "../src/lib/config.ts";
import { consoleChannel, fechaLarga, renderEmail, resendChannel } from "../src/lib/email.ts";
import { createGame, joinGame } from "../src/lib/matching.ts";
import { loadNoticeGame, suggestSlots, type Channel, type NoticeEvent, type NoticeGame } from "../src/lib/notify.ts";
import { localNow } from "../src/lib/time.ts";
import { emptyGamesDb, TestDb } from "./helpers/db.ts";

// Lunes 16 de noviembre de 2026, 10:00 en Santiago (UTC-3).
const START = new Date("2026-11-16T13:00:00Z");
const NOW = localNow(START);
const DAY = "2026-11-17";
const SITE = "https://peloteo.cl";

interface Sent {
  event: NoticeEvent;
  to: string;
  game: NoticeGame;
  player_id: string;
}

/** App con un canal que guarda los avisos en vez de enviarlos. */
function world(db: TestDb = emptyGamesDb()) {
  let now = START;
  const sent: Sent[] = [];
  const capture: Channel = {
    name: "captura",
    async send(event, player, game) {
      sent.push({ event, to: player.email, game: structuredClone(game), player_id: player.id });
    },
  };
  const app = createApp({ now: () => now, channels: [capture] });
  function browser() {
    let cookie = "";
    return async (method: string, path: string, body?: unknown) => {
      const res = await app.request(
        path,
        {
          method,
          headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        },
        { DB: db },
      );
      const set = res.headers.get("Set-Cookie");
      if (set) cookie = set.split(";")[0]!;
      return { status: res.status, json: (await res.json()) as any };
    };
  }
  return { db, sent, browser, at: (iso: string) => (now = new Date(iso)) };
}

const player = (initials: string, extra: Record<string, unknown> = {}) => ({
  initials,
  level: 3,
  email: initials.toLowerCase() + "@example.com",
  ...extra,
});

const openTenis = (initials: string, time = "18:00") => ({
  sport_id: "D-TEN01",
  date: DAY,
  time,
  accepted_levels: [2, 3, 4],
  player: player(initials, { whatsapp: "+56 9 1111 2222" }),
});

function tokenOf(db: TestDb, initials: string): string {
  return db.get<{ cancel_token: string }>("SELECT cancel_token FROM players WHERE initials = ?", initials)!.cancel_token;
}

// ---------------------------------------------------------------
// Flujo completo con el canal de captura
// ---------------------------------------------------------------

test("avisos: publicado a quien abre; al completarse, confirmado a todos con cancha y contactos", async () => {
  const w = world();
  const a = w.browser();
  const b = w.browser();
  const g = (await a("POST", "/api/games", openTenis("MT"))).json.game;
  assert.deepEqual(
    w.sent.map((s) => [s.event, s.to]),
    [["partido_publicado", "mt@example.com"]],
  );
  w.sent.length = 0;

  await b("POST", `/api/games/${g.id}/join`, { player: player("RS") });
  // Al completarse no se manda "se sumó": basta "confirmado".
  assert.deepEqual(
    w.sent.map((s) => [s.event, s.to]),
    [
      ["partido_confirmado", "mt@example.com"],
      ["partido_confirmado", "rs@example.com"],
    ],
  );
  const toMT = w.sent[0]!;
  const mail = renderEmail(toMT.event, toMT.game.players.find((p) => p.id === toMT.player_id)!, toMT.game, SITE);
  assert.match(mail.subject, /^Partido confirmado: Tenis, martes 17 de noviembre a las 18:00$/);
  assert.match(mail.text, /Cancha: Cancha 1/);
  assert.match(mail.text, /rs@example\.com/); // contacto del compañero
  assert.ok(!mail.text.includes("mt@example.com")); // no su propio correo
  assert.match(mail.text, /#cancelar=[0-9a-f]{32}/);
  assert.match(mail.html, /href="https:\/\/peloteo\.cl\/#cancelar=[0-9a-f]{32}"/);
  // Cancelar y Mis partidos van como botones visibles, no como enlaces de texto.
  assert.match(mail.html, /<a href="https:\/\/peloteo\.cl\/#cancelar=[0-9a-f]{32}" style="display:inline-block[^"]*background:#A8492A[^"]*">Cancelar mi cupo<\/a>/);
  assert.match(mail.html, /<a href="https:\/\/peloteo\.cl\/#mis-partidos" style="display:inline-block[^"]*border:2px solid #1E6B4F[^"]*">Ver mis partidos<\/a>/);
  assert.match(mail.text, /Cancelar mi cupo: https:\/\/peloteo\.cl\/#cancelar=/);
});

test("avisos: pádel de 4, 'se sumó' a los que ya estaban mientras siga abierto", async () => {
  const w = world();
  const g = (
    await w.browser()("POST", "/api/games", { ...openTenis("AA"), sport_id: "D-PAD01", time: "18:30", capacity: 4 })
  ).json.game;
  w.sent.length = 0;
  await w.browser()("POST", `/api/games/${g.id}/join`, { player: player("BB") });
  assert.deepEqual(
    w.sent.map((s) => [s.event, s.to]),
    [["jugador_se_sumo", "aa@example.com"]],
  );
  const s = w.sent[0]!;
  const mail = renderEmail(s.event, s.game.players[0]!, s.game, SITE);
  assert.match(mail.text, /BB \(nivel 3\) se sumó a tu partido\. Todavía faltan 2 jugadores\./);
  // Sin datos de contacto mientras no esté confirmado.
  assert.ok(!mail.text.includes("bb@example.com"));
});

test("avisos: sin cancha al completarse, con turnos libres sugeridos", async () => {
  const w = world();
  const ids: string[] = [];
  for (const who of ["AA", "AB", "AC"]) ids.push((await w.browser()("POST", "/api/games", openTenis(who))).json.game.id);
  for (const [i, who] of ["BA", "BB", "BC"].entries()) await w.browser()("POST", `/api/games/${ids[i]}/join`, { player: player(who) });
  const sin = w.sent.filter((s) => s.event === "partido_sin_cancha");
  assert.deepEqual(
    sin.map((s) => s.to),
    ["ac@example.com", "bc@example.com"],
  );
  const game = sin[0]!.game;
  assert.ok(game.suggestions!.length > 0);
  assert.ok(game.suggestions!.every((x) => !(x.date === DAY && x.time === "18:00")));
  const mail = renderEmail("partido_sin_cancha", game.players[0]!, game, SITE);
  assert.match(mail.subject, /no quedan canchas/);
  assert.match(mail.text, /turnos con cancha libre/i);
  assert.ok(!mail.text.includes("bc@example.com"));
});

test("sugerencias: turnos libres cercanos, sin el propio, en el mismo día y los dos siguientes", async () => {
  const db = emptyGamesDb();
  const s = await suggestSlots(db, { sport_id: "D-TEN01", date: DAY, time: "18:00" }, NOW);
  assert.ok(s.length > 0 && s.length <= 6);
  assert.ok(s.every((x) => x.date >= DAY && x.date <= "2026-11-19"));
  assert.ok(!s.some((x) => x.date === DAY && x.time === "18:00"));
  // Ordenadas por fecha y hora.
  assert.deepEqual([...s].sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1)), s);
});

// ---------------------------------------------------------------
// Enlace de cancelación con token
// ---------------------------------------------------------------

test("enlace: muestra el partido sin contactos y cancela el cupo desde otro dispositivo", async () => {
  const w = world();
  const g = (await w.browser()("POST", "/api/games", openTenis("MT"))).json.game;
  await w.browser()("POST", `/api/games/${g.id}/join`, { player: player("RS") });
  w.sent.length = 0;

  const other = w.browser(); // otro dispositivo, sin la cookie del jugador
  const token = tokenOf(w.db, "RS");
  const seen = await other("POST", "/api/token/game", { token });
  assert.equal(seen.status, 200);
  assert.equal(seen.json.game.status, "confirmado");
  assert.equal(seen.json.game.can_cancel, true);
  assert.ok(seen.json.game.players.every((p: any) => p.email === undefined));
  assert.deepEqual(
    seen.json.game.players.map((p: any) => [p.initials, p.me]),
    [
      ["MT", false],
      ["RS", true],
    ],
  );

  const done = await other("POST", "/api/token/cancel", { token });
  assert.deepEqual(done.json, { cancelled: true, game_deleted: false });
  // El partido vuelve a abierto y se avisa al otro jugador.
  assert.deepEqual(
    w.sent.map((s) => [s.event, s.to]),
    [["cupo_cancelado", "mt@example.com"]],
  );
  assert.equal(w.db.get<{ status: string }>("SELECT status FROM games WHERE id = ?", g.id)!.status, "abierto");
  // El enlace ya no sirve.
  assert.equal((await other("POST", "/api/token/game", { token })).status, 404);
  assert.equal((await other("POST", "/api/token/cancel", { token })).status, 404);
});

test("enlace: token inválido o fuera de plazo", async () => {
  const w = world();
  await w.browser()("POST", "/api/games", openTenis("MT"));
  const b = w.browser();
  assert.equal((await b("POST", "/api/token/game", { token: "nope" })).status, 404);
  assert.equal((await b("POST", "/api/token/game", {})).status, 404);
  assert.equal((await b("POST", "/api/token/cancel", { token: "0".repeat(32) })).status, 404);
  // 17:05 del día del partido: faltan menos de 60 minutos.
  w.at("2026-11-17T20:05:00Z");
  const token = tokenOf(w.db, "MT");
  assert.equal((await b("POST", "/api/token/game", { token })).json.game.can_cancel, false);
  const late = await b("POST", "/api/token/cancel", { token });
  assert.equal(late.status, 400);
  assert.equal(late.json.code, "cancelacion_cerrada");
});

// ---------------------------------------------------------------
// Cancelación por el administrador o por un bloqueo
// ---------------------------------------------------------------

async function confirmedGame(db: TestDb) {
  const a = await createGame(db, openTenis("MT"), "V-1", NOW);
  await joinGame(db, a.game.id, player("RS"), "V-2", NOW);
  return a.game.id;
}

test("avisos: encuentro cancelado por el administrador o por un bloqueo, con su motivo", async () => {
  const db = emptyGamesDb();
  const id = await confirmedGame(db);
  const admin = await cancelGame(db, id);
  assert.deepEqual(admin.map((n) => n.cause), ["administrador"]);
  const game = (await loadNoticeGame(db, id))!;
  const mail = renderEmail("encuentro_cancelado", game.players[0]!, { ...game, cause: "administrador" }, SITE);
  assert.match(mail.subject, /^Partido cancelado: Tenis/);
  assert.match(mail.text, /la administración del lugar canceló/);
  assert.ok(!mail.text.includes("#cancelar=")); // ya no hay cupo que liberar

  const db2 = emptyGamesDb();
  const id2 = await confirmedGame(db2);
  const court = db2.get<{ court_id: string }>("SELECT court_id FROM games WHERE id = ?", id2)!.court_id;
  const r = await createBlock(db2, court, { date: DAY, start_time: "18:00", end_time: "19:00" }, true, NOW);
  assert.ok(r.created);
  assert.deepEqual(r.notices.map((n) => [n.event, n.cause, n.player_ids.length]), [["encuentro_cancelado", "bloqueo", 2]]);
  const g2 = (await loadNoticeGame(db2, id2))!;
  const mail2 = renderEmail("encuentro_cancelado", g2.players[0]!, { ...g2, cause: "bloqueo" }, SITE);
  assert.match(mail2.text, /la cancha no estará disponible en ese horario/);
});

test("correos: ningún aviso, salvo confirmado, lleva datos de contacto", async () => {
  const db = emptyGamesDb();
  const id = await confirmedGame(db);
  const game = (await loadNoticeGame(db, id))!;
  const [mt, rs] = game.players;
  for (const ev of ["partido_publicado", "jugador_se_sumo", "partido_sin_cancha", "cupo_cancelado", "encuentro_cancelado"] as const) {
    const m = renderEmail(ev, mt!, game, SITE);
    assert.ok(!m.text.includes(rs!.email) && !m.html.includes(rs!.email), ev);
    assert.ok(!m.text.includes("+56"), ev);
  }
  // El HTML escapa lo que escribe el administrador.
  const html = renderEmail("partido_confirmado", mt!, { ...game, court_notes: "<b>ojo</b>" }, SITE).html;
  assert.ok(html.includes("&lt;b&gt;ojo&lt;/b&gt;"));
  assert.equal(fechaLarga("2026-11-21"), "sábado 21 de noviembre");
});

// ---------------------------------------------------------------
// Canales
// ---------------------------------------------------------------

test("Resend: envía con fetch, remitente, destinatario y User-Agent; un error no expone el correo", async () => {
  const db = emptyGamesDb();
  const id = await confirmedGame(db);
  const game = (await loadNoticeGame(db, id))!;
  const calls: { url: string; init: RequestInit }[] = [];
  const ok = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ id: "x" }), { status: 200 });
  }) as unknown as typeof fetch;
  const ch = resendChannel("re_prueba", { site: SITE, from: "Peloteo <avisos@peloteo.cl>" }, ok);
  await ch.send("partido_confirmado", game.players[0]!, game);
  assert.equal(calls[0]!.url, "https://api.resend.com/emails");
  const h = calls[0]!.init.headers as Record<string, string>;
  assert.equal(h.Authorization, "Bearer re_prueba");
  assert.ok(h["User-Agent"]);
  const body = JSON.parse(calls[0]!.init.body as string);
  assert.equal(body.from, "Peloteo <avisos@peloteo.cl>");
  assert.deepEqual(body.to, ["mt@example.com"]);
  assert.ok(body.subject && body.html && body.text);
  assert.deepEqual(body.tags, [{ name: "evento", value: "partido_confirmado" }]);

  const bad = (async () =>
    new Response(JSON.stringify({ name: "validation_error", message: "mt@example.com" }), { status: 422 })) as unknown as typeof fetch;
  await assert.rejects(
    resendChannel("re_prueba", { site: SITE, from: "x" }, bad).send("partido_confirmado", game.players[0]!, game),
    (err: Error) => /422 \(validation_error\)/.test(err.message) && !err.message.includes("@"),
  );
});

test("canales: en local se muestran en consola; en producción, Resend solo con la clave", () => {
  const db = emptyGamesDb();
  const names = (env: Record<string, string>, url: string) =>
    channelsFor({ DB: db, ...env }, url).map((c) => c.name);
  // Sin EMAIL_MODE (pruebas): solo registro.
  assert.deepEqual(names({}, "https://peloteo.cl/api/games"), ["registro"]);
  // En localhost nunca se envía, aunque haya clave.
  assert.deepEqual(names({ EMAIL_MODE: "resend", RESEND_API_KEY: "re_x" }, "http://localhost:8787/api/games"), [
    "registro",
    "consola",
  ]);
  assert.deepEqual(names({ EMAIL_MODE: "resend", RESEND_API_KEY: "re_x" }, "https://peloteo.cl/api/games"), [
    "registro",
    "correo",
  ]);
  assert.deepEqual(names({ EMAIL_MODE: "consola", RESEND_API_KEY: "re_x" }, "https://peloteo.cl/api/games"), [
    "registro",
    "consola",
  ]);
});

test("consola: muestra el correo con enlaces al servidor local", async () => {
  const db = emptyGamesDb();
  const id = await confirmedGame(db);
  const game = (await loadNoticeGame(db, id))!;
  const out: string[] = [];
  const [, ch] = channelsFor({ DB: db, EMAIL_MODE: "resend" }, "http://localhost:8787/api/games");
  assert.equal(ch!.name, "consola");
  await consoleChannel({ site: "http://localhost:8787", from: "Peloteo <avisos@peloteo.cl>" }, (s) => out.push(s)).send(
    "partido_publicado",
    game.players[0]!,
    game,
  );
  assert.match(out[0]!, /Para: mt@example\.com/);
  assert.match(out[0]!, /Asunto: Tu partido de Tenis está publicado/);
  assert.match(out[0]!, /http:\/\/localhost:8787\/#cancelar=[0-9a-f]{32}/);
});
