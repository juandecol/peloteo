// Ajustes del sitio que el administrador cambia desde Configuración (tabla settings).

import type { Db } from "./db.ts";

export interface Settings {
  /**
   * Pedir el WhatsApp de los jugadores en el formulario. Apagado: el campo no se
   * muestra y el servidor ignora el número (y el aviso por WhatsApp) aunque llegue.
   */
  whatsapp_contact: boolean;
}

export const DEFAULT_SETTINGS: Settings = { whatsapp_contact: false };

export async function getSettings(db: Db): Promise<Settings> {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: string; value: string }>();
  const map = new Map(results.map((r) => [r.key, r.value]));
  return {
    whatsapp_contact: map.has("whatsapp_contact") ? map.get("whatsapp_contact") === "1" : DEFAULT_SETTINGS.whatsapp_contact,
  };
}

/** Guarda los ajustes recibidos (solo las claves conocidas y con valor válido). */
export async function updateSettings(db: Db, input: Record<string, unknown>): Promise<Settings> {
  const statements = [];
  if (typeof input.whatsapp_contact === "boolean") {
    statements.push(
      db
        .prepare(
          `INSERT INTO settings (key, value, updated_at) VALUES ('whatsapp_contact', ?, strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
           ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
        )
        .bind(input.whatsapp_contact ? "1" : "0"),
    );
  }
  if (statements.length) await db.batch(statements);
  return getSettings(db);
}
