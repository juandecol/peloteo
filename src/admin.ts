// Rutas del administrador, bajo /admin.
//
// Públicas (sin sesión): POST /login, POST /login/2fa.
// Con sesión: POST /logout, GET /session, POST /password.
// Con sesión completa (segundo factor y contraseña ya cambiada): /api/*.

import { Hono, type Context, type MiddlewareHandler } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import {
  changePassword,
  getSession,
  login,
  logout,
  SESSION_HOURS,
  type Session,
} from "./lib/auth.ts";
import {
  cancelGame,
  ConfigError,
  createBlock,
  createCourt,
  createSport,
  createVenue,
  deleteBlock,
  deleteCourt,
  deleteSport,
  deleteVenue,
  getCourt,
  getSport,
  getVenue,
  listBlocks,
  listCourts,
  listGames,
  listSports,
  listVenues,
  SURFACES,
  updateCourt,
  updateSport,
  updateVenue,
  type DeleteResult,
} from "./lib/config.ts";
import type { Db } from "./lib/db.ts";
import type { Channel } from "./lib/notify.ts";
import { sendNotices } from "./notices.ts";
import { localNow } from "./lib/time.ts";

export const SESSION_COOKIE = "peloteo_admin";

export interface AppBindings {
  DB: Db;
  ASSETS?: { fetch(req: Request): Promise<Response> };
  TIMEZONE?: string;
  /** "resend" en producción; "consola" muestra los correos sin enviarlos. */
  EMAIL_MODE?: string;
  /** Dirección pública para los enlaces de los correos. */
  SITE_URL?: string;
  MAIL_FROM?: string;
  /** Secret de Cloudflare; nunca en el repositorio. */
  RESEND_API_KEY?: string;
}

export interface AppOptions {
  /** Reloj inyectable para las pruebas. */
  now?: () => Date;
  /** Canales de aviso inyectables para las pruebas. */
  channels?: Channel[];
}

type Env = { Bindings: AppBindings; Variables: { session: Session } };
type Ctx = Context<Env>;

function clientIp(c: Ctx): string {
  return c.req.header("CF-Connecting-IP") ?? "local";
}

