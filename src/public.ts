// Rutas públicas, bajo /api. Los jugadores no se registran: el servidor les
// asigna una cookie visitor_id aleatoria en la primera visita.
//
// Cuentas (preparadas, desactivadas): con ACCOUNTS_ENABLED = "1", quien entra
// con el enlace del correo tiene además la cookie peloteo_user, y sus partidos
// se reconocen por la cuenta en cualquier dispositivo (ver lib/accounts.ts).

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sameOriginJson, type AppBindings, type AppOptions } from "./admin.ts";
import { courtMode, getDayAvailability, getMonthSummary } from "./lib/availability.ts";
import {
  cancelByToken,
  cancelByVisitor,
  createGame,
  joinGame,
  MatchError,
  searchGames,
  type PlayerInput,
} from "./lib/matching.ts";
import { sendMail, sendNotices, siteFor } from "./notices.ts";
import { getSettings } from "./lib/settings.ts";
import {
  AccountError,
  getProfile,
  getUserBySession,
  LOGIN_LINK_MINUTES,
  requestLoginLink,
  signInWithLink,
  signOut,
  updateProfile,
  USER_SESSION_DAYS,
  whoOf,
  type User,
} from "./lib/accounts.ts";
import { renderLoginEmail } from "./lib/email.ts";
import type { Who } from "./lib/identity.ts";
import { getGameByToken, getMyGame, listOpenBlock, openOverview, getPublicSport, listMyGames, listSportGroups, listVenuesForSport } from "./lib/public.ts";
import { isDate, isMonth, lastBookableDate, localNow } from "./lib/time.ts";

export const VISITOR_COOKIE = "visitor_id";
const VISITOR_RE = /^V-[0-9a-f]{32}$/;
const VISITOR_DAYS = 400; // máximo que aceptan los navegadores

export const USER_COOKIE = "peloteo_user";

type Env = { Bindings: AppBindings; Variables: { visitor: string; user: User | null; who: Who } };
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

/** Las cuentas de jugadores están preparadas pero solo funcionan con ACCOUNTS_ENABLED = "1". */
const accountsOn = (c: { env: AppBindings }) => c.env.ACCOUNTS_ENABLED === "1";

