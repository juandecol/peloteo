import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { linkPlayers, requestLoginLink, signInWithLink, updateProfile, getProfile, AccountError } from "../src/lib/accounts.ts";
import type { Email } from "../src/lib/email.ts";
import { emptyGamesDb, TestDb } from "./helpers/db.ts";

// Lunes 16 de noviembre de 2026, 10:00 en Santiago (UTC-3).
const START = new Date("2026-11-16T13:00:00Z");
const DAY = "2026-11-17";

function world(enabled = true, db: TestDb = emptyGamesDb()) {
  let now = START;
  const mails: { to: string; mail: Email }[] = [];
  const app = createApp({ now: () => now, mailer: async (to, mail) => void mails.push({ to, mail }) });
  const env = { DB: db, ...(enabled ? { ACCOUNTS_ENABLED: "1" } : {}) };
  function browser() {
    const jar = new Map<string, string>();
    async function req(method: string, path: string, body?: unknown) {
      const res = await app.request(
        path,
        {
          method,
          headers: {
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(jar.size ? { Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join("; ") } : {}),
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        },
        env,
      );
      for (const c of res.headers.getSetCookie()) {
        const [kv] = c.split(";");
        const [k, v] = kv!.split("=");
        if (v) jar.set(k!, v);
        else jar.delete(k!);
      }
      return { status: res.status, json: (await res.json()) as any, cookies: res.headers.getSetCookie() };
    }
    return { req, jar };
  }
  /** Pide el enlace y devuelve el token que llegó por correo. */
  async function linkToken(b: ReturnType<typeof browser>, email: string) {
    const r = await b.req("POST", "/api/account/link", { email });
    assert.equal(r.status, 200, JSON.stringify(r.json));
    const m = /#entrar=([0-9a-f]{64})/.exec(mails[mails.length - 1]!.mail.text);
    return m![1]!;
  }
  return { db, mails, browser, linkToken, at: (iso: string) => (now = new Date(iso)), advance: (min: number) => (now = new Date(now.getTime() + min * 60_000)) };
}

const player = (initials: string, email = initials.toLowerCase() + "@example.com") => ({ initials, level: 3, email, rama: "masculina", intent: "diversion", terms: true });
const openTenis = (initials: string, email?: string) => ({
  sport_id: "D-TEN01",
  capacity: 2, // tenis admite singles (2) o dobles (4): migración 0008
  date: DAY,
  time: "18:00",
  accepted_levels: [2, 3, 4],
  player: player(initials, email),
});

// ---------------------------------------------------------------
// Desactivadas (estado actual)
// ---------------------------------------------------------------

test("cuentas desactivadas: las rutas no existen y el sitio funciona como antes", async () => {
  const w = world(false);
  const b = w.browser();
  for (const [m, path] of [["POST", "/api/account/link"], ["POST", "/api/account/login"], ["GET", "/api/account/me"], ["POST", "/api/account/logout"]] as const) {
    assert.equal((await b.req(m, path, m === "POST" ? {} : undefined)).status, 404, path);
  }
  const g = (await b.req("POST", "/api/games", openTenis("MT"))).json.game;
  assert.equal(g.status, "abierto");
  assert.equal(w.db.get<{ user_id: string | null }>("SELECT user_id FROM players")!.user_id, null);
  assert.equal(w.mails.length, 0);
  assert.ok(![...b.jar.keys()].includes("peloteo_user"));
});

// ---------------------------------------------------------------
// Enlace de ingreso
// ---------------------------------------------------------------

test("enlace: valida el correo, guarda solo el hash y limita a 3 cada 15 minutos", async () => {
  const w = world();
  const b = w.browser();
  assert.equal((await b.req("POST", "/api/account/link", { email: "no-es-correo" })).status, 400);
  const token = await w.linkToken(b, "  MT@Example.com ");
  assert.equal(w.mails[0]!.to, "mt@example.com");
  assert.match(w.mails[0]!.mail.subject, /enlace para entrar/);
  const stored = w.db.get<{ token_hash: string; email: string }>("SELECT token_hash, email FROM login_links")!;
  assert.equal(stored.email, "mt@example.com");
  assert.notEqual(stored.token_hash, token);
  await w.linkToken(b, "mt@example.com");
  await w.linkToken(b, "mt@example.com");
  const fourth = await b.req("POST", "/api/account/link", { email: "mt@example.com" });
  assert.equal(fourth.status, 429);
  w.advance(16);
  assert.equal((await b.req("POST", "/api/account/link", { email: "mt@example.com" })).status, 200);
});

test("enlace: sirve una sola vez y vence a los 15 minutos", async () => {
  const w = world();
  const b = w.browser();
  const token = await w.linkToken(b, "mt@example.com");
  assert.equal((await b.req("POST", "/api/account/login", { token })).status, 200);
  assert.equal((await w.browser().req("POST", "/api/account/login", { token })).status, 400);

  const late = await w.linkToken(b, "rs@example.com");
  w.advance(16);
  const r = await b.req("POST", "/api/account/login", { token: late });
  assert.equal(r.status, 400);
  assert.equal(r.json.code, "enlace_invalido");
  assert.equal((await b.req("POST", "/api/account/login", { token: "x" })).status, 400);
});

// ---------------------------------------------------------------
// Cuenta: traspaso de partidos y uso desde otro dispositivo
// ---------------------------------------------------------------

test("cuenta: al entrar, los partidos del navegador y del correo pasan a la cuenta y se ven en otro dispositivo", async () => {
  const w = world();
  const phone = w.browser();
  const g = (await phone.req("POST", "/api/games", openTenis("MT"))).json.game;

  // Entra desde el teléfono: el partido pasa a la cuenta.
  const login = await phone.req("POST", "/api/account/login", { token: await w.linkToken(phone, "mt@example.com") });
  assert.equal(login.status, 200);
  assert.equal(login.json.linked_players, 1);
  const cookie = login.cookies.find((c) => c.startsWith("peloteo_user="))!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /Secure/);
  assert.match(cookie, /SameSite=Lax/);
  assert.equal(w.db.get<{ n: number }>("SELECT count(*) AS n FROM players WHERE user_id IS NOT NULL")!.n, 1);
  // La base guarda el hash de la sesión, no el token.
  const token = phone.jar.get("peloteo_user")!;
  assert.equal(w.db.get<{ n: number }>("SELECT count(*) AS n FROM user_sessions WHERE id = ?", token)!.n, 0);

  // En otro dispositivo, con la misma cuenta, se ven y se pueden cancelar.
  const laptop = w.browser();
  await laptop.req("POST", "/api/account/login", { token: await w.linkToken(laptop, "mt@example.com") });
  const mine = (await laptop.req("GET", "/api/me/games")).json;
  assert.deepEqual(mine.map((x: any) => x.id), [g.id]);
  assert.equal(mine[0].players[0].me, true);
  // En el inicio se ve como propio (también desde otro dispositivo), y no puede ocupar otro cupo.
  const block = (await laptop.req("GET", `/api/open/block?date=${DAY}&half=pm`)).json;
  assert.deepEqual(block.map((x: any) => [x.id, x.mine]), [[g.id, true]]);
  const again = await laptop.req("POST", `/api/games/${g.id}/join`, { player: player("MT") });
  assert.equal(again.status, 409);
  assert.equal(again.json.code, "ya_inscrito");
  assert.equal((await laptop.req("POST", `/api/games/${g.id}/cancel`, {})).status, 200);
  assert.equal((await phone.req("GET", "/api/me/games")).json.length, 0);
});

