// Disponibilidad: turnos que genera cada cancha y resumen por día y por mes.
//
// Una cancha está libre en un turno si genera ese turno y no tiene un encuentro
// confirmado a esa hora. Los encuentros abiertos no ocupan cancha.

import { placeholders, type Db } from "./db.ts";
import {
  dayOfWeek,
  datesOfMonth,
  fromMinutes,
  isDateBookable,
  isSlotOpen,
  toMinutes,
  type LocalNow,
} from "./time.ts";

export interface Court {
  id: string;
  name: string;
  status: "operativa" | "mantencion" | "cerrada";
  open_time: string;
  close_time: string;
  slot_minutes: number;
  days: string;
  available_from: string | null;
  available_to: string | null;
}

export type GameStatus = "abierto" | "sin_cancha" | "confirmado";

/** Jugador tal como se muestra públicamente: solo iniciales y nivel. */
export interface PublicPlayer {
  initials: string;
  level: number;
}

/** Encuentro tal como se muestra públicamente. */
export interface PublicGame {
  id: string;
  date: string;
  time: string;
  /** Cancha asignada; nula mientras no esté confirmado. */
  court_id: string | null;
  capacity: number;
  accepted_levels: number[];
  status: GameStatus;
  players: PublicPlayer[];
  missing: number;
  mine: boolean;
}

export interface Slot {
  time: string;
  free_courts: number;
  open_games: PublicGame[];
  /** true si no queda cancha libre ni encuentro al que sumarse. */
  full: boolean;
}

export interface DaySummary {
  date: string;
  /** Hay al menos un turno con cancha libre o encuentro abierto. */
  available: boolean;
  /** Encuentros que buscan jugadores. */
  open_games: number;
}

/** Lista de enteros separados por coma ("1, 3,x" → [1, 3]), filtrada por rango. */
export function parseIntList(text: string, min: number, max: number): number[] {
  return [
    ...new Set(
      text
        .split(",")
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s))
        .map(Number)
        .filter((n) => n >= min && n <= max),
    ),
  ].sort((a, b) => a - b);
}

/** Días de la semana en que opera una cancha ("0,1,2" → [0, 1, 2]). */
export function parseDays(days: string): number[] {
  return parseIntList(days, 0, 6);
}

/**
 * Turnos que genera una cancha en una fecha: desde la apertura, mientras el turno
 * completo termine a la hora de cierre o antes. Solo canchas operativas, en sus
 * días de operación y dentro de su rango de fechas.
 */
export function courtSlots(court: Court, date: string): string[] {
  if (court.status !== "operativa") return [];
  if (court.available_from && date < court.available_from) return [];
  if (court.available_to && date > court.available_to) return [];
  if (!parseDays(court.days).includes(dayOfWeek(date))) return [];
  const step = court.slot_minutes;
  if (!(step > 0)) return [];
  const close = toMinutes(court.close_time);
  const out: string[] = [];
  for (let t = toMinutes(court.open_time); t + step <= close; t += step) out.push(fromMinutes(t));
  return out;
}

/** true si la cancha genera ese turno en esa fecha. */
export function courtHasSlot(court: Court, date: string, time: string): boolean {
  return courtSlots(court, date).includes(time);
}

/**
 * Turnos de un día para un deporte. Combina los turnos de sus canchas con los
 * encuentros vigentes de ese día. Omite los turnos cerrados.
 */
export function dayAvailability(
  courts: Court[],
  games: PublicGame[],
  date: string,
  now: LocalNow,
): Slot[] {
  if (!isDateBookable(date, now)) return [];
  const taken = new Set(
    games.filter((g) => g.status === "confirmado" && g.court_id).map((g) => g.court_id + "|" + g.time),
  );
  const slots = new Map<string, Slot>();
  for (const court of courts) {
    for (const time of courtSlots(court, date)) {
      if (!isSlotOpen(date, time, now)) continue;
      let slot = slots.get(time);
      if (!slot) {
        slot = { time, free_courts: 0, open_games: [], full: false };
        slots.set(time, slot);
      }
      if (!taken.has(court.id + "|" + time)) slot.free_courts++;
    }
  }
  for (const g of games) {
    const slot = slots.get(g.time);
    if (slot && g.status === "abierto" && g.missing > 0) slot.open_games.push(g);
  }
  return [...slots.values()]
    .map((s) => ({ ...s, full: s.free_courts === 0 && s.open_games.length === 0 }))
    .sort((a, b) => (a.time < b.time ? -1 : a.time > b.time ? 1 : 0));
}

