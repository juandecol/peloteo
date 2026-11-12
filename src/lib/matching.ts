// Emparejamiento: abrir partido, unirse, cancelar un cupo y buscar jugadores.
//
// La cancha no se retiene al abrir: un encuentro abierto no tiene cancha y se le
// asigna la primera libre del turno al completarse. Si ya no queda, pasa a
// 'sin_cancha'.
//
// Concurrencia: cada escritura se hace en un solo db.batch(), que D1 ejecuta como
// una transacción. Las sentencias verifican en SQL que quede cancha libre o que
// el encuentro tenga cupo, y el índice único (court_id, date, time) sobre los
// encuentros confirmados es la última defensa contra la doble reserva.

import {
  courtHasSlot,
  GAME_COLUMNS,
  loadCourts,
  parseIntList,
  toPublicGames,
  type GameRow,
  type PublicGame,
} from "./availability.ts";
import type { PendingNotice } from "./notify.ts";
import { isUniqueViolation, newId, newToken, placeholders, type Db, type DbStatement } from "./db.ts";
import {
  hasNotStarted,
  isDate,
  isDateBookable,
  isSlotOpen,
  isTime,
  lastBookableDate,
  type LocalNow,
} from "./time.ts";

// ---------------------------------------------------------------
// Errores y eventos
// ---------------------------------------------------------------

export type MatchErrorCode =
  | "datos_invalidos"
  | "deporte_no_existe"
  | "turno_invalido"
  | "turno_cerrado"
  | "turno_ocupado"
  | "encuentro_no_existe"
  | "encuentro_completo"
  | "encuentro_cancelado"
  | "nivel_no_aceptado"
  | "ya_inscrito"
  | "cupo_no_existe"
  | "cancelacion_cerrada";

export class MatchError extends Error {
  readonly code: MatchErrorCode;
  readonly field?: string;
  constructor(code: MatchErrorCode, message: string, field?: string) {
    super(message);
    this.name = "MatchError";
    this.code = code;
    this.field = field;
  }
}

export type { PendingNotice } from "./notify.ts";

// ---------------------------------------------------------------
// Validación de los datos del jugador
// ---------------------------------------------------------------

export interface PlayerInput {
  initials: unknown;
  level: unknown;
  email: unknown;
  whatsapp?: unknown;
  whatsapp_opt_in?: unknown;
}

