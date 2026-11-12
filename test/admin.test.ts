import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { getDayAvailability } from "../src/lib/availability.ts";
import { createGame, joinGame, MatchError } from "../src/lib/matching.ts";
import { hashPassword, verifyPassword } from "../src/lib/auth.ts";
import { localNow } from "../src/lib/time.ts";
import { emptyGamesDb, TestDb } from "./helpers/db.ts";

// Lunes 16 de noviembre de 2026, 10:00 en Santiago (UTC-3).
const START = new Date("2026-11-16T13:00:00Z");
const NEW_PASSWORD = "cancha-de-arcilla-2026";

function setup(db: TestDb = emptyGamesDb()) {
  let now = START;
  const app = createApp({ now: () => now });
  const env = { DB: db };
  let cookie = "";
  async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await app.request(
      path,
      {
        method,
        headers: {
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers,
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
      },
      env,
    );
    const set = res.headers.get("Set-Cookie");
    if (set) cookie = set.split(";")[0]!.endsWith("=") ? "" : set.split(";")[0]!;
    const text = await res.text();
    let json: any = null;
    try {
      json = JSON.parse(text);
    } catch {
      json = text;
    }
    return { status: res.status, json, setCookie: set };
  }
  return {
    db,
    req,
    advance(minutes: number) {
      now = new Date(now.getTime() + minutes * 60_000);
    },
    get now() {
      return localNow(now);
    },
    setCookie(v: string) {
      cookie = v;
    },
    get cookie() {
      return cookie;
    },
  };
}

/** Entra como admin y cambia la contraseña inicial: deja la sesión lista para /api. */
async function ready(t = setup()) {
  assert.equal((await t.req("POST", "/admin/login", { username: "admin", password: "admin" })).status, 200);
  const r = await t.req("POST", "/admin/password", { current_password: "admin", new_password: NEW_PASSWORD });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return t;
}

// ---------------------------------------------------------------
// Contraseñas
// ---------------------------------------------------------------

test("contraseñas: PBKDF2 con sal por usuario; el hash inicial de la migración corresponde a 'admin'", async () => {
  const a = await hashPassword("secreto-largo");
  const b = await hashPassword("secreto-largo");
  assert.notEqual(a.salt, b.salt);
  assert.notEqual(a.hash, b.hash);
  assert.match(a.hash, /^pbkdf2-sha256\$100000\$[0-9a-f]{64}$/);
  assert.ok(await verifyPassword("secreto-largo", a));
  assert.ok(!(await verifyPassword("otro", a)));
  const db = new TestDb();
  const row = db.get<{ password_hash: string; password_salt: string }>("SELECT password_hash, password_salt FROM admins WHERE username = 'admin'")!;
  assert.ok(await verifyPassword("admin", { hash: row.password_hash, salt: row.password_salt }));
});

// ---------------------------------------------------------------
// Login, sesión y cookies
// ---------------------------------------------------------------

