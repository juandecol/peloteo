// Avisos a los jugadores: una sola función notify(evento, jugador, encuentro)
// con canales intercambiables. Hasta la etapa 5 el único canal registra el aviso
// en el log del Worker (sin datos de contacto).

import { placeholders, type Db } from "./db.ts";

export type NoticeEvent =
  | "partido_publicado"
  | "jugador_se_sumo"
  | "partido_confirmado"
  | "partido_sin_cancha"
  | "cupo_cancelado"
  | "encuentro_cancelado"; // eliminado o cancelado por el administrador

/** Aviso pendiente: a qué jugadores y por qué. */
export interface PendingNotice {
  event: NoticeEvent;
  game_id: string;
  player_ids: string[];
}

export interface NoticePlayer {
  id: string;
  initials: string;
  email: string;
  whatsapp: string | null;
  whatsapp_opt_in: number;
  cancel_token: string;
}

export interface NoticeGame {
  id: string;
  date: string;
  time: string;
  status: string;
  venue_name: string;
  sport_name: string;
  court_name: string | null;
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
      console.error(`Aviso no enviado por ${ch.name}:`, err);
    }
  }
}

/** Carga jugadores y encuentros de una lista de avisos y los envía. */
export async function deliverNotices(
  db: Db,
  notices: PendingNotice[],
  channels: Channel[] = [logChannel],
): Promise<number> {
  let sent = 0;
  for (const n of notices) {
    if (n.player_ids.length === 0) continue;
    const game = await db
      .prepare(
        `SELECT g.id, g.date, g.time, g.status, v.name AS venue_name, s.name AS sport_name, c.name AS court_name
         FROM games g
         JOIN venues v ON v.id = g.venue_id
         JOIN sports s ON s.id = g.sport_id
         LEFT JOIN courts c ON c.id = g.court_id
         WHERE g.id = ?`,
      )
      .bind(n.game_id)
      .first<NoticeGame>();
    if (!game) continue;
    const { results: players } = await db
      .prepare(
        `SELECT id, initials, email, whatsapp, whatsapp_opt_in, cancel_token FROM players
         WHERE id IN (${placeholders(n.player_ids.length)})`,
      )
      .bind(...n.player_ids)
      .all<NoticePlayer>();
    for (const p of players) {
      await notify(n.event, p, game, channels);
      sent++;
    }
  }
  return sent;
}
