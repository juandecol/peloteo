// Módulo de configuración del administrador: lugares, deportes con categorías,
// canchas con características y horarios, y lista de encuentros.
//
// Eliminar un lugar, deporte o cancha es lógico (deleted_at): los encuentros
// cancelados se conservan y siguen apuntando a ellos. Si hay encuentros futuros
// afectados, se pide confirmación; al confirmar pasan a 'cancelado' y se avisa.

import { blockCoversSlot, courtHasSlot, parseIntList, type Court } from "./availability.ts";
import { newId, placeholders, type Db, type DbStatement } from "./db.ts";
import type { CancelCause, PendingNotice } from "./notify.ts";
import { isDate, isTime, toMinutes, type LocalNow } from "./time.ts";

export class ConfigError extends Error {
  readonly code: "datos_invalidos" | "no_existe" | "afecta_encuentros";
  readonly field?: string;
  readonly games?: GameRef[];
  constructor(code: ConfigError["code"], message: string, field?: string, games?: GameRef[]) {
    super(message);
    this.name = "ConfigError";
    this.code = code;
    this.field = field;
    this.games = games;
  }
}

/** Referencia breve a un encuentro afectado, para mostrar al administrador. */
export interface GameRef {
  id: string;
  date: string;
  time: string;
  status: string;
  players: number;
}

const invalid = (message: string, field: string) => new ConfigError("datos_invalidos", message, field);

function text(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().replace(/\s+/g, " ").slice(0, max + 1) : "";
}

function requiredText(v: unknown, max: number, field: string, label: string): string {
  const t = text(v, max);
  if (!t) throw invalid(`Escribe ${label}.`, field);
  if (t.length > max) throw invalid(`El texto es demasiado largo (máximo ${max} caracteres).`, field);
  return t;
}

function optionalText(v: unknown, max: number, field: string): string {
  const t = text(v, max);
  if (t.length > max) throw invalid(`El texto es demasiado largo (máximo ${max} caracteres).`, field);
  return t;
}

function optionalUrl(v: unknown, field: string): string {
  const t = optionalText(v, 500, field);
  if (!t) return "";
  try {
    const u = new URL(t);
    if (u.protocol === "https:" || u.protocol === "http:") return u.toString();
  } catch {
    // cae al error de abajo
  }
  throw invalid("El enlace debe empezar con https://", field);
}

// ---------------------------------------------------------------
// Encuentros afectados por una eliminación
// ---------------------------------------------------------------

/** Encuentros vigentes (no cancelados) desde hoy que cumplen la condición. */
async function futureGames(db: Db, where: string, params: unknown[], now: LocalNow): Promise<GameRef[]> {
  const { results } = await db
    .prepare(
      `SELECT g.id, g.date, g.time, g.status,
              (SELECT count(*) FROM players p WHERE p.game_id = g.id) AS players
       FROM games g
       WHERE ${where} AND g.status <> 'cancelado' AND g.date >= ?
       ORDER BY g.date, g.time, g.id`,
    )
    .bind(...params, now.date)
    .all<GameRef>();
  return results;
}

function cancelGamesStmt(db: Db, ids: string[]): DbStatement[] {
  if (ids.length === 0) return [];
  return [
    db
      .prepare(`UPDATE games SET status = 'cancelado' WHERE id IN (${placeholders(ids.length)}) AND status <> 'cancelado'`)
      .bind(...ids),
  ];
}

async function cancelNotices(
  db: Db,
  gameIds: string[],
  cause: CancelCause = "administrador",
): Promise<PendingNotice[]> {
  if (gameIds.length === 0) return [];
  const { results } = await db
    .prepare(`SELECT id, game_id FROM players WHERE game_id IN (${placeholders(gameIds.length)}) ORDER BY rowid`)
    .bind(...gameIds)
    .all<{ id: string; game_id: string }>();
  return gameIds.map((g) => ({
    event: "encuentro_cancelado" as const,
    game_id: g,
    cause,
    player_ids: results.filter((p) => p.game_id === g).map((p) => p.id),
  }));
}

export type DeleteResult =
  | { deleted: false; needs_confirmation: true; games: GameRef[] }
  | { deleted: true; cancelled_games: number; notices: PendingNotice[] };