export interface ValidPlayer {
  initials: string;
  level: number;
  email: string;
  whatsapp: string | null;
  whatsapp_opt_in: 0 | 1;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Valida y normaliza los datos del formulario. Lanza MatchError si algo no sirve. */
export function validatePlayer(input: PlayerInput, allowedLevels: number[]): ValidPlayer {
  const rawIni = typeof input.initials === "string" ? input.initials : "";
  const initials = rawIni.toUpperCase().replace(/[^\p{L}]/gu, "");
  if (initials.length < 2 || initials.length > 4) {
    throw new MatchError("datos_invalidos", "Escribe tus iniciales (2 a 4 letras).", "initials");
  }

  const level = Number(input.level);
  if (!Number.isInteger(level) || !allowedLevels.includes(level)) {
    throw new MatchError("datos_invalidos", "Elige tu nivel de juego.", "level");
  }

  const email = typeof input.email === "string" ? input.email.trim().toLowerCase() : "";
  if (email.length > 254 || !EMAIL_RE.test(email)) {
    throw new MatchError("datos_invalidos", "Revisa el email: lo usamos para avisarte.", "email");
  }

  let whatsapp: string | null = null;
  const rawWa = typeof input.whatsapp === "string" ? input.whatsapp.trim() : "";
  if (rawWa) {
    const digits = rawWa.replace(/\D/g, "");
    if (digits.length < 8 || digits.length > 15) {
      throw new MatchError(
        "datos_invalidos",
        "Revisa el número de WhatsApp o déjalo en blanco.",
        "whatsapp",
      );
    }
    whatsapp = "+" + digits;
  }

  const optIn = whatsapp !== null && (input.whatsapp_opt_in === true || input.whatsapp_opt_in === 1);
  return { initials, level, email, whatsapp, whatsapp_opt_in: optIn ? 1 : 0 };
}

/** Cantidad de jugadores elegida: debe ser una de las permitidas por el deporte. */
export function validateCapacity(input: unknown, sizes: number[]): number {
  if ((input === undefined || input === null || input === "") && sizes.length === 1) return sizes[0]!;
  const n = Number(input);
  if (!Number.isInteger(n) || !sizes.includes(n)) {
    throw new MatchError("datos_invalidos", "Elige cuántos jugadores serán.", "capacity");
  }
  return n;
}

/** Niveles aceptados: al menos uno, entre las categorías del deporte e incluido el propio. */
export function validateAcceptedLevels(input: unknown, sportLevels: number[], ownLevel: number): number[] {
  const list = Array.isArray(input) ? input.map(Number) : [];
  if (list.some((n) => !Number.isInteger(n) || !sportLevels.includes(n))) {
    throw new MatchError("datos_invalidos", "Elige niveles de la lista.", "accepted_levels");
  }
  const levels = [...new Set(list)].sort((a, b) => a - b);
  if (levels.length === 0) {
    throw new MatchError("datos_invalidos", "Elige qué niveles aceptas.", "accepted_levels");
  }
  if (!levels.includes(ownLevel)) {
    throw new MatchError("datos_invalidos", "Incluye tu propio nivel entre los aceptados.", "accepted_levels");
  }
  return levels;
}

function levelsText(levels: number[]): string {
  if (levels.length === 1) return "nivel " + levels[0];
  return "niveles " + levels.slice(0, -1).join(", ") + " y " + levels.at(-1);
}

// ---------------------------------------------------------------
// Consultas de apoyo
// ---------------------------------------------------------------

interface SportRow {
  id: string;
  venue_id: string;
  match_sizes: string;
}

async function loadSport(db: Db, sportId: string): Promise<SportRow> {
  const sport = await db
    .prepare("SELECT id, venue_id, match_sizes FROM sports WHERE id = ? AND deleted_at IS NULL")
    .bind(sportId)
    .first<SportRow>();
  if (!sport) throw new MatchError("deporte_no_existe", "Ese deporte ya no está disponible.");
  return sport;
}

/** Niveles con categoría definida para un deporte. */
export async function loadLevels(db: Db, sportId: string): Promise<number[]> {
  const { results } = await db
    .prepare("SELECT level FROM categories WHERE sport_id = ? ORDER BY level")
    .bind(sportId)
    .all<{ level: number }>();
  return results.map((r) => r.level);
}

interface FullGameRow {
  id: string;
  sport_id: string;
  date: string;
  time: string;
  capacity: number;
  accepted_levels: string;
  status: "abierto" | "sin_cancha" | "confirmado" | "cancelado";
}

async function loadGame(db: Db, gameId: string): Promise<FullGameRow | null> {
  return db
    .prepare(
      "SELECT id, sport_id, date, time, capacity, accepted_levels, status FROM games WHERE id = ?",
    )
    .bind(gameId)
    .first<FullGameRow>();
}

async function playerIds(db: Db, gameId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT id FROM players WHERE game_id = ? ORDER BY rowid")
    .bind(gameId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

async function publicGame(db: Db, gameId: string, visitorId: string): Promise<PublicGame> {
  const row = await db
    .prepare(`SELECT ${GAME_COLUMNS} FROM games WHERE id = ? AND status <> 'cancelado'`)
    .bind(gameId)
    .first<GameRow>();
  if (!row) throw new MatchError("encuentro_no_existe", "Ese partido ya no existe.");
  const [game] = await toPublicGames(db, [row], visitorId);
  return game!;
}

/** IDs de las canchas del deporte que generan ese turno, en orden de asignación. */
async function slotCourtIds(db: Db, sportId: string, date: string, time: string): Promise<string[]> {
  return (await loadCourts(db, sportId)).filter((c) => courtHasSlot(c, date, time)).map((c) => c.id);
}

/**
 * Subconsulta SQL que devuelve la primera cancha libre (sin encuentro confirmado)
 * entre las indicadas, para la fecha y hora dadas. Devuelve [sql, parámetros].
 */
function firstFreeCourtSql(courtIds: string[], date: string, time: string): [string, unknown[]] {
  if (courtIds.length === 0) return ["(SELECT NULL)", []];
  return [
    `(SELECT c.id FROM courts c
      WHERE c.id IN (${placeholders(courtIds.length)})
        AND NOT EXISTS (
          SELECT 1 FROM games g
          WHERE g.court_id = c.id AND g.date = ? AND g.time = ? AND g.status = 'confirmado')
      ORDER BY c.name, c.id
      LIMIT 1)`,
    [...courtIds, date, time],
  ];
}

function insertPlayer(
  db: Db,
  condition: string,
  conditionParams: unknown[],
  id: string,
  gameId: string,
  visitorId: string,
  p: ValidPlayer,
  token: string,
): DbStatement {
  return db
    .prepare(
      `INSERT INTO players
         (id, game_id, visitor_id, initials, level, email, whatsapp, whatsapp_opt_in, cancel_token)
       SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${condition}`,
    )
    .bind(
      id, gameId, visitorId, p.initials, p.level, p.email, p.whatsapp, p.whatsapp_opt_in, token,
      ...conditionParams,
    );
}

const PLAYER_COUNT = "(SELECT count(*) FROM players p WHERE p.game_id = games.id)";

export interface JoinResult {
  game: PublicGame;
  player_id: string;
  cancel_token: string;
  notices: PendingNotice[];
}

// ---------------------------------------------------------------
// Abrir partido
// ---------------------------------------------------------------

export interface CreateGameInput {
  sport_id: unknown;
  date: unknown;
  time: unknown;
  capacity?: unknown;
  accepted_levels: unknown;
  player: PlayerInput;
}

/**
 * Abre un partido sin cancha asignada. Solo se permite si en ese momento queda
 * al menos una cancha libre en el turno; si no, lanza turno_ocupado.
 */
export async function createGame(
  db: Db,
  input: CreateGameInput,
  visitorId: string,
  now: LocalNow,
): Promise<JoinResult> {
  const sportId = typeof input.sport_id === "string" ? input.sport_id : "";
  const sport = await loadSport(db, sportId);
  const sportLevels = await loadLevels(db, sport.id);
  const player = validatePlayer(input.player, sportLevels);
  const capacity = validateCapacity(input.capacity, parseIntList(sport.match_sizes, 2, 4));
  const accepted = validateAcceptedLevels(input.accepted_levels, sportLevels, player.level);

  const { date, time } = input;
  if (!isDate(date) || !isTime(time)) {
    throw new MatchError("datos_invalidos", "Elige un día y una hora.", "date");
  }
  if (!isDateBookable(date, now)) {
    throw new MatchError("turno_cerrado", `Solo se puede agendar hasta el ${lastBookableDate(now)}.`);
  }
  if (!isSlotOpen(date, time, now)) {
    throw new MatchError("turno_cerrado", "Esa hora ya pasó. Elige otra.");
  }

  const courtIds = await slotCourtIds(db, sport.id, date, time);
  if (courtIds.length === 0) {
    throw new MatchError("turno_invalido", "No hay canchas para esa hora. Elige otra.");
  }
  const [freeSql, freeParams] = firstFreeCourtSql(courtIds, date, time);

  // Reintenta solo si chocó un ID generado (muy improbable).
  for (let attempt = 0; attempt < 3; attempt++) {
    const gameId = newId("E");
    const playerId = newId("J");
    const token = newToken();
    try {
      const [gameRes] = await db.batch([
        db
          .prepare(
            `INSERT INTO games
               (id, venue_id, sport_id, court_id, date, time, capacity, accepted_levels, status)
             SELECT ?, ?, ?, NULL, ?, ?, ?, ?, 'abierto'
             WHERE ${freeSql} IS NOT NULL`,
          )
          .bind(gameId, sport.venue_id, sport.id, date, time, capacity, accepted.join(","), ...freeParams),
        insertPlayer(db, "EXISTS (SELECT 1 FROM games WHERE id = ?)", [gameId], playerId, gameId, visitorId, player, token),
      ]);
      if (!gameRes || gameRes.meta.changes === 0) {
        throw new MatchError("turno_ocupado", "Ya no quedan canchas libres a esa hora. Elige otra.");
      }
      return {
        game: await publicGame(db, gameId, visitorId),
        player_id: playerId,
        cancel_token: token,
        notices: [{ event: "partido_publicado", game_id: gameId, player_ids: [playerId] }],
      };
    } catch (err) {
      if (err instanceof MatchError || !isUniqueViolation(err)) throw err;
      // Chocó un ID: se reintenta con otro.
    }
  }
  throw new Error("No se pudo generar un ID único para el encuentro");
}

// ---------------------------------------------------------------
// Unirse
// ---------------------------------------------------------------

/**
 * Suma un jugador a un encuentro abierto. Al completarse la capacidad, en la
 * misma transacción se asigna la primera cancha libre y el encuentro pasa a
 * `confirmado`; si no queda cancha, pasa a `sin_cancha`.
 */
export async function joinGame(
  db: Db,
  gameId: string,
  input: PlayerInput,
  visitorId: string,
  now: LocalNow,
): Promise<JoinResult> {
  const game = await loadGame(db, gameId);
  if (!game) throw new MatchError("encuentro_no_existe", "Ese partido ya no existe.");
  if (game.status === "cancelado") {
    throw new MatchError("encuentro_cancelado", "Ese partido fue cancelado.");
  }
  if (!isSlotOpen(game.date, game.time, now)) {
    throw new MatchError("turno_cerrado", "Ese partido ya comenzó.");
  }
  const player = validatePlayer(input, await loadLevels(db, game.sport_id));
  const accepted = parseIntList(game.accepted_levels, 1, 5);
  if (!accepted.includes(player.level)) {
    throw new MatchError(
      "nivel_no_aceptado",
      `Este partido busca jugadores de ${levelsText(accepted)}.`,
      "level",
    );
  }

  const member = await db
    .prepare("SELECT 1 AS x FROM players WHERE game_id = ? AND visitor_id = ?")
    .bind(gameId, visitorId)
    .first();
  if (member) throw new MatchError("ya_inscrito", "Ya estás en ese partido.");

  const courtIds = await slotCourtIds(db, game.sport_id, game.date, game.time);
  const [freeSql, freeParams] = firstFreeCourtSql(courtIds, game.date, game.time);

  const playerId = newId("J");
  const token = newToken();
  let inserted: number;
  try {
    const [ins] = await db.batch([
      insertPlayer(
        db,
        `EXISTS (SELECT 1 FROM games WHERE id = ? AND status = 'abierto' AND ${PLAYER_COUNT} < capacity)`,
        [gameId],
        playerId, gameId, visitorId, player, token,
      ),
      // Completo y con cancha libre: se confirma con la primera cancha libre.
      db
        .prepare(
          `UPDATE games SET status = 'confirmado', court_id = ${freeSql}
           WHERE id = ? AND status = 'abierto' AND ${PLAYER_COUNT} >= capacity
             AND ${freeSql} IS NOT NULL`,
        )
        .bind(...freeParams, gameId, ...freeParams),
      // Completo y sin cancha libre: no se confirma.
      db
        .prepare(
          `UPDATE games SET status = 'sin_cancha'
           WHERE id = ? AND status = 'abierto' AND ${PLAYER_COUNT} >= capacity`,
        )
        .bind(gameId),
    ]);
    inserted = ins?.meta.changes ?? 0;
  } catch (err) {
    if (isUniqueViolation(err) && /players\.game_id/.test((err as Error).message)) {
      throw new MatchError("ya_inscrito", "Ya estás en ese partido.");
    }
    throw err;
  }
  if (inserted === 0) {
    throw new MatchError("encuentro_completo", "Ese partido se acaba de completar. Elige otro.");
  }

  const view = await publicGame(db, gameId, visitorId);
  const all = await playerIds(db, gameId);
  const notices: PendingNotice[] = [
    { event: "jugador_se_sumo", game_id: gameId, player_ids: all.filter((id) => id !== playerId) },
  ];
  if (view.status === "confirmado") {
    notices.push({ event: "partido_confirmado", game_id: gameId, player_ids: all });
  } else if (view.status === "sin_cancha") {
    notices.push({ event: "partido_sin_cancha", game_id: gameId, player_ids: all });
  }
  return { game: view, player_id: playerId, cancel_token: token, notices };
}

// ---------------------------------------------------------------
// Cancelar un cupo
// ---------------------------------------------------------------

export interface CancelResult {
  game_id: string;
  /** El encuentro quedó sin jugadores y se eliminó. */
  game_deleted: boolean;
  /** Estaba confirmado o sin cancha y volvió a abierto (sin cancha asignada). */
  reopened: boolean;
  notices: PendingNotice[];
}

interface PlayerRef {
  id: string;
  game_id: string;
}

async function cancelPlayer(db: Db, player: PlayerRef, now: LocalNow): Promise<CancelResult> {
  const game = await loadGame(db, player.game_id);
  if (!game) throw new MatchError("encuentro_no_existe", "Ese partido ya no existe.");
  if (game.status === "cancelado") {
    throw new MatchError("encuentro_cancelado", "Ese partido fue cancelado.");
  }
  if (!hasNotStarted(game.date, game.time, now)) {
    throw new MatchError("cancelacion_cerrada", "Ese partido ya comenzó; no se puede cancelar.");
  }

  const [del, gameDel, reopen] = await db.batch([
    db.prepare("DELETE FROM players WHERE id = ?").bind(player.id),
    db
      .prepare(
        "DELETE FROM games WHERE id = ? AND NOT EXISTS (SELECT 1 FROM players WHERE game_id = ?)",
      )
      .bind(game.id, game.id),
    // Vuelve a abierto y libera la cancha.
    db
      .prepare(
        `UPDATE games SET status = 'abierto', court_id = NULL
         WHERE id = ? AND status IN ('confirmado', 'sin_cancha') AND ${PLAYER_COUNT} < capacity`,
      )
      .bind(game.id),
  ]);
  if (!del || del.meta.changes === 0) {
    throw new MatchError("cupo_no_existe", "Ese cupo ya fue cancelado.");
  }

  const deleted = (gameDel?.meta.changes ?? 0) > 0;
  const reopened = (reopen?.meta.changes ?? 0) > 0;
  const notices: PendingNotice[] = [];
  if (reopened) {
    notices.push({ event: "cupo_cancelado", game_id: game.id, player_ids: await playerIds(db, game.id) });
  }
  return { game_id: game.id, game_deleted: deleted, reopened, notices };
}

/** Cancela el cupo del visitante en un encuentro ("Mis partidos"). */
export async function cancelByVisitor(
  db: Db,
  gameId: string,
  visitorId: string,
  now: LocalNow,
): Promise<CancelResult> {
  const player = await db
    .prepare("SELECT id, game_id FROM players WHERE game_id = ? AND visitor_id = ?")
    .bind(gameId, visitorId)
    .first<PlayerRef>();
  if (!player) throw new MatchError("cupo_no_existe", "No tienes un cupo en ese partido.");
  return cancelPlayer(db, player, now);
}

/** Cancela un cupo con el token del enlace enviado en los avisos. */
export async function cancelByToken(db: Db, token: string, now: LocalNow): Promise<CancelResult> {
  if (!/^[0-9a-f]{32}$/.test(token)) {
    throw new MatchError("cupo_no_existe", "El enlace de cancelación no es válido.");
  }
  const player = await db
    .prepare("SELECT id, game_id FROM players WHERE cancel_token = ?")
    .bind(token)
    .first<PlayerRef>();
  if (!player) throw new MatchError("cupo_no_existe", "Ese cupo ya fue cancelado.");
  return cancelPlayer(db, player, now);
}

// ---------------------------------------------------------------
// Búsqueda de jugadores
// ---------------------------------------------------------------

export interface SearchInput {
  sport_id: unknown;
  /** Nivel del jugador que busca. */
  level: unknown;
  date_from?: unknown;
  date_to?: unknown;
  time_from?: unknown;
  time_to?: unknown;
}

/**
 * Encuentros a los que el jugador puede unirse: abiertos, con cupo, en turno
 * vigente, que aceptan su nivel y en los que no está inscrito. Filtra por
 * deporte (dentro de un lugar) y por rangos de fechas y horas.
 */
export async function searchGames(
  db: Db,
  input: SearchInput,
  visitorId: string | null,
  now: LocalNow,
): Promise<PublicGame[]> {
  const sportId = typeof input.sport_id === "string" ? input.sport_id : "";
  await loadSport(db, sportId);

  const level = Number(input.level);
  if (!Number.isInteger(level) || level < 1 || level > 5) {
    throw new MatchError("datos_invalidos", "Elige tu nivel de juego.", "level");
  }

  const last = lastBookableDate(now);
  const from = isDate(input.date_from) && input.date_from > now.date ? input.date_from : now.date;
  const to = isDate(input.date_to) && input.date_to < last ? input.date_to : last;
  const t1 = isTime(input.time_from) ? input.time_from : "00:00";
  const t2 = isTime(input.time_to) ? input.time_to : "24:00";
  if (to < from || t2 < t1) {
    throw new MatchError("datos_invalidos", "Revisa el rango: el final está antes del inicio.");
  }

  const { results } = await db
    .prepare(
      `SELECT ${GAME_COLUMNS} FROM games
       WHERE sport_id = ? AND status = 'abierto'
         AND date BETWEEN ? AND ? AND time BETWEEN ? AND ?
         AND (',' || accepted_levels || ',') LIKE ?
         AND NOT EXISTS (SELECT 1 FROM players p WHERE p.game_id = games.id AND p.visitor_id = ?)
       ORDER BY date, time, rowid`,
    )
    .bind(sportId, from, to, t1, t2, `%,${level},%`, visitorId ?? "")
    .all<GameRow>();

  const open = results.filter((g) => isSlotOpen(g.date, g.time, now));
  return (await toPublicGames(db, open, visitorId)).filter((g) => g.missing > 0);
}
