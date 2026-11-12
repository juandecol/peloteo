// Fechas y horas en hora local de Chile.
// Las fechas se manejan como texto "YYYY-MM-DD" y las horas como "HH:MM".

export const TIMEZONE = "America/Santiago";

/** Minutos de margen después del inicio de un turno durante los que aún se muestra y acepta. */
export const SLOT_GRACE_MINUTES = 15;

/** Días hacia adelante que se pueden agendar (hoy + 15). */
export const BOOKING_HORIZON_DAYS = 15;

/** Momento actual expresado en hora local. */
export interface LocalNow {
  date: string;
  minutes: number; // minutos desde la medianoche local
}

const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const TIME_RE = /^([01]\d|2[0-4]):[0-5]\d$/;
const MONTH_RE = /^\d{4}-(0[1-9]|1[0-2])$/;

/** true si el texto es una fecha real con formato YYYY-MM-DD. */
export function isDate(s: unknown): s is string {
  if (typeof s !== "string" || !DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number) as [number, number, number];
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function isTime(s: unknown): s is string {
  return typeof s === "string" && TIME_RE.test(s) && toMinutes(s) <= 24 * 60;
}

export function isMonth(s: unknown): s is string {
  return typeof s === "string" && MONTH_RE.test(s);
}

export function toMinutes(time: string): number {
  const [h, m] = time.split(":").map(Number) as [number, number];
  return h * 60 + m;
}

export function fromMinutes(total: number): string {
  const h = Math.floor(total / 60);
  const m = total % 60;
  return String(h).padStart(2, "0") + ":" + String(m).padStart(2, "0");
}

function toUtcDate(date: string): Date {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function fromUtcDate(dt: Date): string {
  return dt.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const dt = toUtcDate(date);
  dt.setUTCDate(dt.getUTCDate() + days);
  return fromUtcDate(dt);
}

/** Día de la semana: 0 = domingo ... 6 = sábado. */
export function dayOfWeek(date: string): number {
  return toUtcDate(date).getUTCDay();
}

/** Todas las fechas de un mes "YYYY-MM". */
export function datesOfMonth(month: string): string[] {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return Array.from({ length: days }, (_, i) => month + "-" + String(i + 1).padStart(2, "0"));
}

/** Convierte un instante a la fecha y hora local de Chile (considera el horario de verano). */
export function localNow(now: Date, timeZone: string = TIMEZONE): LocalNow {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "00";
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    minutes: Number(get("hour")) * 60 + Number(get("minute")),
  };
}

/** Última fecha que se puede agendar. */
export function lastBookableDate(now: LocalNow): string {
  return addDays(now.date, BOOKING_HORIZON_DAYS);
}

/** true si la fecha está entre hoy y hoy + 15. */
export function isDateBookable(date: string, now: LocalNow): boolean {
  return date >= now.date && date <= lastBookableDate(now);
}

/**
 * true si un turno todavía se muestra y acepta: la fecha está dentro del rango
 * agendable y no han pasado más de 15 minutos desde su inicio.
 */
export function isSlotOpen(date: string, time: string, now: LocalNow): boolean {
  if (!isDateBookable(date, now)) return false;
  if (date > now.date) return true;
  return now.minutes <= toMinutes(time) + SLOT_GRACE_MINUTES;
}

/** Un jugador puede cancelar su cupo hasta esta cantidad de minutos antes del inicio. */
export const CANCEL_DEADLINE_MINUTES = 60;

/** Minutos que faltan para el inicio del turno (negativo si ya comenzó). */
export function minutesUntil(date: string, time: string, now: LocalNow): number {
  const days = Math.round((toUtcDate(date).getTime() - toUtcDate(now.date).getTime()) / 86_400_000);
  return days * 24 * 60 + toMinutes(time) - now.minutes;
}

/** true si todavía se puede cancelar un cupo: falta al menos 1 hora para el inicio. */
export function canStillCancel(date: string, time: string, now: LocalNow): boolean {
  return minutesUntil(date, time, now) >= CANCEL_DEADLINE_MINUTES;
}
