// Envío de avisos desde las rutas: elige los canales según el entorno y, en
// Cloudflare, termina de enviarlos después de responder (waitUntil).
//
// - En producción (EMAIL_MODE = "resend" y secret RESEND_API_KEY): correo real.
// - En local (localhost), con EMAIL_MODE = "consola" o sin la clave: el correo
//   se muestra en la consola y no se envía.
// - Sin EMAIL_MODE (pruebas): solo el registro en el log.

import type { AppBindings, AppOptions } from "./admin.ts";
import { consoleChannel, resendChannel, type MailConfig } from "./lib/email.ts";
import { deliverNotices, logChannel, type Channel, type PendingNotice } from "./lib/notify.ts";
import type { LocalNow } from "./lib/time.ts";

export const DEFAULT_SITE = "https://peloteo.cl";
export const DEFAULT_FROM = "Peloteo <avisos@peloteo.cl>";

function isLocalHost(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host.endsWith(".localhost");
}

export function channelsFor(env: AppBindings, requestUrl: string): Channel[] {
  const mode = env.EMAIL_MODE;
  if (!mode || mode === "ninguno") return [logChannel];
  const local = isLocalHost(requestUrl);
  const config: MailConfig = {
    // En local los enlaces apuntan al servidor de desarrollo.
    site: local ? new URL(requestUrl).origin : (env.SITE_URL ?? DEFAULT_SITE).replace(/\/+$/, ""),
    from: env.MAIL_FROM ?? DEFAULT_FROM,
  };
  if (local || mode === "consola" || !env.RESEND_API_KEY) {
    if (!local && mode === "resend") console.error("Falta el secret RESEND_API_KEY: los correos no se envían.");
    return [logChannel, consoleChannel(config)];
  }
  return [logChannel, resendChannel(env.RESEND_API_KEY, config)];
}

/** Envía los avisos. Si hay ExecutionContext, después de responder; si no, espera. */
export async function sendNotices(
  c: { env: AppBindings; req: { url: string }; readonly executionCtx: { waitUntil(p: Promise<unknown>): void } },
  notices: PendingNotice[],
  now: LocalNow,
  options: AppOptions = {},
): Promise<void> {
  if (notices.every((n) => n.player_ids.length === 0)) return;
  const channels = options.channels ?? channelsFor(c.env, c.req.url);
  const work = deliverNotices(c.env.DB, notices, { channels, now }).then(
    () => undefined,
    (err) => console.error("Error al enviar avisos:", err),
  );
  let ctx: { waitUntil(p: Promise<unknown>): void } | undefined;
  try {
    ctx = c.executionCtx;
  } catch {
    ctx = undefined; // pruebas: no hay ExecutionContext
  }
  if (ctx) ctx.waitUntil(work);
  else await work;
}