async function deleteWith(
  db: Db,
  affected: GameRef[],
  confirm: boolean,
  statements: DbStatement[],
): Promise<DeleteResult> {
  if (affected.length > 0 && !confirm) return { deleted: false, needs_confirmation: true, games: affected };
  const ids = affected.map((g) => g.id);
  const notices = await cancelNotices(db, ids);
  await db.batch([...cancelGamesStmt(db, ids), ...statements]);
  return { deleted: true, cancelled_games: ids.length, notices };
}

const NOW_SQL = "strftime('%Y-%m-%dT%H:%M:%SZ', 'now')";

// ---------------------------------------------------------------
// Lugares
// ---------------------------------------------------------------

export interface Venue {
  id: string;
  name: string;
  address: string;
  maps_url: string;
  sports: number;
  courts: number;
}

export async function listVenues(db: Db): Promise<Venue[]> {
  const { results } = await db
    .prepare(
      `SELECT v.id, v.name, v.address, v.maps_url,
              (SELECT count(*) FROM sports s WHERE s.venue_id = v.id AND s.deleted_at IS NULL) AS sports,
              (SELECT count(*) FROM courts c WHERE c.venue_id = v.id AND c.deleted_at IS NULL) AS courts
       FROM venues v WHERE v.deleted_at IS NULL ORDER BY v.name, v.id`,
    )
    .all<Venue>();
  return results;
}

export async function getVenue(db: Db, id: string): Promise<Venue> {
  const v = (await listVenues(db)).find((x) => x.id === id);
  if (!v) throw new ConfigError("no_existe", "Ese lugar ya no existe.");
  return v;
}

function validateVenue(input: Record<string, unknown>) {
  return {
    name: requiredText(input.name, 80, "name", "el nombre del lugar"),
    address: optionalText(input.address, 160, "address"),
    maps_url: optionalUrl(input.maps_url, "maps_url"),
  };
}

export async function createVenue(db: Db, input: Record<string, unknown>): Promise<Venue> {
  const v = validateVenue(input);
  const id = newId("L");
  await db.prepare("INSERT INTO venues (id, name, address, maps_url) VALUES (?, ?, ?, ?)")
    .bind(id, v.name, v.address, v.maps_url).run();
  return getVenue(db, id);
}

export async function updateVenue(db: Db, id: string, input: Record<string, unknown>): Promise<Venue> {
  const v = validateVenue(input);
  const r = await db
    .prepare("UPDATE venues SET name = ?, address = ?, maps_url = ? WHERE id = ? AND deleted_at IS NULL")
    .bind(v.name, v.address, v.maps_url, id)
    .run();
  if (r.meta.changes === 0) throw new ConfigError("no_existe", "Ese lugar ya no existe.");
  return getVenue(db, id);
}

export async function deleteVenue(db: Db, id: string, confirm: boolean, now: LocalNow): Promise<DeleteResult> {
  await getVenue(db, id);
  const affected = await futureGames(db, "g.venue_id = ?", [id], now);
  return deleteWith(db, affected, confirm, [
    db.prepare(`UPDATE courts SET deleted_at = ${NOW_SQL} WHERE venue_id = ? AND deleted_at IS NULL`).bind(id),
    db.prepare(`UPDATE sports SET deleted_at = ${NOW_SQL} WHERE venue_id = ? AND deleted_at IS NULL`).bind(id),
    db.prepare(`UPDATE venues SET deleted_at = ${NOW_SQL} WHERE id = ?`).bind(id),
  ]);
}

// ---------------------------------------------------------------
// Deportes y categorías
// ---------------------------------------------------------------

export interface Sport {
  id: string;
  venue_id: string;
  name: string;
  match_sizes: number[];
  /** Textos de las categorías por nivel: índice 0 = nivel 1. Vacío = sin categoría. */
  categories: string[];
  /** Textos en inglés de las categorías (opcionales): índice 0 = nivel 1. */
  categories_en: string[];
  courts: number;
  /** Canchas operativas: sin ninguna, el deporte no aparece en el sitio aunque esté visible. */
  active_courts: number;
  /** Lo decide el administrador: si se ofrece a los jugadores. */
  visible: boolean;
  /** Orden en el selector (0 a 999): menor primero; con el mismo número, alfabético. */
  sort_order: number;
}