export function publicRoutes(options: AppOptions = {}) {
  const clock = options.now ?? (() => new Date());
  const today = (c: Ctx) => localNow(clock(), c.env.TIMEZONE);
  const mode = (c: Ctx) => courtMode(c.env.COURT_MODE);
  const app = new Hono<Env>();

  app.use("*", sameOriginJson);
  app.use("*", visitor);
  // Cuenta del jugador, solo si las cuentas están activas.
  app.use("*", async (c, next) => {
    const user = accountsOn(c) ? await getUserBySession(c.env.DB, getCookie(c, USER_COOKIE), clock()) : null;
    c.set("user", user);
    c.set("who", whoOf(c.get("visitor"), user));
    return next();
  });
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });
  app.onError((err, c) => {
    if (err instanceof AccountError) {
      return c.json({ error: err.message, code: err.code, field: err.field }, err.code === "demasiados_enlaces" ? 429 : 400);
    }
    if (err instanceof MatchError) {
      return c.json({ error: err.message, code: err.code, field: err.field }, STATUS[err.code] ?? 400);
    }
    throw err;
  });

  /** Fecha de hoy y último día agendable, para que la interfaz arme el calendario. */
  app.get("/today", async (c) => {
    const now = today(c);
    const settings = await getSettings(c.env.DB);
    return c.json({
      date: now.date,
      minutes: now.minutes,
      last_bookable: lastBookableDate(now),
      court_mode: mode(c),
      whatsapp_contact: settings.whatsapp_contact,
    });
  });

  /** Datos del jugador; sin el ajuste "pedir WhatsApp", se descartan el número y el aviso. */
  async function playerInput(c: Ctx, raw: unknown): Promise<PlayerInput> {
    const p = (raw && typeof raw === "object" ? raw : {}) as PlayerInput;
    if ((await getSettings(c.env.DB)).whatsapp_contact) return p;
    return { ...p, whatsapp: null, whatsapp_opt_in: false };
  }

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
    if (isMonth(month)) return c.json({ days: await getMonthSummary(c.env.DB, sportId, month, today(c), mode(c)) });
    if (isDate(date)) {
      return c.json({ slots: await getDayAvailability(c.env.DB, sportId, date, today(c), c.get("who"), mode(c)) });
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
      c.get("who"),
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
        player: await playerInput(c, body.player),
      },
      c.get("who"),
      today(c),
      mode(c),
    );
    await sendNotices(c, r.notices, today(c), options);
    return c.json({ game: await getMyGame(c.env.DB, r.game.id, c.get("who"), today(c)) }, 201);
  });

  app.post("/games/:id/join", async (c) => {
    const body = await readJson(c);
    const r = await joinGame(c.env.DB, c.req.param("id"), await playerInput(c, body.player), c.get("who"), today(c), mode(c));
    await sendNotices(c, r.notices, today(c), options);
    return c.json({ game: await getMyGame(c.env.DB, r.game.id, c.get("who"), today(c)) });
  });

  app.post("/games/:id/cancel", async (c) => {
    const r = await cancelByVisitor(c.env.DB, c.req.param("id"), c.get("who"), today(c));
    await sendNotices(c, r.notices, today(c), options);
    return c.json({ cancelled: true, game_deleted: r.game_deleted });
  });

  // Enlace de cancelación de los correos. El token viaja en el cuerpo (POST),
  // nunca en la dirección, para que no quede en registros.
  app.post("/token/game", async (c) => {
    const body = await readJson(c);
    const game = await getGameByToken(c.env.DB, typeof body.token === "string" ? body.token : "", today(c));
    if (!game) {
      return c.json({ error: "Ese enlace ya no sirve: el cupo fue cancelado o el partido ya no existe.", code: "cupo_no_existe" }, 404);
    }
    return c.json({ game });
  });

  app.post("/token/cancel", async (c) => {
    const body = await readJson(c);
    const r = await cancelByToken(c.env.DB, typeof body.token === "string" ? body.token : "", today(c));
    await sendNotices(c, r.notices, today(c), options);
    return c.json({ cancelled: true, game_deleted: r.game_deleted });
  });

  // Inicio: partidos que buscan jugadores en los próximos 8 días, por AM y PM.
  app.get("/open", async (c) => c.json(await openOverview(c.env.DB, c.get("who"), today(c))));
  app.get("/open/block", async (c) => {
    const games = await listOpenBlock(c.env.DB, c.req.query("date"), c.req.query("half"), c.get("who"), today(c));
    if (!games) return c.json({ error: "Elige un día de los próximos 8 y AM o PM.", code: "datos_invalidos" }, 400);
    return c.json(games);
  });

  // ---------------- Cuentas (preparadas, desactivadas) ----------------
  // Con ACCOUNTS_ENABLED distinto de "1" estas rutas responden 404.

  const account = new Hono<Env>();
  account.use("*", async (c, next) => (accountsOn(c) ? next() : c.json({ error: "No encontrado" }, 404)));

  /** Pide el enlace de ingreso. Responde lo mismo exista o no la cuenta. */
  account.post("/link", async (c) => {
    const body = await readJson(c);
    const r = await requestLoginLink(c.env.DB, body.email, c.get("visitor"), clock());
    await sendMail(c, r.email, renderLoginEmail(siteFor(c.env, c.req.url), r.token, LOGIN_LINK_MINUTES), options);
    return c.json({ sent: true });
  });

  /** Entra con el token del enlace: abre la sesión y traspasa los partidos de este navegador. */
  account.post("/login", async (c) => {
    const body = await readJson(c);
    const r = await signInWithLink(c.env.DB, body.token, clock());
    setCookie(c, USER_COOKIE, r.session_token, {
      path: "/",
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: USER_SESSION_DAYS * 24 * 3600,
    });
    return c.json({ user: r.user, linked_players: r.linked_players });
  });

  account.get("/me", async (c) => {
    const user = c.get("user");
    return c.json({ user: user ? await getProfile(c.env.DB, user.id) : null });
  });

  account.put("/profile", async (c) => {
    const user = c.get("user");
    if (!user) return c.json({ error: "Entra a tu cuenta primero.", code: "sin_sesion" }, 401);
    return c.json({ user: await updateProfile(c.env.DB, user.id, await readJson(c)) });
  });

  account.post("/logout", async (c) => {
    await signOut(c.env.DB, getCookie(c, USER_COOKIE));
    deleteCookie(c, USER_COOKIE, { path: "/", secure: true, httpOnly: true, sameSite: "Lax" });
    return c.json({ user: null });
  });

  app.route("/account", account);

  app.get("/me/games", async (c) => c.json(await listMyGames(c.env.DB, c.get("who"), today(c))));

  return app;
}
