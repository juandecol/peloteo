// Segundo factor del administrador (etapa 7).
//
// - Activación: /setup genera una clave nueva (aún sin activar) y /enable la
//   activa al recibir un código válido. En ese momento se entregan 10 códigos de
//   respaldo de un solo uso y se cierran las demás sesiones.
// - Login: si totp_enabled, la sesión nace con second_factor_passed = 0 y dura
//   10 minutos; con un código TOTP o de respaldo válido pasa a sesión completa.
// - Cada código TOTP se acepta una sola vez (totp_last_step).
// - Los fallos cuentan en login_attempts igual que los de contraseña: con 5 en
//   15 minutos (usuario e IP) se bloquea.
// - Desactivar pide contraseña y un código; también cierra las demás sesiones.

import {
  isoSeconds,
  MAX_FAILED_ATTEMPTS,
  recentFailures,
  sha256Hex,
  SESSION_HOURS,
  verifyPassword,
  type Session,
} from "./auth.ts";
import { newId, type Db, type DbStatement } from "./db.ts";
import { matchTotp, newRecoveryCodes, newTotpSecret, normalizeRecoveryCode, otpauthUri } from "./totp.ts";

export type TwoFactorErrorCode =
  | "bloqueado"
  | "codigo_incorrecto"
  | "contrasena_incorrecta"
  | "ya_activo"
  | "no_activo"
  | "sin_configurar";