export async function listSports(db: Db, venueId: string): Promise<Sport[]> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.venue_id, s.name, s.match_sizes, s.visible, s.sort_order,
              (SELECT count(*) FROM courts c WHERE c.sport_id = s.id AND c.deleted_at IS NULL) AS courts,
              (SELECT count(*) FROM courts c
               WHERE c.sport_id = s.id AND c.deleted_at IS NULL AND c.status = 'operativa') AS active_courts
       FROM sports s WHERE s.venue_id = ? AND s.deleted_at IS NULL ORDER BY s.sort_order, s.name COLLATE NOCASE, s.id`,
    )
    .bind(venueId)
    .all<{ id: string; venue_id: string; name: string; match_sizes: string; visible: number; sort_order: number; courts: number; active_courts: number }>();
  if (results.length === 0) return [];
  const { results: cats } = await db
    .prepare(
      `SELECT sport_id, level, label, label_en FROM categories
       WHERE sport_id IN (${placeholders(results.length)}) ORDER BY level`,
    )
    .bind(...results.map((s) => s.id))
    .all<{ sport_id: string; level: number; label: string; label_en: string | null }>();
  return results.map((s) => {
    const labels = ["", "", "", "", ""];
    const labelsEn = ["", "", "", "", ""];
    for (const c of cats) {
      if (c.sport_id !== s.id) continue;
      labels[c.level - 1] = c.label;
      labelsEn[c.level - 1] = c.label_en ?? "";
    }
    return {
      ...s,
      visible: s.visible === 1,
      match_sizes: parseIntList(s.match_sizes, 2, 4),
      categories: labels,
      categories_en: labelsEn,
    };
  });
}

export async function getSport(db: Db, id: string): Promise<Sport> {
  const row = await db
    .prepare("SELECT venue_id FROM sports WHERE id = ? AND deleted_at IS NULL")
    .bind(id)
    .first<{ venue_id: string }>();
  const s = row ? (await listSports(db, row.venue_id)).find((x) => x.id === id) : undefined;
  if (!s) throw new ConfigError("no_existe", "Ese deporte ya no existe.");
  return s;
}

function validateSport(input: Record<string, unknown>) {
  const name = requiredText(input.name, 40, "name", "el nombre del deporte");
  const sizesIn = Array.isArray(input.match_sizes) ? input.match_sizes.map(Number) : [];
  const sizes = [...new Set(sizesIn)].sort((a, b) => a - b);
  if (sizes.length === 0 || sizes.some((n) => n !== 2 && n !== 4)) {
    throw invalid("Elige cuántos jugadores puede tener un partido (2, 4 o ambos).", "match_sizes");
  }
  const raw = Array.isArray(input.categories) ? input.categories : [];
  if (raw.length > 5) throw invalid("Máximo 5 categorías.", "categories");
  const categories = Array.from({ length: 5 }, (_, i) => optionalText(raw[i], 60, `categories.${i + 1}`));
  if (!categories.some((c) => c)) throw invalid("Define al menos una categoría.", "categories");
  // Texto en inglés: opcional y solo para niveles que tienen texto en español.
  const rawEn = Array.isArray(input.categories_en) ? input.categories_en : [];
  const categoriesEn = Array.from({ length: 5 }, (_, i) =>
    categories[i] ? optionalText(rawEn[i], 60, `categories_en.${i + 1}`) : "",
  );
  // Sin el campo: visible al crear y sin cambios al editar.
  const visible = typeof input.visible === "boolean" ? (input.visible ? 1 : 0) : null;
  // Orden en el selector: entero de 0 a 999. Sin el campo: 0 al crear y sin cambios al editar.
  let sortOrder: number | null = null;
  if (input.sort_order !== undefined && input.sort_order !== null && input.sort_order !== "") {
    const n = Number(input.sort_order);
    if (!Number.isInteger(n) || n < 0 || n > 999) throw invalid("El orden debe ser un número entero entre 0 y 999.", "sort_order");
    sortOrder = n;
  }
  return { name, match_sizes: sizes.join(","), categories, categoriesEn, visible, sortOrder };
}

function categoryStatements(db: Db, sportId: string, categories: string[], categoriesEn: string[]): DbStatement[] {
  return categories.flatMap((label, i) =>
    label
      ? [
          db
            .prepare("INSERT INTO categories (sport_id, level, label, label_en) VALUES (?, ?, ?, ?)")
            .bind(sportId, i + 1, label, categoriesEn[i] || null),
        ]
      : [],
  );
}

export async function createSport(db: Db, venueId: string, input: Record<string, unknown>): Promise<Sport> {
  await getVenue(db, venueId);
  const s = validateSport(input);
  const id = newId("D");
  await db.batch([
    db.prepare("INSERT INTO sports (id, venue_id, name, match_sizes, visible, sort_order) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, venueId, s.name, s.match_sizes, s.visible ?? 1, s.sortOrder ?? 0),
    ...categoryStatements(db, id, s.categories, s.categoriesEn),
  ]);
  return getSport(db, id);
}

export async function updateSport(db: Db, id: string, input: Record<string, unknown>): Promise<Sport> {
  await getSport(db, id);
  const s = validateSport(input);
  await db.batch([
    db.prepare("UPDATE sports SET name = ?, match_sizes = ?, visible = COALESCE(?, visible), sort_order = COALESCE(?, sort_order) WHERE id = ?")
      .bind(s.name, s.match_sizes, s.visible, s.sortOrder, id),
    db.prepare("DELETE FROM categories WHERE sport_id = ?").bind(id),
    ...categoryStatements(db, id, s.categories, s.categoriesEn),
  ]);
  return getSport(db, id);
}

export async function deleteSport(db: Db, id: string, confirm: boolean, now: LocalNow): Promise<DeleteResult> {
  await getSport(db, id);
  const affected = await futureGames(db, "g.sport_id = ?", [id], now);
  return deleteWith(db, affected, confirm, [
    db.prepare(`UPDATE courts SET deleted_at = ${NOW_SQL} WHERE sport_id = ? AND deleted_at IS NULL`).bind(id),
    db.prepare(`UPDATE sports SET deleted_at = ${NOW_SQL} WHERE id = ?`).bind(id),
  ]);
}

// ---------------------------------------------------------------
// Canchas
// ---------------------------------------------------------------

export const SURFACES = ["Arcilla", "Carpeta sintética", "Césped sintético", "Cemento", "Césped natural", "Otra"];
const STATUSES = ["operativa", "mantencion", "cerrada"] as const;

export interface CourtDetail extends Court {
  sport_id: string;
  venue_id: string;
  surface: string;
  notes: string;
  maps_url: string;
  lat: number | null;
  lng: number | null;
}

const COURT_DETAIL = `id, sport_id, venue_id, name, surface, status, notes, maps_url, lat, lng,
  open_time, close_time, slot_minutes, days, available_from, available_to`;

export async function listCourts(db: Db, sportId: string): Promise<CourtDetail[]> {
  const { results } = await db
    .prepare(`SELECT ${COURT_DETAIL} FROM courts WHERE sport_id = ? AND deleted_at IS NULL ORDER BY name, id`)
    .bind(sportId)
    .all<CourtDetail>();
  return results;
}

export async function getCourt(db: Db, id: string): Promise<CourtDetail> {
  const c = await db
    .prepare(`SELECT ${COURT_DETAIL} FROM courts WHERE id = ? AND deleted_at IS NULL`)
    .bind(id)
    .first<CourtDetail>();
  if (!c) throw new ConfigError("no_existe", "Esa cancha ya no existe.");
  return c;
}

function optionalNumber(v: unknown, min: number, max: number, field: string): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = Number(v);
  if (!Number.isFinite(n) || n < min || n > max) throw invalid("Coordenada fuera de rango.", field);
  return n;
}

function validateCourt(input: Record<string, unknown>) {
  const name = requiredText(input.name, 60, "name", "el nombre de la cancha");
  const surface = optionalText(input.surface, 40, "surface");
  const status = String(input.status ?? "operativa");
  if (!(STATUSES as readonly string[]).includes(status)) throw invalid("Elige un estado válido.", "status");
  const notes = optionalText(input.notes, 300, "notes");
  const maps_url = optionalUrl(input.maps_url, "maps_url");
  const lat = optionalNumber(input.lat, -90, 90, "lat");
  const lng = optionalNumber(input.lng, -180, 180, "lng");

  const { open_time, close_time } = input;
  if (!isTime(open_time) || !isTime(close_time) || toMinutes(close_time) <= toMinutes(open_time)) {
    throw invalid("La hora de cierre debe ser posterior a la de apertura.", "close_time");
  }
  const slot = Number(input.slot_minutes);
  if (![60, 90, 120].includes(slot)) throw invalid("Elige una duración de turno válida.", "slot_minutes");
  if (toMinutes(open_time) + slot > toMinutes(close_time)) {
    throw invalid("Entre apertura y cierre no cabe ni un turno.", "slot_minutes");
  }

  const daysIn = Array.isArray(input.days) ? input.days.map(Number) : [];
  const days = [...new Set(daysIn)].filter((d) => Number.isInteger(d) && d >= 0 && d <= 6).sort((a, b) => a - b);
  if (days.length === 0 || days.length !== new Set(daysIn).size) {
    throw invalid("Marca al menos un día de operación.", "days");
  }

  const from = input.available_from ? String(input.available_from) : null;
  const to = input.available_to ? String(input.available_to) : null;
  if ((from && !isDate(from)) || (to && !isDate(to))) throw invalid("Revisa las fechas.", "available_from");
  if (from && to && to < from) throw invalid("La fecha final está antes de la inicial.", "available_to");

  return {
    name, surface, status: status as Court["status"], notes, maps_url, lat, lng,
    open_time, close_time, slot_minutes: slot, days: days.join(","),
    available_from: from, available_to: to,
  };
}

export async function createCourt(db: Db, sportId: string, input: Record<string, unknown>): Promise<CourtDetail> {
  const sport = await getSport(db, sportId);
  const c = validateCourt(input);
  const id = newId("C");
  await db
    .prepare(
      `INSERT INTO courts (id, sport_id, venue_id, name, surface, status, notes, maps_url, lat, lng,
                           open_time, close_time, slot_minutes, days, available_from, available_to)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(
      id, sport.id, sport.venue_id, c.name, c.surface, c.status, c.notes, c.maps_url, c.lat, c.lng,
      c.open_time, c.close_time, c.slot_minutes, c.days, c.available_from, c.available_to,
    )
    .run();
  return getCourt(db, id);
}