test("cuenta: los partidos nuevos quedan en la cuenta; al salir, vuelve a ser un navegador anónimo", async () => {
  const w = world();
  const b = w.browser();
  await b.req("POST", "/api/account/login", { token: await w.linkToken(b, "mt@example.com") });
  const g = (await b.req("POST", "/api/games", openTenis("MT"))).json.game;
  const owner = w.db.get<{ user_id: string }>("SELECT user_id FROM players WHERE game_id = ?", g.id)!.user_id;
  assert.match(owner, /^U-/);
  assert.equal((await b.req("GET", "/api/account/me")).json.user.email, "mt@example.com");

  assert.equal((await b.req("POST", "/api/account/logout", {})).status, 200);
  assert.equal((await b.req("GET", "/api/account/me")).json.user, null);
  // El navegador sigue reconociendo su cupo por la cookie visitor_id.
  assert.equal((await b.req("GET", "/api/me/games")).json.length, 1);
  // Sesión vencida: ya no reconoce la cuenta.
  const c = w.browser();
  await c.req("POST", "/api/account/login", { token: await w.linkToken(c, "rs@example.com") });
  w.advance(91 * 24 * 60);
  assert.equal((await c.req("GET", "/api/account/me")).json.user, null);
});

test("traspaso: una cuenta no queda con dos cupos del mismo encuentro", async () => {
  const db = emptyGamesDb();
  db.exec(`INSERT INTO users (id, email) VALUES ('U-AAAAAAAA', 'mt@example.com');
           INSERT INTO games (id, venue_id, sport_id, date, time, capacity, accepted_levels) VALUES ('E-AAAAA', 'L-SM001', 'D-PAD01', '${DAY}', '18:30', 4, '1,2,3,4,5');
           INSERT INTO players (id, game_id, visitor_id, initials, level, email, cancel_token) VALUES
             ('J-1', 'E-AAAAA', 'V-1', 'MT', 3, 'mt@example.com', 'a'),
             ('J-2', 'E-AAAAA', 'V-2', 'MT', 3, 'MT@example.com', 'b'),
             ('J-3', 'E-AAAAA', 'V-3', 'RS', 3, 'rs@example.com', 'c');`);
  assert.equal(await linkPlayers(db, "U-AAAAAAAA", "mt@example.com", "V-9"), 1);
  assert.deepEqual(
    (db.raw.prepare("SELECT id, user_id FROM players ORDER BY id").all() as any[]).map((r) => [r.id, r.user_id]),
    [["J-1", "U-AAAAAAAA"], ["J-2", null], ["J-3", null]],
  );
  // Repetir no cambia nada.
  assert.equal(await linkPlayers(db, "U-AAAAAAAA", "mt@example.com", "V-2"), 0);
});

