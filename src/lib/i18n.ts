// Idiomas del sitio público: español de Chile (por defecto) e inglés.
//
// - El navegador guarda el idioma elegido en la cookie peloteo_lang ("es" o "en").
//   El servidor la lee para traducir los mensajes de error de /api.
// - Cada cupo guarda el idioma de quien se anotó (players.lang, migración 0011):
//   los correos le llegan en ese idioma, aunque sus compañeros usen el otro.
// - Los nombres de deportes conocidos se traducen; los lugares no (son nombres propios).
//   Las categorías tienen un texto opcional en inglés (categories.label_en).

export type Lang = "es" | "en";
export const LANG_COOKIE = "peloteo_lang";

/** "en" solo si viene exactamente así; cualquier otra cosa es español. */
export const asLang = (v: unknown): Lang => (v === "en" ? "en" : "es");

/** Nombre normalizado (sin tildes ni mayúsculas), igual que sportKey en public.ts. */
const keyOf = (name: string) =>
  name.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().replace(/\s+/g, " ");

/** Deportes con nombre distinto en inglés. Los demás se muestran tal cual. */
export const SPORTS_EN: Record<string, string> = {
  tenis: "Tennis",
  padel: "Padel",
  futbol: "Football",
  "futbol 5": "5-a-side football",
  "futbol 7": "7-a-side football",
  futbolito: "Five-a-side football",
  basquetbol: "Basketball",
  basquet: "Basketball",
  baloncesto: "Basketball",
  voleibol: "Volleyball",
  voley: "Volleyball",
  "voley playa": "Beach volleyball",
  squash: "Squash",
  "tenis de mesa": "Table tennis",
  "ping pong": "Ping pong",
  badminton: "Badminton",
  golf: "Golf",
  pickleball: "Pickleball",
  frontenis: "Frontenis",
  raquetbol: "Racquetball",
};

export function sportNameIn(name: string, lang: Lang): string {
  return lang === "en" ? (SPORTS_EN[keyOf(name)] ?? name) : name;
}

// ---------------------------------------------------------------
// Mensajes de error de la API pública
// ---------------------------------------------------------------

/** Mensajes fijos: el texto en español (tal como lo arma el servidor) y su versión en inglés. */
export const ERRORS_EN: Record<string, string> = {
  "Escribe tus iniciales (2 a 4 letras).": "Enter your initials (2 to 4 letters).",
  "Elige tu nivel de juego.": "Choose your playing level.",
  "Revisa el email: lo usamos para avisarte.": "Check your email address: we use it to keep you posted.",
  "Revisa el número de WhatsApp o déjalo en blanco.": "Check the WhatsApp number or leave it blank.",
  "Elige cuántos jugadores serán.": "Choose how many players there will be.",
  "Elige niveles de la lista.": "Choose levels from the list.",
  "Elige qué niveles aceptas.": "Choose which levels you accept.",
  "Incluye tu propio nivel entre los aceptados.": "Include your own level among the accepted ones.",
  "Ese deporte ya no está disponible.": "That sport is no longer available.",
  "Ese partido ya no existe.": "That match no longer exists.",
  "Elige un día y una hora.": "Choose a day and a time.",
  "Esa hora ya pasó. Elige otra.": "That time has already passed. Choose another one.",
  "No hay canchas para esa hora. Elige otra.": "There are no courts at that time. Choose another one.",
  "Ya no quedan canchas libres a esa hora. Elige otra.": "There are no free courts left at that time. Choose another one.",
  "Ese partido fue cancelado.": "That match was cancelled.",
  "Ese partido ya comenzó.": "That match has already started.",
  "Ya estás en ese partido.": "You're already in that match.",
  "Ese partido se acaba de completar. Elige otro.": "That match just filled up. Choose another one.",
  "Ya no se puede cancelar: el plazo termina 1 hora antes del inicio.": "It can no longer be cancelled: the deadline is 1 hour before the start.",
  "Ese cupo ya fue cancelado.": "That spot was already cancelled.",
  "No tienes un cupo en ese partido.": "You don't have a spot in that match.",
  "El enlace de cancelación no es válido.": "The cancellation link is not valid.",
  "Revisa el rango: el final está antes del inicio.": "Check the range: the end is before the start.",
  "Indica un mes (YYYY-MM) o un día (YYYY-MM-DD).": "Give a month (YYYY-MM) or a day (YYYY-MM-DD).",
  "Ese enlace ya no sirve: el cupo fue cancelado o el partido ya no existe.": "That link no longer works: the spot was cancelled or the match no longer exists.",
  "Elige un día de los próximos 8 y AM o PM.": "Choose one of the next 8 days and AM or PM.",
  "No encontrado": "Not found",
  "Entra a tu cuenta primero.": "Sign in to your account first.",
  "Revisa el email.": "Check your email address.",
  "Ya te enviamos varios enlaces. Revisa tu correo o espera unos minutos.": "We've already sent you several links. Check your inbox or wait a few minutes.",
  "El enlace ya se usó o venció. Pide uno nuevo.": "The link was already used or has expired. Ask for a new one.",
  "Niveles inválidos.": "Invalid levels.",
};

/** "nivel 3", "niveles 2, 3 y 4" o "todos los niveles" → inglés. */
export function levelsTextEn(es: string): string {
  if (es === "todos los niveles") return "all levels";
  return es.replace(/^(nivel|niveles) /, (_m, w: string) => (w === "nivel" ? "level " : "levels ")).replace(/ y (\d)$/, " and $1");
}

/** Mensajes con datos variables. */
const PATTERNS_EN: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^Solo se puede agendar hasta el (\d{4}-\d{2}-\d{2})\.$/, (m) => `You can only book until ${m[1]}.`],
  [/^Este partido busca jugadores de (.+)\.$/, (m) => `This match is looking for players of ${levelsTextEn(m[1]!)}.`],
];

/** Traduce un mensaje de error al idioma pedido; si no se conoce, queda en español. */
export function translateError(message: string, lang: Lang): string {
  if (lang !== "en") return message;
  if (ERRORS_EN[message]) return ERRORS_EN[message]!;
  for (const [re, fn] of PATTERNS_EN) {
    const m = message.match(re);
    if (m) return fn(m);
  }
  return message;
}