async function readJson(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * Defensa contra CSRF además de SameSite=Strict: si el navegador manda Origin,
 * debe ser el mismo sitio; y los POST deben enviar JSON (un formulario de otro
 * sitio no puede hacerlo sin pasar por CORS). PUT y DELETE ya requieren CORS.
 */
export const sameOriginJson: MiddlewareHandler<any> = async (c, next) => {
  if (c.req.method === "GET" || c.req.method === "HEAD") return next();
  const type = c.req.header("Content-Type") ?? "";
  if (c.req.method === "POST" && !type.toLowerCase().startsWith("application/json")) {
    return c.json({ error: "Formato no admitido." }, 415);
  }
  const origin = c.req.header("Origin");
  if (origin && origin !== new URL(c.req.url).origin) {
    return c.json({ error: "Origen no permitido." }, 403);
  }
  return next();
};

function sessionCookie(c: Ctx, token: string) {
  setCookie(c, SESSION_COOKIE, token, {
    path: "/admin",
    httpOnly: true,
    secure: true,
    sameSite: "Strict",
    maxAge: SESSION_HOURS * 3600,
  });
}

function clearSessionCookie(c: Ctx) {
  deleteCookie(c, SESSION_COOKIE, { path: "/admin", secure: true, httpOnly: true, sameSite: "Strict" });
}

/** Estado de la sesión tal como lo necesita la interfaz. */
function sessionState(s: Session | null) {
  if (!s) return { logged_in: false };
  return {
    logged_in: true,
    username: s.username,
    needs_second_factor: !s.second_factor_passed,
    must_change_password: s.must_change_password,
    totp_enabled: s.totp_enabled,
    expires_at: s.expires_at,
  };
}

function configError(c: Ctx, err: unknown) {
  if (err instanceof ConfigError) {
    const status = err.code === "no_existe" ? 404 : err.code === "afecta_encuentros" ? 409 : 400;
    return c.json({ error: err.message, code: err.code, field: err.field, games: err.games }, status);
  }
  throw err;
}

export function adminRoutes(options: AppOptions = {}) {
  const clock = options.now ?? (() => new Date());
  const today = (c: Ctx) => localNow(clock(), c.env.TIMEZONE);
  const app = new Hono<Env>();

  app.use("*", sameOriginJson);
  app.use("*", async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  });

  // ---------------- Login en dos pasos ----------------

  app.post("/login", async (c) => {
    const body = await readJson(c);
    const r = await login(c.env.DB, body.username, body.password, clientIp(c), clock());
    if (!r.ok) {
      return r.reason === "bloqueado"
        ? c.json({ error: "Demasiados intentos fallidos. Espera 15 minutos e inténtalo de nuevo." }, 429)
        : c.json({ error: "Usuario o contraseña incorrectos." }, 401);
    }
    sessionCookie(c, r.token);
    return c.json({
      logged_in: true,
      needs_second_factor: r.needs_second_factor,
      must_change_password: r.must_change_password,
    });
  });

  // Segundo paso. Mientras totp_enabled sea falso, la sesión ya nace validada y
  // este paso no se usa. La verificación TOTP se implementa en la etapa 7.
  app.post("/login/2fa", async (c) => {
    const s = await getSession(c.env.DB, getCookie(c, SESSION_COOKIE), clock());
    if (!s) return c.json({ error: "Tu sesión expiró. Vuelve a entrar." }, 401);
    if (s.second_factor_passed) return c.json(sessionState(s));
    return c.json({ error: "El segundo factor todavía no está disponible." }, 501);
  });

  // ---------------- Sesión ----------------

  const requireSession: MiddlewareHandler<Env> = async (c, next) => {
    const s = await getSession(c.env.DB, getCookie(c, SESSION_COOKIE), clock());
    if (!s) return c.json({ error: "Tu sesión expiró. Vuelve a entrar.", code: "sin_sesion" }, 401);
    if (!s.second_factor_passed) {
      return c.json({ error: "Falta el segundo factor.", code: "segundo_factor" }, 401);
    }
    c.set("session", s);
    return next();
  };

  app.get("/session", async (c) => {
    const s = await getSession(c.env.DB, getCookie(c, SESSION_COOKIE), clock());
    return c.json(sessionState(s));
  });

  app.post("/logout", async (c) => {
    await logout(c.env.DB, getCookie(c, SESSION_COOKIE));
    clearSessionCookie(c);
    return c.json({ logged_in: false });
  });

  app.post("/password", requireSession, async (c) => {
    const body = await readJson(c);
    const err = await changePassword(c.env.DB, c.get("session"), body.current_password, body.new_password);
    if (err) return c.json({ error: err.message, code: err.error }, 400);
    return c.json({ ok: true });
  });

  // ---------------- Configuración ----------------

  const api = new Hono<Env>();
  api.use("*", requireSession);
  api.use("*", async (c, next) => {
    if (c.get("session").must_change_password) {
      return c.json({ error: "Debes cambiar la contraseña antes de continuar.", code: "cambiar_contrasena" }, 403);
    }
    return next();
  });
  api.onError((err, c) => configError(c, err));

  const confirmFlag = (c: Ctx) => c.req.query("confirm") === "1";

  async function finishDelete(c: Ctx, r: DeleteResult) {
    if (!r.deleted) {
      return c.json(
        {
          error:
            r.games.length === 1
              ? "Hay 1 encuentro futuro afectado. Confirma para cancelarlo y avisar a sus jugadores."
              : `Hay ${r.games.length} encuentros futuros afectados. Confirma para cancelarlos y avisar a sus jugadores.`,
          code: "requiere_confirmacion",
          games: r.games,
        },
        409,
      );
    }
    await sendNotices(c, r.notices, today(c), options);
    return c.json({ deleted: true, cancelled_games: r.cancelled_games });
  }

  api.get("/meta", (c) => c.json({ surfaces: SURFACES }));

  api.get("/venues", async (c) => c.json(await listVenues(c.env.DB)));
  api.post("/venues", async (c) => c.json(await createVenue(c.env.DB, await readJson(c)), 201));
  api.get("/venues/:id", async (c) => c.json(await getVenue(c.env.DB, c.req.param("id"))));
  api.put("/venues/:id", async (c) => c.json(await updateVenue(c.env.DB, c.req.param("id"), await readJson(c))));
  api.delete("/venues/:id", async (c) =>
    finishDelete(c, await deleteVenue(c.env.DB, c.req.param("id"), confirmFlag(c), today(c))),
  );

  api.get("/sports", async (c) => c.json(await listSports(c.env.DB, c.req.query("venue_id") ?? "")));
  api.post("/sports", async (c) => {
    const body = await readJson(c);
    return c.json(await createSport(c.env.DB, String(body.venue_id ?? ""), body), 201);
  });
  api.get("/sports/:id", async (c) => c.json(await getSport(c.env.DB, c.req.param("id"))));
  api.put("/sports/:id", async (c) => c.json(await updateSport(c.env.DB, c.req.param("id"), await readJson(c))));
  api.delete("/sports/:id", async (c) =>
    finishDelete(c, await deleteSport(c.env.DB, c.req.param("id"), confirmFlag(c), today(c))),
  );

  api.get("/courts", async (c) => c.json(await listCourts(c.env.DB, c.req.query("sport_id") ?? "")));
  api.post("/courts", async (c) => {
    const body = await readJson(c);
    return c.json(await createCourt(c.env.DB, String(body.sport_id ?? ""), body), 201);
  });
  api.get("/courts/:id", async (c) => c.json(await getCourt(c.env.DB, c.req.param("id"))));
  api.put("/courts/:id", async (c) =>
    c.json(await updateCourt(c.env.DB, c.req.param("id"), await readJson(c), today(c))),
  );
  api.delete("/courts/:id", async (c) =>
    finishDelete(c, await deleteCourt(c.env.DB, c.req.param("id"), confirmFlag(c), today(c))),
  );

  // Bloqueos de una cancha
  api.get("/courts/:id/blocks", async (c) => c.json(await listBlocks(c.env.DB, c.req.param("id"), today(c))));
  api.post("/courts/:id/blocks", async (c) => {
    const r = await createBlock(c.env.DB, c.req.param("id"), await readJson(c), confirmFlag(c), today(c));
    if (!r.created) {
      return c.json(
        {
          error:
            r.games.length === 1
              ? "Hay 1 encuentro confirmado en ese horario. Confirma para cancelarlo y bloquear."
              : `Hay ${r.games.length} encuentros confirmados en ese horario. Confirma para cancelarlos y bloquear.`,
          code: "requiere_confirmacion",
          games: r.games,
        },
        409,
      );
    }
    await sendNotices(c, r.notices, today(c), options);
    return c.json({ block: r.block, cancelled_games: r.cancelled_games }, 201);
  });
  api.delete("/blocks/:id", async (c) => {
    await deleteBlock(c.env.DB, c.req.param("id"));
    return c.json({ deleted: true });
  });

  api.get("/games", async (c) => c.json(await listGames(c.env.DB, today(c), c.req.query("from"))));
  api.post("/games/:id/cancel", async (c) => {
    const notices = await cancelGame(c.env.DB, c.req.param("id"));
    await sendNotices(c, notices, today(c), options);
    return c.json({ cancelled: true });
  });

  api.notFound((c) => c.json({ error: "No encontrado" }, 404));
  app.route("/api", api);
  return app;
}