/**
 * Edita una cancha. Se bloquea si el cambio deja fuera algún encuentro futuro
 * confirmado en ella (horario, duración, días, fechas o estado): el
 * administrador debe cancelar esos encuentros primero.
 */
export async function updateCourt(
  db: Db,
  id: string,
  input: Record<string, unknown>,
  now: LocalNow,
): Promise<CourtDetail> {
  const current = await getCourt(db, id);
  const c = validateCourt(input);
  const next: Court = { ...current, ...c };
  const confirmed = await futureGames(db, "g.court_id = ? AND g.status = 'confirmado'", [id], now);
  const broken = confirmed.filter((g) => !courtHasSlot(next, g.date, g.time));
  if (broken.length > 0) {
    throw new ConfigError(
      "afecta_encuentros",
      broken.length === 1
        ? "Ese cambio deja fuera 1 encuentro confirmado. Cancélalo primero."
        : `Ese cambio deja fuera ${broken.length} encuentros confirmados. Cancélalos primero.`,
      undefined,
      broken,
    );
  }
  await db
    .prepare(
      `UPDATE courts SET name = ?, surface = ?, status = ?, notes = ?, maps_url = ?, lat = ?, lng = ?,
         open_time = ?, close_time = ?, slot_minutes = ?, days = ?, available_from = ?, available_to = ?
       WHERE id = ?`,
    )
    .bind(
      c.name, c.surface, c.status, c.notes, c.maps_url, c.lat, c.lng,
      c.open_time, c.close_time, c.slot_minutes, c.days, c.available_from, c.available_to, id,
    )
    .run();
  return getCourt(db, id);
}

