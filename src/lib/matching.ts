// Emparejamiento: abrir partido, unirse, cancelar un cupo y buscar jugadores.
//
// Concurrencia: cada escritura se hace en un solo db.batch(), que D1 ejecuta como
// una transacción. Las sentencias verifican en SQL que el turno siga libre o que
// el encuentro tenga cupo, y el índice único (court_id, date, time) es la última
// defensa contra la doble reserva.

import { courtHasSlot, loadCourts, toPublicGames, type PublicGame } from "./availability.ts";
import { isUniqueViolation, newId, newToken, placeholders, type Db } from "./db.ts";
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

export type MatchEvent =
  | "partido_publicado"
  | "jugador_se_sumo"
  | "partido_confirmado"
  | "cupo_cancelado";

/** Aviso que la capa de rutas entrega a notify(): a qué jugadores y por qué. */
export interface PendingNotice {
  event: MatchEvent;
  game_id: string;
  player_ids: string[];
}

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

// ---------------------------------------------------------------
// Consultas de apoyo
// ---------------------------------------------------------------

interface SportRow {
  id: string;
  venue_id: string;
  players_per_match: number;
}

async function loadSport(db: Db, sportId: string): Promise<SportRow> {
  const sport = await db
    .prepare("SELECT id, venue_id, players_per_match FROM sports WHERE id = ?")
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

interface GameRow {
  id: string;
  sport_id: string;
  date: string;
  time: string;
  court_id: string;
  capacity: number;
  status: "abierto" | "confirmado" | "cancelado";
}

async function loadGame(db: Db, gameId: string): Promise<GameRow | null> {
  return db
    .prepare(
      "SELECT id, sport_id, date, time, court_id, capacity, status FROM games WHERE id = ?",
    )
    .bind(gameId)
    .first<GameRow>();
}

async function playerIds(db: Db, gameId: string): Promise<string[]> {
  const { results } = await db
    .prepare("SELECT id FROM players WHERE game_id = ? ORDER BY rowid")
    .bind(gameId)
    .all<{ id: string }>();
  return results.map((r) => r.id);
}

async function publicGame(db: Db, gameId: string, visitorId: string): Promise<PublicGame> {
  const row = await loadGame(db, gameId);
  if (!row || row.status === "cancelado") {
    throw new MatchError("encuentro_no_existe", "Ese partido ya no existe.");
  }
  const [game] = await toPublicGames(db, [{ ...row, status: row.status }], visitorId);
  return game!;
}

function insertPlayerSql(condition: string): string {
  return `INSERT INTO players
    (id, game_id, visitor_id, initials, level, email, whatsapp, whatsapp_opt_in, cancel_token)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ? WHERE ${condition}`;
}

function playerValues(id: string, gameId: string, visitorId: string, p: ValidPlayer, token: string) {
  return [id, gameId, visitorId, p.initials, p.level, p.email, p.whatsapp, p.whatsapp_opt_in, token];
}

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
  player: PlayerInput;
}

/**
 * Abre un partido: asigna la primera cancha libre del turno y deja el encuentro
 * `abierto` con el jugador que lo creó. Si el turno ya se ocupó, lanza turno_ocupado.
 */
export async function createGame(
  db: Db,
  input: CreateGameInput,
  visitorId: string,
  now: LocalNow,
): Promise<JoinResult> {
  const sportId = typeof input.sport_id === "string" ? input.sport_id : "";
  const sport = await loadSport(db, sportId);
  const player = validatePlayer(input.player, await loadLevels(db, sport.id));

  const { date, time } = input;
  if (!isDate(date) || !isTime(time)) {
    throw new MatchError("datos_invalidos", "Elige un día y una hora.", "date");
  }
  if (!isDateBookable(date, now)) {
    throw new MatchError(
      "turno_cerrado",
      `Solo se puede agendar hasta el ${lastBookableDate(now)}.`,
    );
  }
  if (!isSlotOpen(date, time, now)) {
    throw new MatchError("turno_cerrado", "Esa hora ya pasó. Elige otra.");
  }

  const candidates = (await loadCourts(db, sport.id)).filter((c) => courtHasSlot(c, date, time));
  if (candidates.length === 0) {
    throw new MatchError("turno_invalido", "No hay canchas para esa hora. Elige otra.");
  }
  const courtIds = candidates.map((c) => c.id);

  // Reintenta solo si chocó el ID generado (muy improbable).
  for (let attempt = 0; attempt < 3; attempt++) {
    const gameId = newId("E");
    const playerId = newId("J");
    const token = newToken();
    try {
      const [gameRes] = await db.batch([
        db
          .prepare(
            `INSERT INTO games (id, venue_id, sport_id, court_id, date, time, capacity, status)
             SELECT ?, c.venue_id, c.sport_id, c.id, ?, ?, ?, 'abierto'
             FROM courts c
             WHERE c.id IN (${placeholders(courtIds.length)})
               AND NOT EXISTS (
                 SELECT 1 FROM games g
                 WHERE g.court_id = c.id AND g.date = ? AND g.time = ? AND g.status <> 'cancelado')
             ORDER BY c.name, c.id
             LIMIT 1`,
          )
          .bind(gameId, date, time, sport.players_per_match, ...courtIds, date, time),
        db
          .prepare(insertPlayerSql("EXISTS (SELECT 1 FROM games WHERE id = ?)"))
          .bind(...playerValues(playerId, gameId, visitorId, player, token), gameId),
      ]);
      if (!gameRes || gameRes.meta.changes === 0) {
        throw new MatchError("turno_ocupado", "Esa hora se acaba de ocupar. Elige otra.");
      }
      return {
        game: await publicGame(db, gameId, visitorId),
        player_id: playerId,
        cancel_token: token,
        notices: [{ event: "partido_publicado", game_id: gameId, player_ids: [playerId] }],
      };
    } catch (err) {
      if (err instanceof MatchError) throw err;
      if (!isUniqueViolation(err)) throw err;
      // Otro encuentro tomó la última cancha justo a la vez.
      if (/games\.court_id/.test((err as Error).message)) {
        throw new MatchError("turno_ocupado", "Esa hora se acaba de ocupar. Elige otra.");
      }
      // Si no, chocó un ID: se reintenta con otro.
    }
  }
  throw new Error("No se pudo generar un ID único para el encuentro");
}

