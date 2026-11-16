// Ajustes del sitio que el administrador cambia desde Configuración (tabla settings).

import type { Db } from "./db.ts";

export interface Settings {
  /**
   * Pedir el WhatsApp de los jugadores en el formulario. Apagado: el campo no se
   * muestra y el servidor ignora el número (y el aviso por WhatsApp) aunque llegue.
   */
  whatsapp_contact: boolean;
  /**
   * Pedir el consentimiento de cookies (2026-11-16). Encendido: el sitio muestra el aviso
   * de cookies y solo activa las categorías que el visitante acepte (analítica,
   * publicidad). Apagado (por defecto): no hay aviso y ninguna categoría opcional se activa.
   */
  cookie_consent: boolean;
}

export const DEFAULT_SETTINGS: Settings = { whatsapp_contact: false, cookie_consent: false };

/** Ajustes sí/no: se guardan como "1" o "0"; una clave sin fila toma su valor por defecto. */
const FLAGS = Object.keys(DEFAULT_SETTINGS) as (keyof Settings)[];

export async function getSettings(db: Db): Promise<Settings> {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const map = new Map(results.map((r) => [r.key, r.value]));
  const out = { ...DEFAULT_SETTINGS };
  for (const key of FLAGS) if (map.has(key)) out[key] = map.get(key) === "1";
  return out;
}

/** Guarda los ajustes recibidos (solo las claves conocidas y con valor válido). */
export async function updateSettings(db: Db, input: Record<string, unknown>): Promise<Settings> {
  const statements = [];
  for (const key of FLAGS) {
    const value = input[key];
    if (typeof value !== "boolean") continue;
    statements.push(
      db
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .bind(key, value ? "1" : "0"),
    );
  }
  if (statements.length) await db.batch(statements);
  return getSettings(db);
}