export async function deleteCourt(db: Db, id: string, confirm: boolean, now: LocalNow): Promise<DeleteResult> {
  await getCourt(db, id);
  // Solo los confirmados tienen cancha; los abiertos no dependen de una cancha en particular.
  const affected = await futureGames(db, "g.court_id = ?", [id], now);
  return deleteWith(db, affected, confirm, [
    db.prepare(`UPDATE courts SET deleted_at = ${NOW_SQL} WHERE id = ?`).bind(id),
  ]);
}

// ---------------------------------------------------------------
// Bloqueos de canchas
// ---------------------------------------------------------------

export interface CourtBlock {
  id: string;
  court_id: string;
  date: string;
  start_time: string;
  end_time: string;
  reason: string;
}

/** Bloqueos de una cancha desde hoy, en orden. */
export async function listBlocks(db: Db, courtId: string, now: LocalNow): Promise<CourtBlock[]> {
  await getCourt(db, courtId);
  const { results } = await db
    .prepare(
      `SELECT id, court_id, date, start_time, end_time, reason FROM court_blocks
       WHERE court_id = ? AND date >= ? ORDER BY date, start_time, id`,
    )
    .bind(courtId, now.date)
    .all<CourtBlock>();
  return results;
}

function validateBlock(input: Record<string, unknown>, now: LocalNow) {
  const { date, start_time, end_time } = input;
  if (!isDate(date)) throw invalid("Elige la fecha del bloqueo.", "date");
  if (date < now.date) throw invalid("La fecha ya pasó.", "date");
  if (!isTime(start_time) || !isTime(end_time) || toMinutes(end_time) <= toMinutes(start_time)) {
    throw invalid("La hora final debe ser posterior a la inicial.", "end_time");
  }
  const reason = optionalText(input.reason, 200, "reason");
  return { date, start_time, end_time, reason };
}

