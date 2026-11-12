// Rutas públicas, bajo /api. Los jugadores no se registran: el servidor les
// asigna una cookie visitor_id aleatoria en la primera visita.

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { sameOriginJson, type AppBindings, type AppOptions } from "./admin.ts";
import { getDayAvailability, getMonthSummary } from "./lib/availability.ts";
import {
  cancelByVisitor,
  createGame,
  joinGame,
  MatchError,
  searchGames,
  type PlayerInput,
} from "./lib/matching.ts";
import { deliverNotices } from "./lib/notify.ts";
import { getMyGame, getPublicSport, listMyGames, listSportGroups, listVenuesForSport } from "./lib/public.ts";
import { isDate, isMonth, lastBookableDate, localNow } from "./lib/time.ts";

export const VISITOR_COOKIE = "visitor_id";
const VISITOR_RE = /^V-[0-9a-f]{32}$/;
const VISITOR_DAYS = 400; // máximo que aceptan los navegadores

type Env = { Bindings: AppBindings; Variables: { visitor: string } };
type Ctx = Context<Env>;

function newVisitorId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return "V-" + Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Lee la cookie del visitante o crea una nueva (HttpOnly, Secure, SameSite=Lax, larga duración). */
const visitor: MiddlewareHandler<Env> = async (c, next) => {
  let id = getCookie(c, VISITOR_COOKIE);
  if (!id || !VISITOR_RE.test(id)) {
    id = newVisitorId();
    setCookie(c, VISITOR_COOKIE, id, {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: VISITOR_DAYS * 24 * 3600,
    });
  }
  c.set("visitor", id);
  return next();
};

async function readJson(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const STATUS: Record<string, 400 | 404 | 409> = {
  deporte_no_existe: 404,
  encuentro_no_existe: 404,
  cupo_no_existe: 404,
  turno_ocupado: 409,
  encuentro_completo: 409,
  ya_inscrito: 409,
  encuentro_cancelado: 409,
};

export function publicRoutes(options: AppOptions = {}) {
  const clock = options.now ?? (() => new Date());
  const today = (c: Ctx) => localNow(clock(), c.env.TIMEZONE);
  const app = new Hono<Env>();

  app.use("*", sameOriginJson);
  app.use("*", visitor);
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  app.onError((err, c) => {
    if (err instanceof MatchError) {
      return c.json({ error: err.message, code: err.code, field: err.field }, STATUS[err.code] ?? 400);
    }
    throw err;
  });

  /** Fecha de hoy y último día agendable, para que la interfaz arme el calendario. */
  app.get("/today", (c) => {
    const now = today(c);
    return c.json({ date: now.date, minutes: now.minutes, last_bookable: lastBookableDate(now) });
  });

  app.get("/sports", async (c) => c.json(await listSportGroups(c.env.DB)));

  app.get("/venues", async (c) => c.json(await listVenuesForSport(c.env.DB, c.req.query("sport") ?? "", today(c))));

  app.get("/sports/:id", async (c) => {
    const s = await getPublicSport(c.env.DB, c.req.param("id"));
    return s ? c.json(s) : c.json({ error: "Ese deporte ya no está disponible." }, 404);
  });

  app.get("/availability", async (c) => {
    const sportId = c.req.query("sport_id") ?? "";
    const month = c.req.query("month");
    const date = c.req.query("date");
    if (isMonth(month)) return c.json({ days: await getMonthSummary(c.env.DB, sportId, month, today(c)) });
    if (isDate(date)) {
      return c.json({ slots: await getDayAvailability(c.env.DB, sportId, date, today(c), c.get("visitor")) });
    }
    return c.json({ error: "Indica un mes (YYYY-MM) o un día (YYYY-MM-DD)." }, 400);
  });

  app.get("/search", async (c) => {
    const q = c.req.query();
    const games = await searchGames(
      c.env.DB,
      {
        sport_id: q.sport_id,
        level: q.level,
        date_from: q.date_from,
        date_to: q.date_to,
        time_from: q.time_from,
        time_to: q.time_to,
      },
      c.get("visitor"),
      today(c),
    );
    return c.json(games);
  });

  app.post("/games", async (c) => {
    const body = await readJson(c);
    const r = await createGame(
      c.env.DB,
      {
        sport_id: body.sport_id,
        date: body.date,
        time: body.time,
        capacity: body.capacity,
        accepted_levels: body.accepted_levels,
        player: (body.player ?? {}) as PlayerInput,
      },
      c.get("visitor"),
      today(c),
    );
    await deliverNotices(c.env.DB, r.notices);
    return c.json({ game: await getMyGame(c.env.DB, r.game.id, c.get("visitor"), today(c)) }, 201);
  });

  app.post("/games/:id/join", async (c) => {
    const body = await readJson(c);
    const r = await joinGame(c.env.DB, c.req.param("id"), (body.player ?? {}) as PlayerInput, c.get("visitor"), today(c));
    await deliverNotices(c.env.DB, r.notices);
    return c.json({ game: await getMyGame(c.env.DB, r.game.id, c.get("visitor"), today(c)) });
  });

  app.post("/games/:id/cancel", async (c) => {
    const r = await cancelByVisitor(c.env.DB, c.req.param("id"), c.get("visitor"), today(c));
    await deliverNotices(c.env.DB, r.notices);
    return c.json({ cancelled: true, game_deleted: r.game_deleted });
  });

  app.get("/me/games", async (c) => c.json(await listMyGames(c.env.DB, c.get("visitor"), today(c))));

  return app;
}
