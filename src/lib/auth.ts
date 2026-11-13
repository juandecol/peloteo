// Autenticación del administrador.
//
// - Contraseñas con PBKDF2-SHA256 (Web Crypto) y sal por usuario. Formato del hash:
//   "pbkdf2-sha256$<iteraciones>$<hash hex>"; la sal va en hex en otra columna.
// - Sesiones: el navegador guarda un token aleatorio; la base guarda solo su
//   SHA-256, así una copia de la base no permite suplantar sesiones.
// - Límite de intentos: con 5 fallos del mismo usuario e IP en los últimos 15
//   minutos, el login queda bloqueado hasta que se cumplan esos 15 minutos.
// - Flujo en dos pasos: si el administrador tiene totp_enabled, la sesión nace con
//   second_factor_passed = 0, dura solo 10 minutos y debe pasar por
//   /admin/login/2fa (ver twofa.ts).

import type { Db } from "./db.ts";

export const PBKDF2_ITERATIONS = 100_000; // máximo que admite Web Crypto en Workers
export const SESSION_HOURS = 12;
export const MAX_FAILED_ATTEMPTS = 5;
export const LOCK_MINUTES = 15;
export const MIN_PASSWORD_LENGTH = 10;
/** Duración de una sesión que todavía espera el segundo factor. */
export const PENDING_2FA_MINUTES = 10;

const enc = new TextEncoder();

function toHex(buf: ArrayBuffer | Uint8Array): string {
  return Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** Comparación en tiempo constante de dos textos de igual largo. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<string> {
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt, iterations },
    key,
    256,
  );
  return toHex(bits);
}

export interface PasswordHash {
  hash: string;
  salt: string;
}

export async function hashPassword(password: string, iterations = PBKDF2_ITERATIONS): Promise<PasswordHash> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { hash: `pbkdf2-sha256$${iterations}$${await pbkdf2(password, salt, iterations)}`, salt: toHex(salt) };
}

export async function verifyPassword(password: string, stored: PasswordHash): Promise<boolean> {
  const m = /^pbkdf2-sha256\$(\d+)\$([0-9a-f]{64})$/.exec(stored.hash);
  if (!m || !/^[0-9a-f]+$/.test(stored.salt)) return false;
  const derived = await pbkdf2(password, fromHex(stored.salt), Number(m[1]));
  return safeEqual(derived, m[2]!);
}

export async function sha256Hex(text: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", enc.encode(text)));
}

/** Fecha ISO en UTC con precisión de segundos, igual al formato de created_at. */
export function isoSeconds(d: Date): string {
  return d.toISOString().slice(0, 19) + "Z";
}

// ---------------------------------------------------------------
// Login
// ---------------------------------------------------------------

interface AdminRow {
  id: string;
  username: string;
  password_hash: string;
  password_salt: string;
  totp_enabled: number;
  must_change_password: number;
}

export type LoginResult =
  | {
      ok: true;
      token: string;
      expires_at: string;
      must_change_password: boolean;
      needs_second_factor: boolean;
    }
  | { ok: false; reason: "bloqueado" | "credenciales" };

// Hash de relleno para que un usuario inexistente tarde lo mismo que uno real.
const DUMMY: PasswordHash = {
  hash: "pbkdf2-sha256$100000$" + "0".repeat(64),
  salt: "00000000000000000000000000000000",
};

