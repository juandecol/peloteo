// Cuentas de jugadores: preparadas, todavía desactivadas (ACCOUNTS_ENABLED).
//
// Diseño decidido el 2026-11-14:
// - Opcionales: se puede seguir jugando sin cuenta, con la cookie visitor_id.
// - Ingreso con un enlace de un solo uso enviado al correo; sin contraseñas.
// - Al entrar, los partidos de ese navegador y los anotados con ese correo
//   pasan a la cuenta, y desde ahí se ven en todos sus dispositivos.
// - El perfil guarda iniciales, WhatsApp, aviso por WhatsApp y nivel por deporte,
//   para no tener que escribirlos en cada partido.
//
// La base guarda solo el SHA-256 de los tokens (enlaces y sesiones).

import { isoSeconds, sha256Hex } from "./auth.ts";
import { newId, placeholders, type Db } from "./db.ts";
import type { Who } from "./identity.ts";

export const LOGIN_LINK_MINUTES = 15;
export const MAX_LINKS_PER_WINDOW = 3; // por correo, cada LOGIN_LINK_MINUTES
export const USER_SESSION_DAYS = 90;

export type AccountErrorCode = "email_invalido" | "demasiados_enlaces" | "enlace_invalido" | "datos_invalidos";

export class AccountError extends Error {
  code: AccountErrorCode;
  field?: string;
  constructor(code: AccountErrorCode, message: string, field?: string) {
    super(message);
    this.code = code;
    this.field = field;
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(raw: unknown): string | null {
  const e = typeof raw === "string" ? raw.trim().toLowerCase() : "";
  return e.length <= 254 && EMAIL_RE.test(e) ? e : null;
}

function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(32)), (b) => b.toString(16).padStart(2, "0")).join("");
}

const plusMinutes = (d: Date, m: number) => isoSeconds(new Date(d.getTime() + m * 60_000));

// ---------------------------------------------------------------
// Enlace de ingreso
// ---------------------------------------------------------------

/**
 * Crea un enlace de ingreso para un correo. Devuelve el token (para el correo;
 * no se guarda). `visitorId` es el navegador que lo pidió: sus partidos pasarán
 * a la cuenta. Límite: 3 enlaces por correo cada 15 minutos.
 */
export async function requestLoginLink(
  db: Db,
  emailRaw: unknown,
  visitorId: string | null,
  now: Date,
): Promise<{ email: string; token: string; expires_at: string }> {
  const email = normalizeEmail(emailRaw);
  if (!email) throw new AccountError("email_invalido", "Revisa el email.", "email");
  const recent = await db
    .prepare("SELECT count(*) AS n FROM login_links WHERE email = ? AND created_at > ?")
    .bind(email, plusMinutes(now, -LOGIN_LINK_MINUTES))
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= MAX_LINKS_PER_WINDOW) {
    throw new AccountError("demasiados_enlaces", "Ya te enviamos varios enlaces. Revisa tu correo o espera unos minutos.");
  }
  const token = randomToken();
  const expires = plusMinutes(now, LOGIN_LINK_MINUTES);
  await db
    .prepare("INSERT INTO login_links (id, email, token_hash, visitor_id, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(newId("K", 8), email, await sha256Hex(token), visitorId, expires, isoSeconds(now))
    .run();
  return { email, token, expires_at: expires };
}

export interface User {
  id: string;
  email: string;
  initials: string | null;
  whatsapp: string | null;
  whatsapp_opt_in: boolean;
}

interface UserRow {
  id: string;
  email: string;
  initials: string | null;
  whatsapp: string | null;
  whatsapp_opt_in: number;
}

const toUser = (r: UserRow): User => ({ ...r, whatsapp_opt_in: r.whatsapp_opt_in === 1 });

/**
 * Usa un enlace de ingreso: lo marca como usado (una sola vez, dentro de su
 * plazo), crea la cuenta si no existía, le traspasa los partidos y abre una
 * sesión. Devuelve el token de sesión (para la cookie; no se guarda).
 */
export async function signInWithLink(
  db: Db,
  token: unknown,
  now: Date,
): Promise<{ user: User; session_token: string; expires_at: string; linked_players: number }> {
  const bad = () => new AccountError("enlace_invalido", "El enlace ya se usó o venció. Pide uno nuevo.");
  if (typeof token !== "string" || !/^[0-9a-f]{64}$/.test(token)) throw bad();
  const hash = await sha256Hex(token);
  const link = await db
    .prepare("SELECT id, email, visitor_id FROM login_links WHERE token_hash = ? AND used_at IS NULL AND expires_at > ?")
    .bind(hash, isoSeconds(now))
    .first<{ id: string; email: string; visitor_id: string | null }>();
  if (!link) throw bad();
  const used = await db
    .prepare("UPDATE login_links SET used_at = ? WHERE id = ? AND used_at IS NULL")
    .bind(isoSeconds(now), link.id)
    .run();
  if (used.meta.changes !== 1) throw bad();

  // Cuenta: la existente con ese correo o una nueva.
  await db
    .prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?) ON CONFLICT(email) DO NOTHING")
    .bind(newId("U", 8), link.email, isoSeconds(now))
    .run();
  const row = await db
    .prepare("SELECT id, email, initials, whatsapp, whatsapp_opt_in FROM users WHERE email = ?")
    .bind(link.email)
    .first<UserRow>();
  const user = toUser(row!);

  const linked = await linkPlayers(db, user.id, link.email, link.visitor_id);

  const sessionToken = randomToken();
  const expires = isoSeconds(new Date(now.getTime() + USER_SESSION_DAYS * 86_400_000));
  await db.batch([
    db.prepare("DELETE FROM user_sessions WHERE expires_at <= ?").bind(isoSeconds(now)),
    db.prepare("INSERT INTO user_sessions (id, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
      .bind(await sha256Hex(sessionToken), user.id, expires, isoSeconds(now)),
    db.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(isoSeconds(now), user.id),
  ]);
  return { user, session_token: sessionToken, expires_at: expires, linked_players: linked };
}