export class TwoFactorError extends Error {
  code: TwoFactorErrorCode;
  constructor(code: TwoFactorErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

const LOCKED = () =>
  new TwoFactorError("bloqueado", "Demasiados intentos fallidos. Espera 15 minutos e inténtalo de nuevo.");
const WRONG = () => new TwoFactorError("codigo_incorrecto", "El código no es correcto o ya se usó.");

interface AdminTotp {
  id: string;
  username: string;
  totp_secret: string | null;
  totp_enabled: number;
  totp_last_step: number | null;
}

async function loadAdmin(db: Db, adminId: string): Promise<AdminTotp | null> {
  return db
    .prepare("SELECT id, username, totp_secret, totp_enabled, totp_last_step FROM admins WHERE id = ?")
    .bind(adminId)
    .first<AdminTotp>();
}

const recoveryHash = (adminId: string, normalized: string) => sha256Hex(`${adminId}:${normalized}`);

async function recoveryStatements(db: Db, adminId: string): Promise<{ codes: string[]; statements: DbStatement[] }> {
  const codes = newRecoveryCodes();
  const statements = [db.prepare("DELETE FROM admin_recovery_codes WHERE admin_id = ?").bind(adminId)];
  for (const code of codes) {
    statements.push(
      db
        .prepare("INSERT INTO admin_recovery_codes (id, admin_id, code_hash) VALUES (?, ?, ?)")
        .bind(newId("R", 8), adminId, await recoveryHash(adminId, normalizeRecoveryCode(code)!)),
    );
  }
  return { codes, statements };
}

/**
 * Verifica un código TOTP o de respaldo y lo consume en la misma operación
 * (UPDATE condicionado): dos solicitudes simultáneas no pueden usar el mismo.
 */
async function consumeCode(
  db: Db,
  admin: AdminTotp,
  rawCode: unknown,
  now: Date,
  allowRecovery: boolean,
): Promise<"totp" | "respaldo" | null> {
  const code = typeof rawCode === "string" ? rawCode.trim().slice(0, 64) : "";
  const digits = code.replace(/\s/g, "");
  if (/^\d{6}$/.test(digits) && admin.totp_secret) {
    const step = await matchTotp(admin.totp_secret, digits, now, admin.totp_last_step);
    if (step === null) return null;
    const r = await db
      .prepare(
        "UPDATE admins SET totp_last_step = ? WHERE id = ? AND (totp_last_step IS NULL OR totp_last_step < ?)",
      )
      .bind(step, admin.id, step)
      .run();
    return r.meta.changes === 1 ? "totp" : null;
  }
  const normalized = allowRecovery ? normalizeRecoveryCode(code) : null;
  if (!normalized) return null;
  const r = await db
    .prepare("UPDATE admin_recovery_codes SET used_at = ? WHERE admin_id = ? AND code_hash = ? AND used_at IS NULL")
    .bind(isoSeconds(now), admin.id, await recoveryHash(admin.id, normalized))
    .run();
  return r.meta.changes === 1 ? "respaldo" : null;
}

/** Verifica un código con límite de intentos (usuario e IP). Lanza TwoFactorError si falla. */
async function checkCode(
  db: Db,
  admin: AdminTotp,
  code: unknown,
  ip: string,
  now: Date,
  allowRecovery = true,
): Promise<"totp" | "respaldo"> {
  if ((await recentFailures(db, admin.username, ip, now)) >= MAX_FAILED_ATTEMPTS) throw LOCKED();
  const used = await consumeCode(db, admin, code, now, allowRecovery);
  if (!used) {
    await db
      .prepare("INSERT INTO login_attempts (username, ip, created_at) VALUES (?, ?, ?)")
      .bind(admin.username, ip, isoSeconds(now))
      .run();
    throw WRONG();
  }
  return used;
}

export async function remainingRecoveryCodes(db: Db, adminId: string): Promise<number> {
  const row = await db
    .prepare("SELECT count(*) AS n FROM admin_recovery_codes WHERE admin_id = ? AND used_at IS NULL")
    .bind(adminId)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

// ---------------------------------------------------------------
// Login: segundo paso
// ---------------------------------------------------------------

/** Completa el login con un código. Devuelve cómo se validó y los códigos de respaldo que quedan. */
export async function passSecondFactor(
  db: Db,
  session: Session,
  code: unknown,
  ip: string,
  now: Date,
): Promise<{ method: "totp" | "respaldo"; recovery_left: number }> {
  const admin = await loadAdmin(db, session.admin_id);
  if (!admin || admin.totp_enabled !== 1) throw new TwoFactorError("no_activo", "El segundo factor no está activo.");
  const method = await checkCode(db, admin, code, ip, now);
  await db.batch([
    db
      .prepare("UPDATE sessions SET second_factor_passed = 1, expires_at = ? WHERE id = ?")
      .bind(isoSeconds(new Date(now.getTime() + SESSION_HOURS * 3_600_000)), session.session_id),
    db.prepare("DELETE FROM login_attempts WHERE username = ? AND ip = ?").bind(admin.username, ip),
  ]);
  return { method, recovery_left: await remainingRecoveryCodes(db, admin.id) };
}

// ---------------------------------------------------------------
// Activar, desactivar y renovar códigos (con sesión completa)
// ---------------------------------------------------------------

/** Genera una clave nueva sin activarla. Reemplaza una configuración a medias. */
export async function startSetup(db: Db, session: Session): Promise<{ secret: string; uri: string }> {
  const secret = newTotpSecret();
  const r = await db
    .prepare("UPDATE admins SET totp_secret = ?, totp_last_step = NULL WHERE id = ? AND totp_enabled = 0")
    .bind(secret, session.admin_id)
    .run();
  if (r.meta.changes !== 1) throw new TwoFactorError("ya_activo", "La verificación en dos pasos ya está activa.");
  return { secret, uri: otpauthUri(secret, session.username) };
}

/** Activa el segundo factor con el primer código de la app. Devuelve los códigos de respaldo. */
export async function enable(
  db: Db,
  session: Session,
  code: unknown,
  ip: string,
  now: Date,
): Promise<{ recovery_codes: string[] }> {
  const admin = await loadAdmin(db, session.admin_id);
  if (!admin) throw new TwoFactorError("sin_configurar", "Vuelve a empezar la activación.");
  if (admin.totp_enabled === 1) throw new TwoFactorError("ya_activo", "La verificación en dos pasos ya está activa.");
  if (!admin.totp_secret) throw new TwoFactorError("sin_configurar", "Vuelve a empezar la activación.");
  await checkCode(db, admin, code, ip, now, false);
  const { codes, statements } = await recoveryStatements(db, admin.id);
  await db.batch([
    db.prepare("UPDATE admins SET totp_enabled = 1 WHERE id = ? AND totp_enabled = 0").bind(admin.id),
    ...statements,
    db.prepare("DELETE FROM sessions WHERE admin_id = ? AND id <> ?").bind(admin.id, session.session_id),
    db.prepare("DELETE FROM login_attempts WHERE username = ? AND ip = ?").bind(admin.username, ip),
  ]);
  return { recovery_codes: codes };
}

/** Desactiva el segundo factor. Pide la contraseña y un código (de la app o de respaldo). */
export async function disable(
  db: Db,
  session: Session,
  password: unknown,
  code: unknown,
  ip: string,
  now: Date,
): Promise<void> {
  const admin = await loadAdmin(db, session.admin_id);
  if (!admin || admin.totp_enabled !== 1) throw new TwoFactorError("no_activo", "El segundo factor no está activo.");
  if ((await recentFailures(db, admin.username, ip, now)) >= MAX_FAILED_ATTEMPTS) throw LOCKED();
  const pw = await db
    .prepare("SELECT password_hash, password_salt FROM admins WHERE id = ?")
    .bind(admin.id)
    .first<{ password_hash: string; password_salt: string }>();
  const okPassword =
    !!pw &&
    (await verifyPassword(typeof password === "string" ? password.slice(0, 256) : "", {
      hash: pw.password_hash,
      salt: pw.password_salt,
    }));
  if (!okPassword) {
    await db
      .prepare("INSERT INTO login_attempts (username, ip, created_at) VALUES (?, ?, ?)")
      .bind(admin.username, ip, isoSeconds(now))
      .run();
    throw new TwoFactorError("contrasena_incorrecta", "La contraseña no es correcta.");
  }
  await checkCode(db, admin, code, ip, now);
  await db.batch([
    db
      .prepare("UPDATE admins SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL WHERE id = ?")
      .bind(admin.id),
    db.prepare("DELETE FROM admin_recovery_codes WHERE admin_id = ?").bind(admin.id),
    db.prepare("DELETE FROM sessions WHERE admin_id = ? AND id <> ?").bind(admin.id, session.session_id),
  ]);
}

/** Reemplaza los códigos de respaldo. Pide un código de la app. */
export async function regenerateRecoveryCodes(
  db: Db,
  session: Session,
  code: unknown,
  ip: string,
  now: Date,
): Promise<{ recovery_codes: string[] }> {
  const admin = await loadAdmin(db, session.admin_id);
  if (!admin || admin.totp_enabled !== 1) throw new TwoFactorError("no_activo", "El segundo factor no está activo.");
  await checkCode(db, admin, code, ip, now, false);
  const { codes, statements } = await recoveryStatements(db, admin.id);
  await db.batch(statements);
  return { recovery_codes: codes };
}
