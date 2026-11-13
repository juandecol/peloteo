import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import {
  base32Decode,
  base32Encode,
  hotp,
  matchTotp,
  newRecoveryCodes,
  normalizeRecoveryCode,
  otpauthUri,
  totpStep,
} from "../src/lib/totp.ts";
import { emptyGamesDb, TestDb } from "./helpers/db.ts";

const START = new Date("2026-11-16T13:00:00Z");
const NEW_PASSWORD = "cancha-de-arcilla-2026";
const enc = new TextEncoder();

// ---------------------------------------------------------------
// TOTP: vectores de los RFC
// ---------------------------------------------------------------

test("HOTP: vectores del RFC 4226", async () => {
  const secret = enc.encode("12345678901234567890");
  const expected = ["755224", "287082", "359152", "969429", "338314", "254676", "287922", "162583", "399871", "520489"];
  for (let i = 0; i < expected.length; i++) assert.equal(await hotp(secret, i), expected[i]);
});

test("TOTP: vectores SHA-1 del RFC 6238 (8 dígitos)", async () => {
  const secret = enc.encode("12345678901234567890");
  const cases: [number, string][] = [
    [59, "94287082"],
    [1111111109, "07081804"],
    [1111111111, "14050471"],
    [1234567890, "89005924"],
    [2000000000, "69279037"],
    [20000000000, "65353130"],
  ];
  for (const [t, code] of cases) assert.equal(await hotp(secret, totpStep(new Date(t * 1000)), 8), code);
});

test("base32: codifica y decodifica (RFC 4648)", () => {
  assert.equal(base32Encode(enc.encode("foobar")), "MZXW6YTBOI");
  assert.equal(base32Encode(enc.encode("f")), "MY");
  assert.deepEqual(base32Decode("mzxw 6ytb-oi"), enc.encode("foobar"));
  assert.equal(base32Decode("M1"), null);
});

test("TOTP: tolera un paso de desfase y rechaza los ya usados", async () => {
  const secret = base32Encode(enc.encode("12345678901234567890"));
  const now = new Date(1234567890 * 1000);
  const step = totpStep(now);
  const raw = enc.encode("12345678901234567890");
  assert.equal(await matchTotp(secret, await hotp(raw, step), now), step);
  assert.equal(await matchTotp(secret, await hotp(raw, step - 1), now), step - 1);
  assert.equal(await matchTotp(secret, await hotp(raw, step + 1), now), step + 1);
  assert.equal(await matchTotp(secret, await hotp(raw, step - 2), now), null);
  // Ya se usó ese paso (o uno posterior): no se acepta.
  assert.equal(await matchTotp(secret, await hotp(raw, step), now, step), null);
  assert.equal(await matchTotp(secret, "12345", now), null);
  assert.match(otpauthUri("ABC", "admin"), /^otpauth:\/\/totp\/Peloteo:admin\?secret=ABC&issuer=Peloteo&algorithm=SHA1&digits=6&period=30$/);
});

test("códigos de respaldo: 10, formato xxxx-xxxx-xxxx, sin caracteres confusos", () => {
  const codes = newRecoveryCodes();
  assert.equal(codes.length, 10);
  assert.equal(new Set(codes).size, 10);
  for (const c of codes) {
    assert.match(c, /^[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}-[a-hjkmnp-z2-9]{4}$/);
    assert.equal(normalizeRecoveryCode(" " + c.toUpperCase().replace(/-/g, " ") + " "), c.replace(/-/g, ""));
  }
  assert.equal(normalizeRecoveryCode("123456"), null);
  assert.equal(normalizeRecoveryCode("abcd-efgh-ijkl"), null); // la i y la l no se usan
});

// ---------------------------------------------------------------
// Flujo completo por las rutas
// ---------------------------------------------------------------