// ---------------------------------------------------------------
// Perfil
// ---------------------------------------------------------------

test("perfil: iniciales, WhatsApp y nivel por deporte, con las reglas de siempre", async () => {
  const db = emptyGamesDb();
  const { token } = await requestLoginLink(db, "mt@example.com", null, START);
  const { user } = await signInWithLink(db, token, START);
  await assert.rejects(updateProfile(db, user.id, { initials: "M" }), (e: AccountError) => e.field === "initials");
  await assert.rejects(updateProfile(db, user.id, { initials: "MT", whatsapp: "123" }), (e: AccountError) => e.field === "whatsapp");
  await assert.rejects(updateProfile(db, user.id, { initials: "MT", levels: { tenis: 7 } }), (e: AccountError) => e.field === "levels");
  const p = await updateProfile(db, user.id, { initials: "mt", whatsapp: "+56 9 1111 2222", whatsapp_opt_in: true, levels: { tenis: 3, padel: 4 } });
  assert.deepEqual(
    { initials: p.initials, whatsapp: p.whatsapp, opt: p.whatsapp_opt_in, levels: p.levels },
    { initials: "MT", whatsapp: "+56911112222", opt: true, levels: { padel: 4, tenis: 3 } },
  );
  await updateProfile(db, user.id, { initials: "MT", levels: { tenis: 2 } });
  assert.deepEqual((await getProfile(db, user.id))!.levels, { padel: 4, tenis: 2 });
  // Sin WhatsApp no hay aviso por WhatsApp.
  assert.equal((await updateProfile(db, user.id, { initials: "MT", whatsapp: "", whatsapp_opt_in: true })).whatsapp_opt_in, false);
});