test("login: credenciales correctas crean una sesión con cookie HttpOnly, Secure, SameSite=Strict", async () => {
  const t = setup();
  const r = await t.req("POST", "/admin/login", { username: "Admin ", password: "admin" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { logged_in: true, needs_second_factor: false, must_change_password: true });
  const c = r.setCookie!;
  assert.match(c, /^peloteo_admin=[0-9a-f]{64};/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  assert.match(c, /SameSite=Strict/);
  assert.match(c, /Path=\/admin/);
  assert.match(c, /Max-Age=43200/);
  // En la base se guarda el hash del token, no el token.
  const token = t.cookie.split("=")[1]!;
  assert.equal(t.db.count("SELECT count(*) AS n FROM sessions WHERE id = ?", token), 0);
  assert.equal(t.db.count("SELECT count(*) AS n FROM sessions"), 1);
});

test("login: credenciales incorrectas responden igual para usuario inexistente", async () => {
  const t = setup();
  const a = await t.req("POST", "/admin/login", { username: "admin", password: "mala" });
  const b = await t.req("POST", "/admin/login", { username: "nadie", password: "mala" });
  assert.equal(a.status, 401);
  assert.equal(b.status, 401);
  assert.deepEqual(a.json, b.json);
  assert.equal(a.setCookie, null);
});

test("login: tras 2 intentos fallidos se bloquea 15 minutos, aun con la contraseña correcta", async () => {
  const t = setup();
  await t.req("POST", "/admin/login", { username: "admin", password: "x1" });
  await t.req("POST", "/admin/login", { username: "admin", password: "x2" });
  const blocked = await t.req("POST", "/admin/login", { username: "admin", password: "admin" });
  assert.equal(blocked.status, 429);
  assert.match(blocked.json.error, /15 minutos/);
  // Otra IP no queda bloqueada.
  const other = await t.req("POST", "/admin/login", { username: "admin", password: "admin" }, { "CF-Connecting-IP": "203.0.113.9" });
  assert.equal(other.status, 200);
  t.setCookie("");
  t.advance(14);
  assert.equal((await t.req("POST", "/admin/login", { username: "admin", password: "admin" })).status, 429);
  t.advance(2);
  assert.equal((await t.req("POST", "/admin/login", { username: "admin", password: "admin" })).status, 200);
  // El ingreso exitoso limpia los intentos de ese usuario e IP.
  assert.equal(t.db.count("SELECT count(*) AS n FROM login_attempts WHERE ip = 'local'"), 0);
});

test("sesión: expira a las 12 horas", async () => {
  const t = setup();
  await t.req("POST", "/admin/login", { username: "admin", password: "admin" });
  assert.equal((await t.req("GET", "/admin/session")).json.logged_in, true);
  t.advance(12 * 60);
  assert.deepEqual((await t.req("GET", "/admin/session")).json, { logged_in: false });
});

test("sesión: logout la invalida en el servidor", async () => {
  const t = await ready();
  const token = t.cookie;
  const r = await t.req("POST", "/admin/logout", {});
  assert.equal(r.status, 200);
  assert.match(r.setCookie!, /peloteo_admin=;/);
  t.setCookie(token); // aunque alguien conserve la cookie, ya no sirve
  assert.equal((await t.req("GET", "/admin/api/venues")).status, 401);
});

test("sin sesión, la configuración responde 401", async () => {
  const t = setup();
  const r = await t.req("GET", "/admin/api/venues");
  assert.equal(r.status, 401);
  assert.equal(r.json.code, "sin_sesion");
  t.setCookie("peloteo_admin=" + "a".repeat(64));
  assert.equal((await t.req("GET", "/admin/api/venues")).status, 401);
});

// ---------------------------------------------------------------
// Cambio obligatorio de contraseña
// ---------------------------------------------------------------

test("primer ingreso: obliga a cambiar la contraseña antes de configurar", async () => {
  const t = setup();
  await t.req("POST", "/admin/login", { username: "admin", password: "admin" });
  const blocked = await t.req("GET", "/admin/api/venues");
  assert.equal(blocked.status, 403);
  assert.equal(blocked.json.code, "cambiar_contrasena");

  const wrong = await t.req("POST", "/admin/password", { current_password: "mala", new_password: NEW_PASSWORD });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.code, "actual_incorrecta");
  for (const bad of ["corta", "admin", "ADMIN"]) {
    const r = await t.req("POST", "/admin/password", { current_password: "admin", new_password: bad });
    assert.equal(r.status, 400, bad);
  }
  assert.equal((await t.req("POST", "/admin/password", { current_password: "admin", new_password: NEW_PASSWORD })).status, 200);
  assert.equal((await t.req("GET", "/admin/api/venues")).status, 200);
  assert.equal((await t.req("GET", "/admin/session")).json.must_change_password, false);

  const row = t.db.get<{ password_hash: string; must_change_password: number }>("SELECT password_hash, must_change_password FROM admins")!;
  assert.equal(row.must_change_password, 0);
  assert.ok(!row.password_hash.includes(NEW_PASSWORD));
});

test("cambiar la contraseña cierra las demás sesiones", async () => {
  const t = setup();
  await t.req("POST", "/admin/login", { username: "admin", password: "admin" });
  const other = t.cookie;
  await t.req("POST", "/admin/login", { username: "admin", password: "admin" });
  await t.req("POST", "/admin/password", { current_password: "admin", new_password: NEW_PASSWORD });
  assert.equal((await t.req("GET", "/admin/api/venues")).status, 200);
  t.setCookie(other);
  assert.equal((await t.req("GET", "/admin/session")).json.logged_in, false);
  // La contraseña anterior ya no sirve.
  t.setCookie("");
  assert.equal((await t.req("POST", "/admin/login", { username: "admin", password: "admin" })).status, 401);
  assert.equal((await t.req("POST", "/admin/login", { username: "admin", password: NEW_PASSWORD })).status, 200);
});

// ---------------------------------------------------------------
// Segundo factor (preparado, sin activar)
// ---------------------------------------------------------------

test("2FA: mientras totp_enabled sea falso, el segundo paso se omite", async () => {
  const t = await ready();
  const s = await t.req("GET", "/admin/session");
  assert.equal(s.json.needs_second_factor, false);
  assert.equal((await t.req("POST", "/admin/login/2fa", {})).status, 200);
});

test("2FA: con totp_enabled, la sesión no da acceso hasta pasar el segundo paso", async () => {
  const t = setup();
  t.db.exec("UPDATE admins SET totp_enabled = 1, must_change_password = 0");
  const r = await t.req("POST", "/admin/login", { username: "admin", password: "admin" });
  assert.equal(r.json.needs_second_factor, true);
  const api = await t.req("GET", "/admin/api/venues");
  assert.equal(api.status, 401);
  assert.equal(api.json.code, "segundo_factor");
  assert.equal((await t.req("POST", "/admin/password", { current_password: "admin", new_password: NEW_PASSWORD })).status, 401);
  assert.equal((await t.req("POST", "/admin/login/2fa", { code: "123456" })).status, 501);
});

// ---------------------------------------------------------------
// CSRF
// ---------------------------------------------------------------

test("CSRF: las escrituras exigen JSON y mismo origen", async () => {
  const t = await ready();
  const form = await t.req("POST", "/admin/api/venues", undefined, { "Content-Type": "application/x-www-form-urlencoded" });
  assert.equal(form.status, 415);
  const foreign = await t.req("POST", "/admin/api/venues", { name: "X" }, { Origin: "https://evil.example" });
  assert.equal(foreign.status, 403);
  const same = await t.req("POST", "/admin/api/venues", { name: "X" }, { Origin: "http://localhost" });
  assert.equal(same.status, 201);
});

// ---------------------------------------------------------------
// Lugares, deportes y canchas
// ---------------------------------------------------------------

const COURT = {
  name: "Cancha 9",
  surface: "Arcilla",
  status: "operativa",
  notes: "Con iluminación",
  maps_url: "",
  open_time: "08:00",
  close_time: "12:00",
  slot_minutes: 60,
  days: [1, 2, 3, 4, 5],
};

test("configuración: crear lugar, deporte con categorías y cancha", async () => {
  const t = await ready();
  const v = await t.req("POST", "/admin/api/venues", { name: "  Club  Nuevo ", address: "Ñuñoa", maps_url: "https://maps.app.goo.gl/abc" });
  assert.equal(v.status, 201);
  assert.match(v.json.id, /^L-[A-Z2-9]{5}$/);
  assert.equal(v.json.name, "Club Nuevo");

  const s = await t.req("POST", "/admin/api/sports", {
    venue_id: v.json.id,
    name: "Pádel",
    match_sizes: [4, 2],
    categories: ["Pro", "", "Intermedio", "", "Recién empiezo"],
  });
  assert.equal(s.status, 201, JSON.stringify(s.json));
  assert.deepEqual(s.json.match_sizes, [2, 4]);
  assert.deepEqual(s.json.categories, ["Pro", "", "Intermedio", "", "Recién empiezo"]);

  const c = await t.req("POST", "/admin/api/courts", { ...COURT, sport_id: s.json.id });
  assert.equal(c.status, 201, JSON.stringify(c.json));
  assert.equal(c.json.days, "1,2,3,4,5");
  assert.equal(c.json.venue_id, v.json.id);

  const venues = (await t.req("GET", "/admin/api/venues")).json;
  assert.equal(venues.find((x: any) => x.id === v.json.id).courts, 1);

  // La cancha nueva genera turnos para el público (martes 17).
  const slots = await getDayAvailability(t.db, s.json.id, "2026-11-17", t.now);
  assert.deepEqual(slots.map((x) => x.time), ["08:00", "09:00", "10:00", "11:00"]);
});

test("configuración: valida los datos con mensajes claros", async () => {
  const t = await ready();
  const bad = async (path: string, body: unknown, field: string) => {
    const r = await t.req("POST", path, body);
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.equal(r.json.field, field);
  };
  await bad("/admin/api/venues", { name: " " }, "name");
  await bad("/admin/api/venues", { name: "X", maps_url: "javascript:alert(1)" }, "maps_url");
  await bad("/admin/api/sports", { venue_id: "L-SM001", name: "Tenis", match_sizes: [3], categories: ["a"] }, "match_sizes");
  await bad("/admin/api/sports", { venue_id: "L-SM001", name: "Tenis", match_sizes: [2], categories: ["", ""] }, "categories");
  await bad("/admin/api/courts", { ...COURT, sport_id: "D-TEN01", close_time: "08:00" }, "close_time");
  await bad("/admin/api/courts", { ...COURT, sport_id: "D-TEN01", days: [] }, "days");
  await bad("/admin/api/courts", { ...COURT, sport_id: "D-TEN01", slot_minutes: 45 }, "slot_minutes");
  await bad("/admin/api/courts", { ...COURT, sport_id: "D-TEN01", close_time: "08:30", slot_minutes: 60 }, "slot_minutes");
  await bad("/admin/api/courts", { ...COURT, sport_id: "D-TEN01", available_from: "2026-12-10", available_to: "2026-12-01" }, "available_to");
  assert.equal((await t.req("POST", "/admin/api/sports", { venue_id: "L-NOPE", name: "X", match_sizes: [2], categories: ["a"] })).status, 404);
});

test("configuración: editar deporte reemplaza sus categorías", async () => {
  const t = await ready();
  const r = await t.req("PUT", "/admin/api/sports/D-TEN01", { name: "Tenis", match_sizes: [2], categories: ["Uno", "Dos"] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.categories, ["Uno", "Dos", "", "", ""]);
  assert.equal(t.db.count("SELECT count(*) AS n FROM categories WHERE sport_id = 'D-TEN01'"), 2);
});

// ---------------------------------------------------------------
// No sobrescribir lo agendado
// ---------------------------------------------------------------

async function confirmedAt(t: ReturnType<typeof setup>, time = "18:00") {
  const player = { initials: "MT", level: 3, email: "mt@example.com" };
  const a = await createGame(t.db, { sport_id: "D-TEN01", date: "2026-11-17", time, accepted_levels: [3], player }, "V-1", t.now);
  return joinGame(t.db, a.game.id, player, "V-2", t.now);
}

const T1 = {
  name: "Cancha 1", surface: "Arcilla", status: "operativa", notes: "Con iluminación", maps_url: "",
  open_time: "08:00", close_time: "21:00", slot_minutes: 60, days: [0, 1, 2, 3, 4, 5, 6],
};

test("canchas: se bloquea un cambio que deja fuera un encuentro confirmado", async () => {
  const t = await ready();
  const g = await confirmedAt(t);
  assert.equal(g.game.court_id, "C-T1SM1");

  for (const change of [
    { close_time: "18:00" }, // el turno de las 18 ya no cabe
    { slot_minutes: 90 }, // 18:00 deja de ser un turno
    { days: [1, 3, 5] }, // el martes deja de operar
    { status: "mantencion" },
    { available_to: "2026-11-16" },
  ]) {
    const r = await t.req("PUT", "/admin/api/courts/C-T1SM1", { ...T1, ...change });
    assert.equal(r.status, 409, JSON.stringify(change));
    assert.equal(r.json.code, "afecta_encuentros");
    assert.deepEqual(r.json.games.map((x: any) => x.id), [g.game.id]);
  }
  // Cambios que no afectan el encuentro sí se permiten.
  const ok = await t.req("PUT", "/admin/api/courts/C-T1SM1", { ...T1, notes: "Techada", close_time: "22:00" });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  // Tras cancelar el encuentro, el cambio se permite.
  assert.equal((await t.req("POST", `/admin/api/games/${g.game.id}/cancel`, {})).status, 200);
  assert.equal((await t.req("PUT", "/admin/api/courts/C-T1SM1", { ...T1, status: "mantencion" })).status, 200);
});

test("canchas: los encuentros abiertos (sin cancha) no bloquean cambios", async () => {
  const t = await ready();
  const player = { initials: "MT", level: 3, email: "mt@example.com" };
  await createGame(t.db, { sport_id: "D-TEN01", date: "2026-11-17", time: "18:00", accepted_levels: [3], player }, "V-1", t.now);
  assert.equal((await t.req("PUT", "/admin/api/courts/C-T1SM1", { ...T1, status: "cerrada" })).status, 200);
});

// ---------------------------------------------------------------
// Eliminar con confirmación
// ---------------------------------------------------------------

test("eliminar: con encuentros futuros pide confirmación; al confirmar los cancela y avisa", async () => {
  const t = await ready();
  const g = await confirmedAt(t);
  const first = await t.req("DELETE", "/admin/api/courts/C-T1SM1");
  assert.equal(first.status, 409);
  assert.equal(first.json.code, "requiere_confirmacion");
  assert.equal(first.json.games[0].players, 2);
  assert.equal(t.db.get<{ status: string }>("SELECT status FROM games WHERE id = ?", g.game.id)!.status, "confirmado");

  const logs: string[] = [];
  const orig = console.log;
  console.log = (m: string) => logs.push(m);
  let done;
  try {
    done = await t.req("DELETE", "/admin/api/courts/C-T1SM1?confirm=1");
  } finally {
    console.log = orig;
  }
  assert.equal(done.status, 200);
  assert.deepEqual(done.json, { deleted: true, cancelled_games: 1 });
  // El encuentro se conserva como cancelado y la cancha queda eliminada lógicamente.
  assert.deepEqual(
    { ...t.db.get("SELECT status, court_id FROM games WHERE id = ?", g.game.id) },
    { status: "cancelado", court_id: "C-T1SM1" },
  );
  assert.ok(t.db.get<{ deleted_at: string }>("SELECT deleted_at FROM courts WHERE id = 'C-T1SM1'")!.deleted_at);
  assert.equal((await t.req("GET", "/admin/api/courts/C-T1SM1")).status, 404);
  // Se avisó a los dos jugadores, sin datos de contacto en el log.
  const notices = logs.map((l) => JSON.parse(l));
  assert.equal(notices.length, 2);
  assert.ok(notices.every((n) => n.aviso === "encuentro_cancelado" && n.encuentro === g.game.id));
  assert.ok(!logs.join("").includes("example.com"));
});

test("eliminar: sin encuentros futuros se elimina sin confirmación", async () => {
  const t = await ready();
  assert.equal((await t.req("DELETE", "/admin/api/courts/C-T2SM2")).status, 200);
});

test("eliminar un lugar oculta sus deportes y canchas del público", async () => {
  const t = await ready();
  const player = { initials: "MT", level: 3, email: "mt@example.com" };
  const open = await createGame(t.db, { sport_id: "D-TEN01", date: "2026-11-17", time: "18:00", accepted_levels: [3], player }, "V-1", t.now);
  const first = await t.req("DELETE", "/admin/api/venues/L-SM001");
  assert.equal(first.status, 409);
  assert.equal((await t.req("DELETE", "/admin/api/venues/L-SM001?confirm=1")).status, 200);

  assert.equal(t.db.get<{ status: string }>("SELECT status FROM games WHERE id = ?", open.game.id)!.status, "cancelado");
  assert.equal(t.db.count("SELECT count(*) AS n FROM sports WHERE venue_id = 'L-SM001' AND deleted_at IS NULL"), 0);
  assert.equal(t.db.count("SELECT count(*) AS n FROM courts WHERE venue_id = 'L-SM001' AND deleted_at IS NULL"), 0);
  assert.ok(!(await t.req("GET", "/admin/api/venues")).json.some((v: any) => v.id === "L-SM001"));
  assert.deepEqual(await getDayAvailability(t.db, "D-TEN01", "2026-11-17", t.now), []);
  await assert.rejects(
    createGame(t.db, { sport_id: "D-TEN01", date: "2026-11-17", time: "18:00", accepted_levels: [3], player }, "V-3", t.now),
    (e: unknown) => e instanceof MatchError && e.code === "deporte_no_existe",
  );
});

// ---------------------------------------------------------------
// Encuentros
// ---------------------------------------------------------------

test("encuentros: la lista del administrador incluye contactos y permite cancelar", async () => {
  const t = await ready();
  const g = await confirmedAt(t);
  const list = (await t.req("GET", "/admin/api/games")).json;
  const item = list.find((x: any) => x.id === g.game.id);
  assert.equal(item.status, "confirmado");
  assert.equal(item.court_name, "Cancha 1");
  assert.equal(item.players[0].email, "mt@example.com");

  const orig = console.log;
  console.log = () => {};
  try {
    assert.equal((await t.req("POST", `/admin/api/games/${g.game.id}/cancel`, {})).status, 200);
  } finally {
    console.log = orig;
  }
  const after = (await t.req("GET", "/admin/api/games")).json.find((x: any) => x.id === g.game.id);
  assert.equal(after.status, "cancelado");
  // La cancha quedó libre para el público.
  const slot = (await getDayAvailability(t.db, "D-TEN01", "2026-11-17", t.now)).find((s) => s.time === "18:00")!;
  assert.equal(slot.free_courts, 2);
  assert.equal((await t.req("POST", "/admin/api/games/E-NOPE1/cancel", {})).status, 404);
});
