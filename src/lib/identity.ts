// Quién está jugando: el navegador (cookie visitor_id) y, cuando las cuentas
// estén activas, la cuenta con la que entró. Hoy userId siempre es null.
//
// Un cupo es "mío" si lo tomó este navegador o, con cuenta, si pertenece a
// esa cuenta (desde cualquier dispositivo).

export interface Who {
  visitorId: string;
  userId: string | null;
}

/** Acepta el ID de visitante (como hasta ahora) o un Who completo. */
export function asWho(who: string | Who | null | undefined): Who | null {
  if (!who) return null;
  return typeof who === "string" ? { visitorId: who, userId: null } : who;
}

/** Condición SQL "el cupo (alias) es de esta persona"; usar con ownsParams. */
export function ownsSql(alias = "p"): string {
  return `(${alias}.visitor_id = ? OR (${alias}.user_id IS NOT NULL AND ${alias}.user_id = ?))`;
}

export function ownsParams(who: Who | null): [string, string] {
  return [who?.visitorId ?? "", who?.userId ?? ""];
}

export function isMine(p: { visitor_id: string; user_id?: string | null }, who: Who | null): boolean {
  if (!who) return false;
  return p.visitor_id === who.visitorId || (!!who.userId && p.user_id === who.userId);
}