function setup(db: TestDb = emptyGamesDb()) {
  let now = START;
  const app = createApp({ now: () => now });
  function client() {
    let cookie = "";
    return async (method: string, path: string, body?: unknown) => {
      const res = await app.request(
        path,
        {
          method,
          headers: { ...(body !== undefined ? { "Content-Type": "application/json" } : {}), ...(cookie ? { Cookie: cookie } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        },
        { DB: db },
      );
      const set = res.headers.get("Set-Cookie");
      if (set) cookie = set.split(";")[0]!.endsWith("=") ? "" : set.split(";")[0]!;
      return { status: res.status, json: (await res.json()) as any, setCookie: set };
    };
  }
  return {
    db,
    client,
    advance(seconds: number) {
      now = new Date(now.getTime() + seconds * 1000);
    },
    get date() {
      return now;
    },
  };
}

async function loggedIn(t: ReturnType<typeof setup>, password = NEW_PASSWORD) {
  const c = t.client();
  const r = await c("POST", "/admin/login", { username: "admin", password });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  return { c, login: r.json };
}

/** Admin con la contraseña ya cambiada. */
async function ready() {
  const t = setup();
  const c = t.client();
  await c("POST", "/admin/login", { username: "admin", password: "admin" });
  assert.equal((await c("POST", "/admin/password", { current_password: "admin", new_password: NEW_PASSWORD })).status, 200);
  return { t, c };
}

const codeFor = async (secret: string, date: Date, offset = 0) => hotp(base32Decode(secret)!, totpStep(date) + offset);

async function enabled() {
  const { t, c } = await ready();
  const setupR = await c("POST", "/admin/2fa/setup", {});
  const secret: string = setupR.json.secret;
  const r = await c("POST", "/admin/2fa/enable", { code: await codeFor(secret, t.date) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  t.advance(30); // el código usado al activar ya no sirve
  return { t, c, secret, recovery: r.json.recovery_codes as string[] };
}

test("2FA: activar muestra QR/clave, pide un código válido y entrega 10 códigos de respaldo", async () => {
  const { t, c } = await ready();
  const other = (await loggedIn(t)).c; // otra sesión abierta
  assert.deepEqual((await c("GET", "/admin/2fa")).json, { enabled: false, recovery_left: 0 });

  const s = await c("POST", "/admin/2fa/setup", {});
  assert.equal(s.status, 200);
  assert.match(s.json.secret, /^[A-Z2-7]{32}$/);
  assert.equal(s.json.uri, otpauthUri(s.json.secret, "admin"));
  // Mientras no se active, el login sigue en un paso.
  assert.equal((await loggedIn(t)).login.needs_second_factor, false);

  const bad = await c("POST", "/admin/2fa/enable", { code: "000000" });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "codigo_incorrecto");

  const ok = await c("POST", "/admin/2fa/enable", { code: await codeFor(s.json.secret, t.date) });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.recovery_codes.length, 10);
  // En la base solo hay hashes de los códigos.
  const stored = t.db.raw.prepare("SELECT code_hash FROM admin_recovery_codes").all() as { code_hash: string }[];
  assert.equal(stored.length, 10);
  assert.ok(stored.every((r) => /^[0-9a-f]{64}$/.test(r.code_hash)));
  assert.ok(!stored.some((r) => ok.json.recovery_codes.some((code: string) => r.code_hash.includes(code))));

  assert.deepEqual((await c("GET", "/admin/2fa")).json, { enabled: true, recovery_left: 10 });
  // Las demás sesiones se cerraron; esta sigue.
  assert.equal((await other("GET", "/admin/api/venues")).status, 401);
  assert.equal((await c("GET", "/admin/api/venues")).status, 200);
  // No se puede volver a configurar mientras esté activo.
  assert.equal((await c("POST", "/admin/2fa/setup", {})).status, 409);
});

test("2FA: no se activa antes de cambiar la contraseña inicial", async () => {
  const t = setup();
  const { c } = await loggedIn(t, "admin");
  assert.equal((await c("POST", "/admin/2fa/setup", {})).status, 403);
});

test("2FA: el login pide el código; la sesión a medias dura 10 minutos y no da acceso", async () => {
  const { t, secret } = await enabled();
  const { c, login } = await loggedIn(t);
  assert.equal(login.needs_second_factor, true);
  assert.equal((await c("GET", "/admin/api/venues")).json.code, "segundo_factor");
  assert.equal((await c("POST", "/admin/2fa/setup", {})).status, 401);
  const exp = new Date(t.db.get<{ expires_at: string }>("SELECT expires_at FROM sessions ORDER BY rowid DESC LIMIT 1")!.expires_at);
  assert.equal((exp.getTime() - t.date.getTime()) / 60_000, 10);

  const r = await c("POST", "/admin/login/2fa", { code: await codeFor(secret, t.date) });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.needs_second_factor, false);
  assert.equal(r.json.method, "totp");
  assert.match(r.setCookie!, /Max-Age=43200/);
  assert.equal((await c("GET", "/admin/api/venues")).status, 200);
  // Ahora la sesión dura 12 horas.
  const exp2 = new Date(t.db.get<{ expires_at: string }>("SELECT expires_at FROM sessions ORDER BY rowid DESC LIMIT 1")!.expires_at);
  assert.equal((exp2.getTime() - t.date.getTime()) / 3_600_000, 12);

  // Una sesión a medias vence a los 10 minutos.
  const late = await loggedIn(t);
  t.advance(11 * 60);
  assert.equal((await late.c("POST", "/admin/login/2fa", { code: await codeFor(secret, t.date) })).status, 401);
});

test("2FA: un mismo código no sirve dos veces", async () => {
  const { t, secret } = await enabled();
  const code = await codeFor(secret, t.date);
  const a = await loggedIn(t);
  assert.equal((await a.c("POST", "/admin/login/2fa", { code })).status, 200);
  const b = await loggedIn(t);
  const again = await b.c("POST", "/admin/login/2fa", { code });
  assert.equal(again.status, 400);
  assert.equal(again.json.code, "codigo_incorrecto");
});

test("2FA: código de respaldo sirve una vez y descuenta", async () => {
  const { t, recovery } = await enabled();
  const a = await loggedIn(t);
  const r = await a.c("POST", "/admin/login/2fa", { code: recovery[0]!.toUpperCase() });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.method, "respaldo");
  assert.equal(r.json.recovery_left, 9);
  const b = await loggedIn(t);
  assert.equal((await b.c("POST", "/admin/login/2fa", { code: recovery[0] })).status, 400);
});