// ---------------------------------------------------------------
// Unirse
// ---------------------------------------------------------------

/**
 * Suma un jugador a un encuentro abierto. Al completarse la capacidad, el
 * encuentro pasa a `confirmado` en la misma transacción.
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

  const member = await db
    .prepare("SELECT 1 AS x FROM players WHERE game_id = ? AND visitor_id = ?")
    .bind(gameId, visitorId)
    .first();
  if (member) throw new MatchError("ya_inscrito", "Ya estás en ese partido.");

  const playerId = newId("J");
  const token = newToken();
  let inserted: number;
  try {
    const [ins] = await db.batch([
      db
        .prepare(
          insertPlayerSql(`EXISTS (
            SELECT 1 FROM games g
            WHERE g.id = ? AND g.status = 'abierto'
              AND (SELECT count(*) FROM players p WHERE p.game_id = g.id) < g.capacity)`),
        )
        .bind(...playerValues(playerId, gameId, visitorId, player, token), gameId),
      db
        .prepare(
          `UPDATE games SET status = 'confirmado'
           WHERE id = ? AND status = 'abierto'
             AND (SELECT count(*) FROM players p WHERE p.game_id = games.id) >= capacity`,
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
  }
  return { game: view, player_id: playerId, cancel_token: token, notices };
}

// ---------------------------------------------------------------
// Cancelar un cupo
// ---------------------------------------------------------------

export interface CancelResult {
  game_id: string;
  /** El encuentro quedó sin jugadores y se eliminó: la cancha está libre. */
  game_deleted: boolean;
  /** Estaba confirmado y volvió a abierto. */
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
    db
      .prepare(
        `UPDATE games SET status = 'abierto'
         WHERE id = ? AND status = 'confirmado'
           AND (SELECT count(*) FROM players p WHERE p.game_id = games.id) < capacity`,
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
  date_from?: unknown;
  date_to?: unknown;
  time_from?: unknown;
  time_to?: unknown;
  levels?: unknown;
}

/**
 * Encuentros abiertos del deporte (dentro de un lugar) en el rango de fechas y
 * horas, donde algún jugador tiene uno de los niveles pedidos. Excluye los
 * encuentros en que ya está el visitante y los turnos cerrados.
 */
export async function searchGames(
  db: Db,
  input: SearchInput,
  visitorId: string | null,
  now: LocalNow,
): Promise<PublicGame[]> {
  const sportId = typeof input.sport_id === "string" ? input.sport_id : "";
  await loadSport(db, sportId);

  const last = lastBookableDate(now);
  const from = isDate(input.date_from) && input.date_from > now.date ? input.date_from : now.date;
  const to = isDate(input.date_to) && input.date_to < last ? input.date_to : last;
  const t1 = isTime(input.time_from) ? input.time_from : "00:00";
  const t2 = isTime(input.time_to) ? input.time_to : "24:00";
  if (to < from || t2 < t1) {
    throw new MatchError("datos_invalidos", "Revisa el rango: el final está antes del inicio.");
  }

  const rawLevels = Array.isArray(input.levels) ? input.levels : [1, 2, 3, 4, 5];
  const levels = [...new Set(rawLevels.map(Number))].filter((n) => Number.isInteger(n) && n >= 1 && n <= 5);
  if (levels.length === 0) {
    throw new MatchError("datos_invalidos", "Elige al menos un nivel.", "levels");
  }

  const { results } = await db
    .prepare(
      `SELECT g.id, g.date, g.time, g.court_id, g.capacity, g.status FROM games g
       WHERE g.sport_id = ? AND g.status = 'abierto'
         AND g.date BETWEEN ? AND ? AND g.time BETWEEN ? AND ?
         AND EXISTS (SELECT 1 FROM players p
                     WHERE p.game_id = g.id AND p.level IN (${placeholders(levels.length)}))
         AND NOT EXISTS (SELECT 1 FROM players p WHERE p.game_id = g.id AND p.visitor_id = ?)
       ORDER BY g.date, g.time, g.id`,
    )
    .bind(sportId, from, to, t1, t2, ...levels, visitorId ?? "")
    .all<{ id: string; date: string; time: string; court_id: string; capacity: number; status: "abierto" }>();

  const open = results.filter((g) => isSlotOpen(g.date, g.time, now));
  return (await toPublicGames(db, open, visitorId)).filter((g) => g.missing > 0);
}
