// Avisos a los jugadores: una sola función notify(evento, jugador, encuentro)
// con canales intercambiables. El canal de registro deja constancia en el log
// del Worker (sin datos de contacto); el de correo está en email.ts.

import { getDayAvailability } from "./availability.ts";
import type { Db } from "./db.ts";
import { addDays, isDateBookable, toMinutes, type LocalNow } from "./time.ts";

export type NoticeEvent =
  | "partido_publicado"
  | "jugador_se_sumo"
  | "partido_confirmado"
  | "partido_sin_cancha"
  | "cupo_cancelado"
  | "encuentro_cancelado"; // cancelado por el administrador o por un bloqueo

/** Por qué se canceló un encuentro (solo para encuentro_cancelado). */
export type CancelCause = "administrador" | "bloqueo";

/** Aviso pendiente: a qué jugadores y por qué. */
export interface PendingNotice {
  event: NoticeEvent;
  game_id: string;
  player_ids: string[];
  cause?: CancelCause;
}

export interface NoticePlayer {
  id: string;
  initials: string;
  level: number;
  email: string;
  whatsapp: string | null;
  whatsapp_opt_in: number;
  cancel_token: string;
}

/** Turno con cancha libre que se sugiere a un encuentro sin cancha. */
export interface SuggestedSlot {
  date: string;
  time: string;
  free_courts: number;
}

export interface NoticeGame {
  id: string;
  date: string;
  time: string;
  status: string;
  capacity: number;
  accepted_levels: string;
  sport_id: string;
  sport_name: string;
  venue_name: string;
  venue_address: string;
  venue_maps: string;
  court_name: string | null;
  court_surface: string | null;
  court_notes: string | null;
  court_maps: string | null;
  /** Todos los jugadores del encuentro, por orden de llegada. */
  players: NoticePlayer[];
  cause?: CancelCause;
  /** Solo en partido_sin_cancha. */
  suggestions?: SuggestedSlot[];
}

export interface Channel {
  name: string;
  send(event: NoticeEvent, player: NoticePlayer, game: NoticeGame): Promise<void>;
}

/** Canal de registro: deja constancia en el log, sin email ni teléfono. */
export const logChannel: Channel = {
  name: "registro",
  async send(event, player, game) {
    console.log(
      JSON.stringify({ aviso: event, jugador: player.id, encuentro: game.id, fecha: game.date, hora: game.time }),
    );
  },
};

export async function notify(
  event: NoticeEvent,
  player: NoticePlayer,
  game: NoticeGame,
  channels: Channel[] = [logChannel],
): Promise<void> {
  for (const ch of channels) {
    try {
      await ch.send(event, player, game);
    } catch (err) {
      // Un canal caído no debe impedir los demás avisos ni la operación.
      console.error(`Aviso no enviado por ${ch.name}:`, err instanceof Error ? err.message : err);
    }
  }
}

const SUGGESTION_DAYS = 3; // el mismo día y los dos siguientes
const MAX_SUGGESTIONS = 6;

/**
 * Turnos con cancha libre cercanos al de un encuentro sin cancha: el mismo
 * deporte y lugar, ese día y los dos siguientes, ordenados por cercanía.
 */
export async function suggestSlots(
  db: Db,
  game: { sport_id: string; date: string; time: string },
  now: LocalNow,
): Promise<SuggestedSlot[]> {
  const found: (SuggestedSlot & { dist: number })[] = [];
  for (let i = 0; i < SUGGESTION_DAYS; i++) {
    const date = addDays(game.date, i);
    if (!isDateBookable(date, now)) continue;
    for (const s of await getDayAvailability(db, game.sport_id, date, now)) {
      if (s.free_courts === 0 || (date === game.date && s.time === game.time)) continue;
      found.push({
        date,
        time: s.time,
        free_courts: s.free_courts,
        dist: i * 24 * 60 + Math.abs(toMinutes(s.time) - toMinutes(game.time)),
      });
    }
  }
  return found
    .sort((a, b) => a.dist - b.dist)
    .slice(0, MAX_SUGGESTIONS)
    .map(({ dist: _, ...s }) => s)
    .sort((a, b) => (a.date + a.time < b.date + b.time ? -1 : 1));
}

/** Carga el encuentro con sus jugadores, tal como lo necesitan los canales. */
export async function loadNoticeGame(db: Db, gameId: string): Promise<NoticeGame | null> {
  const game = await db
    .prepare(
      `SELECT g.id, g.date, g.time, g.status, g.capacity, g.accepted_levels, g.sport_id,
              s.name AS sport_name, v.name AS venue_name, v.address AS venue_address, v.maps_url AS venue_maps,
              c.name AS court_name, c.surface AS court_surface, c.notes AS court_notes, c.maps_url AS court_maps
       FROM games g
       JOIN venues v ON v.id = g.venue_id
       JOIN sports s ON s.id = g.sport_id
       LEFT JOIN courts c ON c.id = g.court_id
       WHERE g.id = ?`,
    )
    .bind(gameId)
    .first<Omit<NoticeGame, "players">>();
  if (!game) return null;
  const { results: players } = await db
    .prepare(
      `SELECT id, initials, level, email, whatsapp, whatsapp_opt_in, cancel_token FROM players
       WHERE game_id = ? ORDER BY rowid`,
    )
    .bind(gameId)
    .all<NoticePlayer>();
  return { ...game, players };
}

export interface DeliverOptions {
  channels?: Channel[];
  /** Hora local; necesaria para sugerir turnos a los encuentros sin cancha. */
  now?: LocalNow;
}

/** Carga jugadores y encuentros de una lista de avisos y los envía. */
export async function deliverNotices(db: Db, notices: PendingNotice[], options: DeliverOptions = {}): Promise<number> {
  const channels = options.channels ?? [logChannel];
  let sent = 0;
  for (const n of notices) {
    if (n.player_ids.length === 0) continue;
    const game = await loadNoticeGame(db, n.game_id);
    if (!game) continue;
    if (n.cause) game.cause = n.cause;
    if (n.event === "partido_sin_cancha" && options.now) game.suggestions = await suggestSlots(db, game, options.now);
    for (const p of game.players.filter((p) => n.player_ids.includes(p.id))) {
      await notify(n.event, p, game, channels);
      sent++;
    }
  }
  return sent;
}
