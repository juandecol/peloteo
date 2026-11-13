// TOTP (RFC 6238) con HMAC-SHA1, pasos de 30 segundos y 6 dígitos: lo que
// usan Google Authenticator, Authy, 1Password y similares. Solo Web Crypto.

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** Pasos de tolerancia hacia atrás y adelante (reloj del teléfono desfasado). */
export const TOTP_WINDOW = 1;

const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array | null {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const v = B32.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** Clave nueva: 20 bytes aleatorios (160 bits, lo que recomienda el RFC 4226). */
export function newTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

/** Código HOTP (RFC 4226) para un contador. */
export async function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): Promise<string> {
  const msg = new Uint8Array(8);
  let c = counter;
  for (let i = 7; i >= 0; i--) {
    msg[i] = c & 255;
    c = Math.floor(c / 256);
  }
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const off = mac[mac.length - 1]! & 15;
  const bin =
    ((mac[off]! & 127) << 24) | (mac[off + 1]! << 16) | (mac[off + 2]! << 8) | mac[off + 3]!;
  return String(bin % 10 ** digits).padStart(digits, "0");
}

export function totpStep(now: Date): number {
  return Math.floor(now.getTime() / 1000 / TOTP_STEP_SECONDS);
}

/**
 * Busca el código dentro de la ventana de tolerancia. Devuelve el paso que
 * coincide o null. Solo acepta pasos posteriores a `afterStep` (anti-reutilización).
 */
export async function matchTotp(
  secretB32: string,
  code: string,
  now: Date,
  afterStep: number | null = null,
): Promise<number | null> {
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(code)) return null;
  const secret = base32Decode(secretB32);
  if (!secret || secret.length === 0) return null;
  const current = totpStep(now);
  let found: number | null = null;
  // Se calculan todos los candidatos para no revelar cuál coincide por el tiempo.
  for (let step = current - TOTP_WINDOW; step <= current + TOTP_WINDOW; step++) {
    const candidate = await hotp(secret, step);
    let diff = 0;
    for (let i = 0; i < TOTP_DIGITS; i++) diff |= candidate.charCodeAt(i) ^ code.charCodeAt(i);
    if (diff === 0 && (afterStep === null || step > afterStep) && found === null) found = step;
  }
  return found;
}

/** Dirección otpauth:// para el QR y para abrir la app en el teléfono. */
export function otpauthUri(secretB32: string, account: string, issuer = "Peloteo"): string {
  const label = encodeURIComponent(issuer) + ":" + encodeURIComponent(account);
  return (
    `otpauth://totp/${label}?secret=${secretB32}&issuer=${encodeURIComponent(issuer)}` +
    `&algorithm=SHA1&digits=${TOTP_DIGITS}&period=${TOTP_STEP_SECONDS}`
  );
}

// ---------------------------------------------------------------
// Códigos de respaldo
// ---------------------------------------------------------------

export const RECOVERY_CODE_COUNT = 10;
// 31 símbolos, sin 0/o, 1/i/l para que no se confundan. 12 símbolos ≈ 59 bits.
const RC_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

function randomSymbols(count: number): string {
  let out = "";
  while (out.length < count) {
    for (const b of crypto.getRandomValues(new Uint8Array(count))) {
      const v = b & 31; // 0..31; se descarta el 31 para que todos sean equiprobables
      if (v < RC_ALPHABET.length && out.length < count) out += RC_ALPHABET[v];
    }
  }
  return out;
}

/** Códigos con el formato "xxxx-xxxx-xxxx". */
export function newRecoveryCodes(n = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: n }, () => {
    const s = randomSymbols(12);
    return `${s.slice(0, 4)}-${s.slice(4, 8)}-${s.slice(8)}`;
  });
}

/** Normaliza lo que escribe el usuario: minúsculas, sin espacios ni guiones. Null si no tiene forma de código. */
export function normalizeRecoveryCode(input: string): string | null {
  const s = input.toLowerCase().replace(/[\s-]/g, "");
  return /^[a-hjkmnp-z2-9]{12}$/.test(s) ? s : null;
}
