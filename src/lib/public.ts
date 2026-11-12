// Consultas del flujo público: deportes agrupados por nombre, lugares que los
// ofrecen y "Mis partidos" del visitante.
//
// Privacidad: las respuestas públicas solo incluyen iniciales y nivel. El email
// y el WhatsApp de un jugador solo aparecen en "Mis partidos" (y en la
// confirmación) para quienes comparten con él un encuentro confirmado.

import { parseIntList } from "./availability.ts";
import { placeholders, type Db } from "./db.ts";
import { canStillCancel, isSlotOpen, type LocalNow } from "./time.ts";

/** Nombre normalizado para agrupar deportes: sin tildes, minúsculas y espacios simples. */
export function sportKey(name: string): string {
  return name
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

export interface SportGroup {
  key: string;
  name: string;
  venues: number;
  courts: number;
}

interface SportRow {
  id: string;
  venue_id: string;
  name: string;
  match_sizes: string;
  courts: number;
}

/** Deportes vigentes con al menos una cancha operativa. */
async function activeSports(db: Db): Promise<SportRow[]> {
  const { results } = await db
    .prepare(
      `SELECT s.id, s.venue_id, s.name, s.match_sizes,
              (SELECT count(*) FROM courts c
               WHERE c.sport_id = s.id AND c.deleted_at IS NULL AND c.status = 'operativa') AS courts
       FROM sports s JOIN venues v ON v.id = s.venue_id
       WHERE s.deleted_at IS NULL AND v.deleted_at IS NULL
       ORDER BY s.name, v.name`,
    )
    .all<SportRow>();
  return results.filter((s) => s.courts > 0);
}

/**
 * Nombre a mostrar para un grupo: el más usado; si empatan, el que lleva tildes
 * y no está todo en mayúsculas ("Pádel" antes que "PADEL" o "Padel").
 */
function displayName(names: string[]): string {
  const count = new Map<string, number>();
  for (const n of names) count.set(n, (count.get(n) ?? 0) + 1);
  const score = (n: string) =>
    (count.get(n) ?? 0) * 4 + (n !== sportKey(n) && /[^\u0000-\u007f]/.test(n) ? 2 : 0) + (n !== n.toUpperCase() ? 1 : 0);
  return [...count.keys()].sort((a, b) => score(b) - score(a) || a.localeCompare(b, "es"))[0]!;
}

/** Deportes agrupados por nombre normalizado, con cuántos lugares y canchas los ofrecen. */
export async function listSportGroups(db: Db): Promise<SportGroup[]> {
  const groups = new Map<string, SportGroup & { names: string[] }>();
  for (const s of await activeSports(db)) {
    const key = sportKey(s.name);
    const g = groups.get(key) ?? { key, name: s.name, venues: 0, courts: 0, names: [] };
    g.venues++;
    g.courts += s.courts;
    g.names.push(s.name.trim());
    groups.set(key, g);
  }
  return [...groups.values()]
    .map(({ names, ...g }) => ({ ...g, name: displayName(names) }))
    .sort((a, b) => a.name.localeCompare(b.name, "es"));
}

export interface PublicSport {
  id: string;
  name: string;
  match_sizes: number[];
  categories: { level: number; label: string }[];
}

export interface VenueOffer {
  venue: { id: string; name: string; address: string; maps_url: string };
  sport: PublicSport;
  courts: number;
  open_games: number;
}

async function categoriesOf(db: Db, sportIds: string[]) {
  if (sportIds.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT sport_id, level, label FROM categories
       WHERE sport_id IN (${placeholders(sportIds.length)}) ORDER BY level`,
    )
    .bind(...sportIds)
    .all<{ sport_id: string; level: number; label: string }>();
  return results;
}

/** Lugares que ofrecen un deporte (por nombre normalizado). */
export async function listVenuesForSport(db: Db, key: string, now: LocalNow): Promise<VenueOffer[]> {
  const sports = (await activeSports(db)).filter((s) => sportKey(s.name) === sportKey(key));
  if (sports.length === 0) return [];
  const ids = sports.map((s) => s.id);
  const cats = await categoriesOf(db, ids);
  const { results: venues } = await db
    .prepare(
      `SELECT id, name, address, maps_url FROM venues
       WHERE id IN (${placeholders(sports.length)})`,
    )
    .bind(...sports.map((s) => s.venue_id))
    .all<VenueOffer["venue"]>();
  const { results: open } = await db
    .prepare(
      `SELECT sport_id, date, time FROM games
       WHERE sport_id IN (${placeholders(ids.length)}) AND status = 'abierto' AND date >= ?`,
    )
    .bind(...ids, now.date)
    .all<{ sport_id: string; date: string; time: string }>();
  return sports
    .map((s) => ({
      venue: venues.find((v) => v.id === s.venue_id)!,
      sport: {
        id: s.id,
        name: s.name,
        match_sizes: parseIntList(s.match_sizes, 2, 4),
        categories: cats.filter((c) => c.sport_id === s.id).map(({ level, label }) => ({ level, label })),
      },
      courts: s.courts,
      open_games: open.filter((g) => g.sport_id === s.id && isSlotOpen(g.date, g.time, now)).length,
    }))
    .filter((o) => o.venue)
    .sort((a, b) => a.venue.name.localeCompare(b.venue.name, "es"));
}

/** Datos públicos de un deporte de un lugar (para el formulario). */
export async function getPublicSport(db: Db, sportId: string): Promise<(PublicSport & { venue_id: string }) | null> {
  const s = await db
    .prepare("SELECT id, venue_id, name, match_sizes FROM sports WHERE id = ? AND deleted_at IS NULL")
    .bind(sportId)
    .first<{ id: string; venue_id: string; name: string; match_sizes: string }>();
  if (!s) return null;
  const cats = await categoriesOf(db, [s.id]);
  return {
    id: s.id,
    venue_id: s.venue_id,
    name: s.name,
    match_sizes: parseIntList(s.match_sizes, 2, 4),
    categories: cats.map(({ level, label }) => ({ level, label })),
  };
}

// ---------------------------------------------------------------
// Mis partidos
// ---------------------------------------------------------------

export interface MyPlayer {
  initials: string;
  level: number;
  me: boolean;
  /** Solo si el encuentro está confirmado. */
  email?: string;
  whatsapp?: string | null;
}

export interface MyGame {
  id: string;
  date: string;
  time: string;
  status: "abierto" | "sin_cancha" | "confirmado" | "cancelado";
  capacity: number;
  accepted_levels: number[];
  missing: number;
  sport: { id: string; name: string };
  venue: { name: string; address: string; maps_url: string };
  court: { name: string; surface: string; notes: string; maps_url: string } | null;
  players: MyPlayer[];
  can_cancel: boolean;
}

interface MyGameRow {
  id: string;
  date: string;
  time: string;
  status: MyGame["status"];
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
}

async function myGameRows(db: Db, where: string, params: unknown[]): Promise<MyGameRow[]> {
  const { results } = await db
    .prepare(
      `SELECT g.id, g.date, g.time, g.status, g.capacity, g.accepted_levels,
              s.id AS sport_id, s.name AS sport_name,
              v.name AS venue_name, v.address AS venue_address, v.maps_url AS venue_maps,
              c.name AS court_name, c.surface AS court_surface, c.notes AS court_notes, c.maps_url AS court_maps
       FROM games g
       JOIN sports s ON s.id = g.sport_id
       JOIN venues v ON v.id = g.venue_id
       LEFT JOIN courts c ON c.id = g.court_id
       WHERE ${where}
       ORDER BY g.date, g.time, g.rowid`,
    )
    .bind(...params)
    .all<MyGameRow>();
  return results;
}

async function toMyGames(db: Db, rows: MyGameRow[], visitorId: string, now: LocalNow): Promise<MyGame[]> {
  if (rows.length === 0) return [];
  const { results: players } = await db
    .prepare(
      `SELECT game_id, initials, level, email, whatsapp, visitor_id FROM players
       WHERE game_id IN (${placeholders(rows.length)}) ORDER BY rowid`,
    )
    .bind(...rows.map((r) => r.id))
    .all<{ game_id: string; initials: string; level: number; email: string; whatsapp: string | null; visitor_id: string }>();
  return rows.map((g) => {
    const own = players.filter((p) => p.game_id === g.id);
    const iAmIn = own.some((p) => p.visitor_id === visitorId);
    const showContacts = g.status === "confirmado" && iAmIn;
    return {
      id: g.id,
      date: g.date,
      time: g.time,
      status: g.status,
      capacity: g.capacity,
      accepted_levels: parseIntList(g.accepted_levels, 1, 5),
      missing: Math.max(0, g.capacity - own.length),
      sport: { id: g.sport_id, name: g.sport_name },
      venue: { name: g.venue_name, address: g.venue_address, maps_url: g.venue_maps },
      court: g.court_name
        ? { name: g.court_name, surface: g.court_surface ?? "", notes: g.court_notes ?? "", maps_url: g.court_maps ?? "" }
        : null,
      players: own.map((p) => ({
        initials: p.initials,
        level: p.level,
        me: p.visitor_id === visitorId,
        ...(showContacts ? { email: p.email, whatsapp: p.whatsapp } : {}),
      })),
      can_cancel: iAmIn && g.status !== "cancelado" && canStillCancel(g.date, g.time, now),
    };
  });
}

/** Encuentros del visitante de hoy en adelante, incluidos los cancelados por el administrador. */
export async function listMyGames(db: Db, visitorId: string, now: LocalNow): Promise<MyGame[]> {
  const rows = await myGameRows(
    db,
    "g.date >= ? AND EXISTS (SELECT 1 FROM players p WHERE p.game_id = g.id AND p.visitor_id = ?)",
    [now.date, visitorId],
  );
  return toMyGames(db, rows, visitorId, now);
}

/** Un encuentro visto por uno de sus jugadores (para la pantalla de confirmación). */
export async function getMyGame(db: Db, gameId: string, visitorId: string, now: LocalNow): Promise<MyGame | null> {
  const rows = await myGameRows(
    db,
    "g.id = ? AND EXISTS (SELECT 1 FROM players p WHERE p.game_id = g.id AND p.visitor_id = ?)",
    [gameId, visitorId],
  );
  const [game] = await toMyGames(db, rows, visitorId, now);
  return game ?? null;
}