/** Resumen de los días agendables de un mes. Los días fuera de rango no se incluyen. */
export function monthSummary(
  courts: Court[],
  gamesByDate: Map<string, PublicGame[]>,
  month: string,
  now: LocalNow,
): DaySummary[] {
  return datesOfMonth(month)
    .filter((date) => isDateBookable(date, now))
    .map((date) => {
      const slots = dayAvailability(courts, gamesByDate.get(date) ?? [], date, now);
      const open = slots.reduce((n, s) => n + s.open_games.length, 0);
      return { date, available: slots.some((s) => !s.full), open_games: open };
    });
}

// ---------------------------------------------------------------
// Acceso a datos
// ---------------------------------------------------------------

const COURT_COLUMNS =
  "id, name, status, open_time, close_time, slot_minutes, days, available_from, available_to";

/** Canchas de un deporte, en el orden en que se asignan (nombre, luego ID). */
export async function loadCourts(db: Db, sportId: string): Promise<Court[]> {
  const { results } = await db
    .prepare(`SELECT ${COURT_COLUMNS} FROM courts WHERE sport_id = ? AND deleted_at IS NULL ORDER BY name, id`)
    .bind(sportId)
    .all<Court>();
  return results;
}

/** Fila de games con las columnas que necesita la vista pública. */
export interface GameRow {
  id: string;
  date: string;
  time: string;
  court_id: string | null;
  capacity: number;
  accepted_levels: string;
  status: GameStatus;
}

export const GAME_COLUMNS = "id, date, time, court_id, capacity, accepted_levels, status";

interface PlayerRow {
  game_id: string;
  initials: string;
  level: number;
  visitor_id: string;
}

/** Arma la vista pública de una lista de encuentros (sin datos de contacto). */
export async function toPublicGames(
  db: Db,
  rows: GameRow[],
  visitorId?: string | null,
): Promise<PublicGame[]> {
  if (rows.length === 0) return [];
  const ids = rows.map((r) => r.id);
  const { results: players } = await db
    .prepare(
      `SELECT game_id, initials, level, visitor_id FROM players
       WHERE game_id IN (${placeholders(ids.length)})
       ORDER BY rowid`,
    )
    .bind(...ids)
    .all<PlayerRow>();
  return rows.map((g) => {
    const own = players.filter((p) => p.game_id === g.id);
    return {
      id: g.id,
      date: g.date,
      time: g.time,
      court_id: g.court_id,
      capacity: g.capacity,
      accepted_levels: parseIntList(g.accepted_levels, 1, 5),
      status: g.status,
      players: own.map((p) => ({ initials: p.initials, level: p.level })),
      missing: Math.max(0, g.capacity - own.length),
      mine: !!visitorId && own.some((p) => p.visitor_id === visitorId),
    };
  });
}

async function loadGames(
  db: Db,
  sportId: string,
  from: string,
  to: string,
  visitorId?: string | null,
): Promise<PublicGame[]> {
  const { results } = await db
    .prepare(
      `SELECT ${GAME_COLUMNS} FROM games
       WHERE sport_id = ? AND date BETWEEN ? AND ? AND status <> 'cancelado'
       ORDER BY date, time, rowid`,
    )
    .bind(sportId, from, to)
    .all<GameRow>();
  return toPublicGames(db, results, visitorId);
}

/** Turnos de un día: canchas libres y encuentros abiertos. */
export async function getDayAvailability(
  db: Db,
  sportId: string,
  date: string,
  now: LocalNow,
  visitorId?: string | null,
): Promise<Slot[]> {
  if (!isDateBookable(date, now)) return [];
  const courts = await loadCourts(db, sportId);
  const games = await loadGames(db, sportId, date, date, visitorId);
  return dayAvailability(courts, games, date, now);
}

/** Resumen por día de un mes "YYYY-MM". */
export async function getMonthSummary(
  db: Db,
  sportId: string,
  month: string,
  now: LocalNow,
): Promise<DaySummary[]> {
  const courts = await loadCourts(db, sportId);
  const games = await loadGames(db, sportId, month + "-01", month + "-31");
  const byDate = new Map<string, PublicGame[]>();
  for (const g of games) byDate.set(g.date, [...(byDate.get(g.date) ?? []), g]);
  return monthSummary(courts, byDate, month, now);
}