export type CreateBlockResult =
  | { created: false; needs_confirmation: true; games: GameRef[] }
  | { created: true; block: CourtBlock; cancelled_games: number; notices: PendingNotice[] };

/**
 * Bloquea una cancha en una fecha y rango de horas. Si ya hay encuentros
 * confirmados en esa cancha cuyo turno se cruza con el bloqueo, pide
 * confirmación; al confirmar, esos encuentros se cancelan y se avisa.
 */
export async function createBlock(
  db: Db,
  courtId: string,
  input: Record<string, unknown>,
  confirm: boolean,
  now: LocalNow,
): Promise<CreateBlockResult> {
  const court = await getCourt(db, courtId);
  const b = validateBlock(input, now);
  const sameDay = await futureGames(db, "g.court_id = ? AND g.status = 'confirmado' AND g.date = ?", [courtId, b.date], now);
  const affected = sameDay.filter((g) =>
    blockCoversSlot({ court_id: courtId, ...b }, g.date, g.time, court.slot_minutes),
  );
  if (affected.length > 0 && !confirm) return { created: false, needs_confirmation: true, games: affected };

  const ids = affected.map((g) => g.id);
  const notices = await cancelNotices(db, ids, "bloqueo");
  const id = newId("B");
  await db.batch([
    ...cancelGamesStmt(db, ids),
    db
      .prepare("INSERT INTO court_blocks (id, court_id, date, start_time, end_time, reason) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(id, courtId, b.date, b.start_time, b.end_time, b.reason),
  ]);
  return {
    created: true,
    block: { id, court_id: courtId, ...b },
    cancelled_games: ids.length,
    notices,
  };
}

export async function deleteBlock(db: Db, id: string): Promise<void> {
  const r = await db.prepare("DELETE FROM court_blocks WHERE id = ?").bind(id).run();
  if (r.meta.changes === 0) throw new ConfigError("no_existe", "Ese bloqueo ya no existe.");
}

// ---------------------------------------------------------------
// Encuentros
// ---------------------------------------------------------------

export interface AdminGame {
  id: string;
  date: string;
  time: string;
  status: string;
  capacity: number;
  accepted_levels: number[];
  venue_name: string;
  sport_name: string;
  court_name: string | null;
  players: { initials: string; level: number; email: string; whatsapp: string | null }[];
}

/** Encuentros desde una fecha (por defecto, hoy), incluidos los cancelados. */
export async function listGames(db: Db, now: LocalNow, from?: unknown): Promise<AdminGame[]> {
  const since = isDate(from) ? from : now.date;
  const { results } = await db
    .prepare(
      `SELECT g.id, g.date, g.time, g.status, g.capacity, g.accepted_levels,
              v.name AS venue_name, s.name AS sport_name, c.name AS court_name
       FROM games g
       JOIN venues v ON v.id = g.venue_id
       JOIN sports s ON s.id = g.sport_id
       LEFT JOIN courts c ON c.id = g.court_id
       WHERE g.date >= ?
       ORDER BY g.date, g.time, g.rowid
       LIMIT 500`,
    )
    .bind(since)
    .all<Omit<AdminGame, "players" | "accepted_levels"> & { accepted_levels: string }>();
  if (results.length === 0) return [];
  const { results: players } = await db
    .prepare(
      `SELECT game_id, initials, level, email, whatsapp FROM players
       WHERE game_id IN (${placeholders(results.length)}) ORDER BY rowid`,
    )
    .bind(...results.map((g) => g.id))
    .all<{ game_id: string; initials: string; level: number; email: string; whatsapp: string | null }>();
  return results.map((g) => ({
    ...g,
    accepted_levels: parseIntList(g.accepted_levels, 1, 5),
    players: players
      .filter((p) => p.game_id === g.id)
      .map(({ initials, level, email, whatsapp }) => ({ initials, level, email, whatsapp })),
  }));
}

// ---------------------------------------------------------------
// Eliminar todos los partidos (2026-11-15)
// ---------------------------------------------------------------

/** Palabra que el administrador escribe para confirmar (segunda confirmación). */
export const DELETE_ALL_WORD = "ELIMINAR";

export interface DeleteAllPlan {
  /** Partidos que se borrarán: todos, de todos los lugares y deportes, pasados, futuros y cancelados. */
  games: number;
  players: number;
  /** Avisos "encuentro cancelado" para los partidos de hoy en adelante que no estaban cancelados. */
  notices: PendingNotice[];
}

/** Cuenta lo que se borrará y prepara los avisos (antes de borrar, mientras los datos existen). */
export async function planDeleteAllGames(db: Db, now: LocalNow, confirm: unknown): Promise<DeleteAllPlan> {
  if (typeof confirm !== "string" || confirm.trim().toUpperCase() !== DELETE_ALL_WORD) {
    throw invalid(`Escribe ${DELETE_ALL_WORD} para confirmar.`, "confirm");
  }
  const counts = await db
    .prepare("SELECT (SELECT count(*) FROM games) AS games, (SELECT count(*) FROM players) AS players")
    .first<{ games: number; players: number }>();
  const { results } = await db
    .prepare("SELECT id FROM games WHERE status <> 'cancelado' AND date >= ? ORDER BY date, time, rowid")
    .bind(now.date)
    .all<{ id: string }>();
  return { games: counts?.games ?? 0, players: counts?.players ?? 0, notices: await cancelNotices(db, results.map((r) => r.id)) };
}

/** Borra todos los partidos y sus cupos, en una sola operación. Lugares, deportes, canchas y bloqueos no cambian. */
export async function deleteAllGames(db: Db): Promise<void> {
  await db.batch([db.prepare("DELETE FROM players"), db.prepare("DELETE FROM games")]);
}

/** Cancela un encuentro: pasa a 'cancelado' (se conserva) y se avisa a sus jugadores. */
export async function cancelGame(db: Db, id: string): Promise<PendingNotice[]> {
  const g = await db.prepare("SELECT status FROM games WHERE id = ?").bind(id).first<{ status: string }>();
  if (!g) throw new ConfigError("no_existe", "Ese encuentro ya no existe.");
  if (g.status === "cancelado") return [];
  const notices = await cancelNotices(db, [id]);
  await db.batch(cancelGamesStmt(db, [id]));
  return notices;
}
