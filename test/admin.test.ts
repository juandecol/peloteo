import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { getDayAvailability } from "../src/lib/availability.ts";
import { createGame, joinGame, MatchError } from "../src/lib/matching.ts";
import { hashPassword, verifyPassword } from "../src/lib/auth.ts";
import { localNow } from "../src/lib/time.ts";
import { listSportGroups } from "../src/lib/public.ts";
import { emptyGamesDb, TestDb } from "./helpers/db.ts";
import type { Channel, NoticeEvent } from "../src/lib/notify.ts";

// Lunes 16 de noviembre de 2026, 10:00 en Santiago (UTC-3).
const START = new Date("2026-11-16T13:00:00Z");
const NEW_PASSWORD = "cancha-de-arcilla-2026";

function setup(db: TestDb = emptyGamesDb(), channels?: Channel[]) {
  let now = START;
  const app = createApp({ now: () => now, ...(channels ? { channels } : {}) });
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

test("login: con 4 intentos fallidos todavía se puede entrar", async () => {
  const t = setup();
  for (let i = 1; i <= 4; i++) {
    assert.equal((await t.req("POST", "/admin/login", { username: "admin", password: "x" + i })).status, 401);
  }
  assert.equal((await t.req("POST", "/admin/login", { username: "admin", password: "admin" })).status, 200);
});

test("login: tras 5 intentos fallidos se bloquea 15 minutos, aun con la contraseña correcta", async () => {
  const t = setup();
  for (let i = 1; i <= 5; i++) {
    assert.equal((await t.req("POST", "/admin/login", { username: "admin", password: "x" + i })).status, 401);
  }
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

test("lugares: enlace de reservas en línea opcional, editable y validado (2026-11-16)", async () => {
  const t = await ready();
  const a = await t.req("POST", "/admin/api/venues", { name: "Club Test" });
  assert.equal(a.status, 201, JSON.stringify(a.json));
  assert.equal(a.json.venue?.booking_url ?? a.json.booking_url, "");
  const id = a.json.venue?.id ?? a.json.id;
  const bad = await t.req("PUT", `/admin/api/venues/${id}`, { name: "Club Test", booking_url: "javascript:alert(1)" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.field, "booking_url");
  const ok = await t.req("PUT", `/admin/api/venues/${id}`, { name: "Club Test", booking_url: "https://reservas.example.cl/club" });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  const list = (await t.req("GET", "/admin/api/venues")).json;
  const venues = list.venues ?? list;
  assert.equal(venues.find((v: { id: string }) => v.id === id).booking_url, "https://reservas.example.cl/club");
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
  // Sin clave configurada, ningún código sirve.
  assert.equal((await t.req("POST", "/admin/login/2fa", { code: "123456" })).status, 400);
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

test("configuración: el orden del deporte define el selector; con el mismo número, alfabético", async () => {
  const t = await ready();
  const names = async () => (await listSportGroups(t.db)).map((g) => g.name);
  // Sin orden (todos en 0): alfabético, como antes.
  assert.deepEqual(await names(), ["Pádel", "Tenis"]);
  const add = async (name: string, sort_order?: unknown) => {
    const s = await t.req("POST", "/admin/api/sports", { venue_id: "L-SM001", name, match_sizes: [2], categories: ["Pro"], ...(sort_order !== undefined ? { sort_order } : {}) });
    assert.equal(s.status, 201, JSON.stringify(s.json));
    await t.req("POST", "/admin/api/courts", { ...COURT, sport_id: s.json.id });
    return s.json;
  };
  const squash = await add("Squash", 2);
  assert.equal(squash.sort_order, 2);
  const basquet = await add("Básquetbol"); // sin el campo: 0
  assert.equal(basquet.sort_order, 0);
  // Tenis primero; luego los de 0 en orden alfabético; Squash al final.
  const ten = await t.req("PUT", "/admin/api/sports/D-TEN01", { name: "Tenis", match_sizes: [2, 4], categories: ["Pro"], sort_order: "0" });
  assert.equal(ten.json.sort_order, 0);
  assert.deepEqual(await names(), ["Básquetbol", "Pádel", "Tenis", "Squash"]);
  await t.req("PUT", "/admin/api/sports/D-TEN01", { name: "Tenis", match_sizes: [2, 4], categories: ["Pro"], sort_order: -0 });
  await t.req("PUT", "/admin/api/sports/D-PAD01", { name: "Pádel", match_sizes: [2, 4], categories: ["Pro"], sort_order: 1 });
  await t.req("PUT", "/admin/api/sports/" + basquet.id, { name: "Básquetbol", match_sizes: [2], categories: ["Pro"], sort_order: 1 });
  assert.deepEqual(await names(), ["Tenis", "Básquetbol", "Pádel", "Squash"]);
  // Editar sin el campo no cambia el orden.
  const same = await t.req("PUT", "/admin/api/sports/" + squash.id, { name: "Squash", match_sizes: [2], categories: ["Pro"] });
  assert.equal(same.json.sort_order, 2);
  // Solo enteros de 0 a 999.
  for (const bad of [-1, 1000, 1.5, "abc"]) {
    const r = await t.req("PUT", "/admin/api/sports/" + squash.id, { name: "Squash", match_sizes: [2], categories: ["Pro"], sort_order: bad });
    assert.equal(r.status, 400, String(bad));
    assert.equal(r.json.field, "sort_order");
  }
  assert.equal((await t.req("GET", "/admin/api/sports/" + squash.id)).json.sort_order, 2);
});

test("configuración: un deporte se muestra a los jugadores solo si está visible y tiene canchas operativas", async () => {
  const t = await ready();
  const names = async () => (await listSportGroups(t.db)).map((g) => g.name);
  const s = await t.req("POST", "/admin/api/sports", { venue_id: "L-SM001", name: "Squash", match_sizes: [2], categories: ["Pro"] });
  assert.equal(s.status, 201);
  assert.equal(s.json.visible, true);
  assert.equal(s.json.active_courts, 0);
  // Visible pero sin canchas: no aparece, porque no hay horario del que salgan las horas.
  assert.ok(!(await names()).includes("Squash"));

  const c = await t.req("POST", "/admin/api/courts", { ...COURT, sport_id: s.json.id });
  assert.equal(c.status, 201);
  assert.equal((await t.req("GET", "/admin/api/sports/" + s.json.id)).json.active_courts, 1);
  assert.ok((await names()).includes("Squash"));

  // Editar sin el campo no cambia la visibilidad; ocultarlo lo saca del sitio.
  const same = await t.req("PUT", "/admin/api/sports/" + s.json.id, { name: "Squash", match_sizes: [2], categories: ["Pro"] });
  assert.equal(same.json.visible, true);
  const hidden = await t.req("PUT", "/admin/api/sports/" + s.json.id, { name: "Squash", match_sizes: [2], categories: ["Pro"], visible: false });
  assert.equal(hidden.json.visible, false);
  assert.ok(!(await names()).includes("Squash"));

  // Oculto no admite partidos nuevos.
  const player = { initials: "AB", level: 1, email: "ab@example.com", rama: "femenina", intent: "salud" };
  await assert.rejects(
    createGame(t.db, { sport_id: s.json.id, capacity: 2, date: "2026-11-17", time: "08:00", accepted_levels: [1], player }, "V-1", t.now),
    (e: unknown) => e instanceof MatchError && e.code === "deporte_no_existe",
  );

  // Creado oculto desde el principio.
  const pre = await t.req("POST", "/admin/api/sports", { venue_id: "L-SM001", name: "Básquetbol", match_sizes: [4], categories: ["Pro"], visible: false });
  assert.equal(pre.json.visible, false);
});

// ---------------------------------------------------------------
// No sobrescribir lo agendado
// ---------------------------------------------------------------

async function confirmedAt(t: ReturnType<typeof setup>, time = "18:00") {
  const player = { initials: "MT", level: 3, email: "mt@example.com", rama: "masculina", intent: "competitivo" };
  const a = await createGame(t.db, { sport_id: "D-TEN01", capacity: 2, date: "2026-11-17", time, accepted_levels: [3], player }, "V-1", t.now);
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
  const player = { initials: "MT", level: 3, email: "mt@example.com", rama: "masculina", intent: "competitivo" };
  await createGame(t.db, { sport_id: "D-TEN01", capacity: 2, date: "2026-11-17", time: "18:00", accepted_levels: [3], player }, "V-1", t.now);
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
  const player = { initials: "MT", level: 3, email: "mt@example.com", rama: "masculina", intent: "competitivo" };
  const open = await createGame(t.db, { sport_id: "D-TEN01", capacity: 2, date: "2026-11-17", time: "18:00", accepted_levels: [3], player }, "V-1", t.now);
  const first = await t.req("DELETE", "/admin/api/venues/L-SM001");
  assert.equal(first.status, 409);
  assert.equal((await t.req("DELETE", "/admin/api/venues/L-SM001?confirm=1")).status, 200);

  assert.equal(t.db.get<{ status: string }>("SELECT status FROM games WHERE id = ?", open.game.id)!.status, "cancelado");
  assert.equal(t.db.count("SELECT count(*) AS n FROM sports WHERE venue_id = 'L-SM001' AND deleted_at IS NULL"), 0);
  assert.equal(t.db.count("SELECT count(*) AS n FROM courts WHERE venue_id = 'L-SM001' AND deleted_at IS NULL"), 0);
  assert.ok(!(await t.req("GET", "/admin/api/venues")).json.some((v: any) => v.id === "L-SM001"));
  assert.deepEqual(await getDayAvailability(t.db, "D-TEN01", "2026-11-17", t.now), []);
  await assert.rejects(
    createGame(t.db, { sport_id: "D-TEN01", capacity: 2, date: "2026-11-17", time: "18:00", accepted_levels: [3], player }, "V-3", t.now),
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

test("encuentros: eliminar todos borra los partidos de todos los lugares y deportes, con doble confirmación", async () => {
  const sent: { event: NoticeEvent; email: string; game: string }[] = [];
  const capture: Channel = { name: "captura", async send(event, player, game) { sent.push({ event, email: player.email, game: game.id }); } };
  const t = await ready(setup(emptyGamesDb(), [capture]));
  const p = (initials: string) => ({ initials, level: 3, email: initials.toLowerCase() + "@example.com", rama: "masculina", intent: "diversion" });
  // Uno confirmado y uno abierto (tenis), uno de pádel, uno cancelado y uno pasado.
  const conf = await confirmedAt(t);
  const open = await createGame(t.db, { sport_id: "D-TEN01", capacity: 2, date: "2026-11-18", time: "18:00", accepted_levels: [3], player: p("AB") }, "V-3", t.now);
  await createGame(t.db, { sport_id: "D-PAD01", capacity: 4, date: "2026-11-18", time: "18:30", accepted_levels: [3], player: p("PD") }, "V-4", t.now);
  const gone = await createGame(t.db, { sport_id: "D-TEN01", capacity: 2, date: "2026-11-19", time: "18:00", accepted_levels: [3], player: p("CC") }, "V-5", t.now);
  t.db.exec(`UPDATE games SET status = 'cancelado' WHERE id = '${gone.game.id}'`);
  t.db.exec(`INSERT INTO games (id, venue_id, sport_id, court_id, date, time, capacity, accepted_levels, status, created_at)
             SELECT 'E-PAST1', venue_id, sport_id, NULL, '2026-11-10', time, capacity, accepted_levels, 'abierto', created_at FROM games WHERE id = '${open.game.id}'`);
  const before = t.db.count("SELECT count(*) AS n FROM games");
  assert.equal(before, 5);
  const venues = t.db.count("SELECT count(*) AS n FROM venues");
  const blocksAndCourts = t.db.count("SELECT (SELECT count(*) FROM courts) + (SELECT count(*) FROM sports) AS n");

  // Sin la palabra (o con otra), no borra nada.
  for (const body of [{}, { confirm: "" }, { confirm: "si" }]) {
    const r = await t.req("POST", "/admin/api/games/delete-all", body);
    assert.equal(r.status, 400);
    assert.equal(r.json.field, "confirm");
  }
  assert.equal(t.db.count("SELECT count(*) AS n FROM games"), 5);

  const r = await t.req("POST", "/admin/api/games/delete-all", { confirm: "eliminar" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.deepEqual(r.json, { deleted_games: 5, deleted_players: 5, notified_games: 3 });
  assert.equal(t.db.count("SELECT count(*) AS n FROM games"), 0);
  assert.equal(t.db.count("SELECT count(*) AS n FROM players"), 0);
  // Lugares, deportes y canchas no cambian.
  assert.equal(t.db.count("SELECT count(*) AS n FROM venues"), venues);
  assert.equal(t.db.count("SELECT (SELECT count(*) FROM courts) + (SELECT count(*) FROM sports) AS n"), blocksAndCourts);
  // Se avisó (antes de borrar) a los jugadores de los partidos próximos no cancelados; no al cancelado ni al pasado.
  assert.ok(sent.every((s) => s.event === "encuentro_cancelado"));
  assert.deepEqual(new Set(sent.map((s) => s.game)), new Set([conf.game.id, open.game.id, sent.find((s) => s.email === "pd@example.com")!.game]));
  assert.ok(!sent.some((s) => s.email === "cc@example.com"));
});

test("encuentros: eliminar todos exige sesión de administrador", async () => {
  const t = setup();
  assert.equal((await t.req("POST", "/admin/api/games/delete-all", { confirm: "ELIMINAR" })).status, 401);
});

// ---------------------------------------------------------------
// Bloqueos
// ---------------------------------------------------------------

test("bloqueos: crear, listar y quitar un bloqueo con motivo", async () => {
  const t = await ready();
  const r = await t.req("POST", "/admin/api/courts/C-T1SM1/blocks", {
    date: "2026-11-17", start_time: "18:00", end_time: "20:00", reason: "Reserva por teléfono",
  });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  assert.match(r.json.block.id, /^B-[A-Z2-9]{5}$/);
  assert.equal(r.json.cancelled_games, 0);
  const list = (await t.req("GET", "/admin/api/courts/C-T1SM1/blocks")).json;
  assert.deepEqual(list.map((b: any) => [b.date, b.start_time, b.end_time, b.reason]), [
    ["2026-11-17", "18:00", "20:00", "Reserva por teléfono"],
  ]);
  // El turno de las 18:00 y el de las 19:00 pierden la cancha 1.
  const slots = await getDayAvailability(t.db, "D-TEN01", "2026-11-17", t.now);
  assert.equal(slots.find((s) => s.time === "18:00")!.free_courts, 1);
  assert.equal(slots.find((s) => s.time === "20:00")!.free_courts, 2);

  assert.equal((await t.req("DELETE", `/admin/api/blocks/${r.json.block.id}`)).status, 200);
  assert.deepEqual((await t.req("GET", "/admin/api/courts/C-T1SM1/blocks")).json, []);
  assert.equal((await t.req("DELETE", `/admin/api/blocks/${r.json.block.id}`)).status, 404);
});

test("bloqueos: valida fecha, horas y motivo", async () => {
  const t = await ready();
  const bad = async (body: unknown, field: string) => {
    const r = await t.req("POST", "/admin/api/courts/C-T1SM1/blocks", body);
    assert.equal(r.status, 400, JSON.stringify(r.json));
    assert.equal(r.json.field, field);
  };
  await bad({ date: "2026-11-31", start_time: "18:00", end_time: "19:00" }, "date");
  await bad({ date: "2026-11-15", start_time: "18:00", end_time: "19:00" }, "date"); // ayer
  await bad({ date: "2026-11-17", start_time: "19:00", end_time: "18:00" }, "end_time");
  await bad({ date: "2026-11-17", start_time: "18:00", end_time: "18:00" }, "end_time");
  await bad({ date: "2026-11-17", start_time: "18:00", end_time: "19:00", reason: "x".repeat(201) }, "reason");
  assert.equal((await t.req("POST", "/admin/api/courts/C-NOPE1/blocks", { date: "2026-11-17", start_time: "18:00", end_time: "19:00" })).status, 404);
});

test("bloqueos: con un encuentro confirmado en ese horario, advierte y pide confirmación", async () => {
  const t = await ready();
  const g = await confirmedAt(t); // tenis, cancha 1, martes 17 a las 18:00
  const body = { date: "2026-11-17", start_time: "18:30", end_time: "19:30", reason: "Torneo" };

  const first = await t.req("POST", "/admin/api/courts/C-T1SM1/blocks", body);
  assert.equal(first.status, 409);
  assert.equal(first.json.code, "requiere_confirmacion");
  assert.deepEqual(first.json.games.map((x: any) => x.id), [g.game.id]);
  assert.equal(t.db.count("SELECT count(*) AS n FROM court_blocks"), 0);
  assert.equal(t.db.get<{ status: string }>("SELECT status FROM games WHERE id = ?", g.game.id)!.status, "confirmado");

  const logs: string[] = [];
  const orig = console.log;
  console.log = (m: string) => logs.push(m);
  let done;
  try {
    done = await t.req("POST", "/admin/api/courts/C-T1SM1/blocks?confirm=1", body);
  } finally {
    console.log = orig;
  }
  assert.equal(done.status, 201);
  assert.equal(done.json.cancelled_games, 1);
  assert.equal(t.db.get<{ status: string }>("SELECT status FROM games WHERE id = ?", g.game.id)!.status, "cancelado");
  assert.equal(t.db.count("SELECT count(*) AS n FROM court_blocks"), 1);
  assert.deepEqual(logs.map((l) => JSON.parse(l).aviso), ["encuentro_cancelado", "encuentro_cancelado"]);
});

test("bloqueos: no afectan encuentros de otras canchas, otros días ni otros horarios", async () => {
  const t = await ready();
  await confirmedAt(t, "18:00"); // cancha 1
  const other = await confirmedAt(t, "18:00"); // cancha 2
  assert.equal(other.game.court_id, "C-T2SM2");
  for (const body of [
    { date: "2026-11-17", start_time: "19:00", end_time: "21:00" }, // empieza cuando termina el turno
    { date: "2026-11-18", start_time: "18:00", end_time: "19:00" }, // otro día
  ]) {
    assert.equal((await t.req("POST", "/admin/api/courts/C-T1SM1/blocks", body)).status, 201, JSON.stringify(body));
  }
  // Bloquear la cancha 3 (en mantención, sin encuentros) tampoco pide confirmación.
  assert.equal((await t.req("POST", "/admin/api/courts/C-T3SM3/blocks", { date: "2026-11-17", start_time: "18:00", end_time: "19:00" })).status, 201);
});

// ---------------------------------------------------------------
// Opciones del sitio
// ---------------------------------------------------------------

test("opciones: pedir WhatsApp se activa y desactiva desde Configuración; requiere sesión", async () => {
  const anon = setup();
  assert.equal((await anon.req("GET", "/admin/api/settings")).status, 401);
  const t = await ready();
  assert.deepEqual((await t.req("GET", "/admin/api/settings")).json, { whatsapp_contact: false });
  assert.deepEqual((await t.req("PUT", "/admin/api/settings", { whatsapp_contact: true })).json, { whatsapp_contact: true });
  // Valores inválidos se ignoran.
  assert.deepEqual((await t.req("PUT", "/admin/api/settings", { whatsapp_contact: "si" })).json, { whatsapp_contact: true });
  assert.deepEqual((await t.req("PUT", "/admin/api/settings", { whatsapp_contact: false })).json, { whatsapp_contact: false });
});