/** Intentos fallidos recientes de ese usuario e IP. */
export async function recentFailures(db: Db, username: string, ip: string, now: Date): Promise<number> {
  const since = isoSeconds(new Date(now.getTime() - LOCK_MINUTES * 60_000));
  const row = await db
    .prepare("SELECT count(*) AS n FROM login_attempts WHERE username = ? AND ip = ? AND created_at > ?")
    .bind(username, ip, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

export async function login(
  db: Db,
  usernameRaw: unknown,
  passwordRaw: unknown,
  ip: string,
  now: Date,
): Promise<LoginResult> {
  const username = typeof usernameRaw === "string" ? usernameRaw.trim().toLowerCase().slice(0, 64) : "";
  const password = typeof passwordRaw === "string" ? passwordRaw.slice(0, 256) : "";

  if ((await recentFailures(db, username, ip, now)) >= MAX_FAILED_ATTEMPTS) {
    return { ok: false, reason: "bloqueado" };
  }

  const admin = username
    ? await db
        .prepare(
          `SELECT id, username, password_hash, password_salt, totp_enabled, must_change_password
           FROM admins WHERE username = ?`,
        )
        .bind(username)
        .first<AdminRow>()
    : null;
  const valid = await verifyPassword(
    password,
    admin ? { hash: admin.password_hash, salt: admin.password_salt } : DUMMY,
  );

  if (!admin || !valid || !password) {
    await db
      .prepare("INSERT INTO login_attempts (username, ip, created_at) VALUES (?, ?, ?)")
      .bind(username, ip, isoSeconds(now))
      .run();
    return { ok: false, reason: "credenciales" };
  }

  const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const needs2fa = admin.totp_enabled === 1;
  const expires = isoSeconds(
    new Date(now.getTime() + (needs2fa ? PENDING_2FA_MINUTES * 60_000 : SESSION_HOURS * 3_600_000)),
  );
  await db.batch([
    db.prepare("DELETE FROM login_attempts WHERE username = ? AND ip = ?").bind(username, ip),
    db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(isoSeconds(now)),
    db
      .prepare("INSERT INTO sessions (id, admin_id, expires_at, second_factor_passed) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(token), admin.id, expires, needs2fa ? 0 : 1),
  ]);
  return {
    ok: true,
    token,
    expires_at: expires,
    must_change_password: admin.must_change_password === 1,
    needs_second_factor: needs2fa,
  };
}

// ---------------------------------------------------------------
// Sesiones
// ---------------------------------------------------------------

export interface Session {
  session_id: string; // hash del token
  admin_id: string;
  username: string;
  expires_at: string;
  second_factor_passed: boolean;
  must_change_password: boolean;
  totp_enabled: boolean;
}

export async function getSession(db: Db, token: string | undefined, now: Date): Promise<Session | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const id = await sha256Hex(token);
  const row = await db
    .prepare(
      `SELECT s.id, s.admin_id, s.expires_at, s.second_factor_passed,
              a.username, a.must_change_password, a.totp_enabled
       FROM sessions s JOIN admins a ON a.id = s.admin_id
       WHERE s.id = ? AND s.expires_at > ?`,
    )
    .bind(id, isoSeconds(now))
    .first<{
      id: string;
      admin_id: string;
      expires_at: string;
      second_factor_passed: number;
      username: string;
      must_change_password: number;
      totp_enabled: number;
    }>();
  if (!row) return null;
  return {
    session_id: row.id,
    admin_id: row.admin_id,
    username: row.username,
    expires_at: row.expires_at,
    second_factor_passed: row.second_factor_passed === 1,
    must_change_password: row.must_change_password === 1,
    totp_enabled: row.totp_enabled === 1,
  };
}

export async function logout(db: Db, token: string | undefined): Promise<void> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return;
  await db.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256Hex(token)).run();
}

// ---------------------------------------------------------------
// Cambio de contraseña
// ---------------------------------------------------------------

export type ChangePasswordError = "actual_incorrecta" | "nueva_invalida";

export function passwordProblem(next: string, username: string, current: string): string | null {
  if (next.length < MIN_PASSWORD_LENGTH) return `La nueva contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`;
  if (next.length > 128) return "La nueva contraseña es demasiado larga (máximo 128 caracteres).";
  const lower = next.toLowerCase();
  if (lower === "admin" || lower === username.toLowerCase()) return "La nueva contraseña no puede ser igual al usuario.";
  if (next === current) return "La nueva contraseña debe ser distinta de la actual.";
  return null;
}

/**
 * Cambia la contraseña. Desactiva must_change_password y cierra todas las demás
 * sesiones del administrador. Devuelve null si todo salió bien, o el error.
 */
export async function changePassword(
  db: Db,
  session: Session,
  currentRaw: unknown,
  nextRaw: unknown,
): Promise<{ error: ChangePasswordError; message: string } | null> {
  const current = typeof currentRaw === "string" ? currentRaw.slice(0, 256) : "";
  const next = typeof nextRaw === "string" ? nextRaw : "";
  const admin = await db
    .prepare("SELECT password_hash, password_salt FROM admins WHERE id = ?")
    .bind(session.admin_id)
    .first<{ password_hash: string; password_salt: string }>();
  if (!admin || !(await verifyPassword(current, { hash: admin.password_hash, salt: admin.password_salt }))) {
    return { error: "actual_incorrecta", message: "La contraseña actual no es correcta." };
  }
  const problem = passwordProblem(next, session.username, current);
  if (problem) return { error: "nueva_invalida", message: problem };

  const { hash, salt } = await hashPassword(next);
  await db.batch([
    db
      .prepare("UPDATE admins SET password_hash = ?, password_salt = ?, must_change_password = 0 WHERE id = ?")
      .bind(hash, salt, session.admin_id),
    db.prepare("DELETE FROM sessions WHERE admin_id = ? AND id <> ?").bind(session.admin_id, session.session_id),
  ]);
  return null;
}