test("2FA: 5 códigos incorrectos bloquean 15 minutos", async () => {
  const { t, secret } = await enabled();
  const { c } = await loggedIn(t);
  for (let i = 0; i < 5; i++) assert.equal((await c("POST", "/admin/login/2fa", { code: "000000" })).status, 400);
  const locked = await c("POST", "/admin/login/2fa", { code: await codeFor(secret, t.date) });
  assert.equal(locked.status, 429);
  // También bloquea un nuevo login de ese usuario e IP.
  assert.equal(
    (await t.client()("POST", "/admin/login", { username: "admin", password: NEW_PASSWORD })).status,
    429,
  );
});

test("2FA: renovar códigos de respaldo pide un código de la app", async () => {
  const { t, c, secret, recovery } = await enabled();
  assert.equal((await c("POST", "/admin/2fa/recovery-codes", { code: recovery[1] })).status, 400);
  const r = await c("POST", "/admin/2fa/recovery-codes", { code: await codeFor(secret, t.date) });
  assert.equal(r.status, 200);
  assert.equal(r.json.recovery_codes.length, 10);
  assert.ok(!r.json.recovery_codes.includes(recovery[2]));
  // Los anteriores dejan de servir.
  const { c: other } = await loggedIn(t);
  assert.equal((await other("POST", "/admin/login/2fa", { code: recovery[2] })).status, 400);
  assert.equal((await other("POST", "/admin/login/2fa", { code: r.json.recovery_codes[0] })).status, 200);
});

test("2FA: desactivar pide contraseña y código, borra la clave y vuelve el login de un paso", async () => {
  const { t, c, secret } = await enabled();
  const wrong = await c("POST", "/admin/2fa/disable", { password: "otra-cosa-larga", code: await codeFor(secret, t.date) });
  assert.equal(wrong.status, 400);
  assert.equal(wrong.json.field, "password");
  const ok = await c("POST", "/admin/2fa/disable", { password: NEW_PASSWORD, code: await codeFor(secret, t.date) });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(
    { ...t.db.get("SELECT totp_enabled, totp_secret, totp_last_step FROM admins") },
    { totp_enabled: 0, totp_secret: null, totp_last_step: null },
  );
  assert.equal(t.db.get<{ n: number }>("SELECT count(*) AS n FROM admin_recovery_codes")!.n, 0);
  assert.equal((await loggedIn(t)).login.needs_second_factor, false);
});