/**
 * Traspasa a la cuenta los cupos sin cuenta de ese navegador y los anotados con
 * ese correo (ya verificado por el enlace). Si en un mismo encuentro hay más de
 * uno, solo se traspasa el primero: una cuenta no ocupa dos cupos del mismo partido.
 */
export async function linkPlayers(db: Db, userId: string, email: string, visitorId: string | null): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT id, game_id FROM players
       WHERE user_id IS NULL AND (lower(email) = ? OR visitor_id = ?)
         AND game_id NOT IN (SELECT game_id FROM players WHERE user_id = ?)
       ORDER BY rowid`,
    )
    .bind(email, visitorId ?? "", userId)
    .all<{ id: string; game_id: string }>();
  const seen = new Set<string>();
  const ids = results.filter((p) => (seen.has(p.game_id) ? false : (seen.add(p.game_id), true))).map((p) => p.id);
  if (ids.length === 0) return 0;
  const r = await db
    .prepare(`UPDATE players SET user_id = ? WHERE user_id IS NULL AND id IN (${placeholders(ids.length)})`)
    .bind(userId, ...ids)
    .run();
  return r.meta.changes;
}

// ---------------------------------------------------------------
// Sesiones
// ---------------------------------------------------------------

export async function getUserBySession(db: Db, token: string | undefined, now: Date): Promise<User | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await db
    .prepare(
      `SELECT u.id, u.email, u.initials, u.whatsapp, u.whatsapp_opt_in
       FROM user_sessions s JOIN users u ON u.id = s.user_id
       WHERE s.id = ? AND s.expires_at > ?`,
    )
    .bind(await sha256Hex(token), isoSeconds(now))
    .first<UserRow>();
  return row ? toUser(row) : null;
}

export async function signOut(db: Db, token: string | undefined): Promise<void> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return;
  await db.prepare("DELETE FROM user_sessions WHERE id = ?").bind(await sha256Hex(token)).run();
}

/** Identidad para la lógica de partidos: el navegador y, si entró, su cuenta. */
export function whoOf(visitorId: string, user: User | null): Who {
  return { visitorId, userId: user ? user.id : null };
}

// ---------------------------------------------------------------
// Perfil
// ---------------------------------------------------------------

export interface Profile extends User {
  /** Nivel por deporte (nombre normalizado, por ejemplo "tenis"). */
  levels: Record<string, number>;
}

export async function getProfile(db: Db, userId: string): Promise<Profile | null> {
  const row = await db
    .prepare("SELECT id, email, initials, whatsapp, whatsapp_opt_in FROM users WHERE id = ?")
    .bind(userId)
    .first<UserRow>();
  if (!row) return null;
  const { results } = await db
    .prepare("SELECT sport_key, level FROM user_levels WHERE user_id = ? ORDER BY sport_key")
    .bind(userId)
    .all<{ sport_key: string; level: number }>();
  return { ...toUser(row), levels: Object.fromEntries(results.map((l) => [l.sport_key, l.level])) };
}

export interface ProfileInput {
  initials?: unknown;
  whatsapp?: unknown;
  whatsapp_opt_in?: unknown;
  levels?: unknown;
}

/** Guarda el perfil. Mismas reglas que al anotarse en un partido. */
export async function updateProfile(db: Db, userId: string, input: ProfileInput): Promise<Profile> {
  const initials = typeof input.initials === "string" ? input.initials.trim().toUpperCase() : "";
  if (!/^[A-ZÑÁÉÍÓÚÜ]{2,4}$/.test(initials)) {
    throw new AccountError("datos_invalidos", "Escribe tus iniciales (2 a 4 letras).", "initials");
  }
  const rawWa = typeof input.whatsapp === "string" ? input.whatsapp.trim() : "";
  let whatsapp: string | null = null;
  if (rawWa) {
    const digits = rawWa.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) {
      throw new AccountError("datos_invalidos", "Revisa el número de WhatsApp o déjalo en blanco.", "whatsapp");
    }
    whatsapp = "+" + digits;
  }
  const optIn = whatsapp !== null && (input.whatsapp_opt_in === true || input.whatsapp_opt_in === 1) ? 1 : 0;
  const levels: [string, number][] = [];
  if (input.levels !== undefined) {
    if (!input.levels || typeof input.levels !== "object" || Array.isArray(input.levels)) {
      throw new AccountError("datos_invalidos", "Niveles inválidos.", "levels");
    }
    for (const [key, value] of Object.entries(input.levels as Record<string, unknown>)) {
      const level = Number(value);
      if (!/^[a-z0-9 ]{1,40}$/.test(key) || !Number.isInteger(level) || level < 1 || level > 5) {
        throw new AccountError("datos_invalidos", "Niveles inválidos.", "levels");
      }
      levels.push([key, level]);
    }
  }
  await db.batch([
    db.prepare("UPDATE users SET initials = ?, whatsapp = ?, whatsapp_opt_in = ? WHERE id = ?").bind(initials, whatsapp, optIn, userId),
    ...levels.map(([key, level]) =>
      db
        .prepare("INSERT INTO user_levels (user_id, sport_key, level) VALUES (?, ?, ?) ON CONFLICT(user_id, sport_key) DO UPDATE SET level = excluded.level")
        .bind(userId, key, level),
    ),
  ]);
  return (await getProfile(db, userId))!;
}
