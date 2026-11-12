import { Hono } from "hono";
import { adminRoutes, type AppBindings, type AppOptions } from "./admin.ts";

// Punto de entrada del Worker. createApp() permite inyectar un reloj en las pruebas.
export function createApp(options: AppOptions = {}) {
  const app = new Hono<{ Bindings: AppBindings }>();

  // Verificación: el Worker responde y D1 tiene el esquema cargado.
  app.get("/api/health", async (c) => {
    const tables = ["venues", "sports", "courts", "games", "players"] as const;
    const counts: Record<string, number> = {};
    for (const t of tables) {
      const row = await c.env.DB.prepare(`SELECT count(*) AS n FROM ${t}`).first<{ n: number }>();
      counts[t] = row?.n ?? 0;
    }
    return c.json({ ok: true, counts });
  });

  app.route("/admin", adminRoutes(options));

  // Pantallas de configuración (archivos estáticos en public/admin/).
  app.get("/admin", (c) => c.redirect("/admin/", 301));
  app.get("/admin/*", async (c) => {
    if (c.req.path.startsWith("/admin/api/") || !c.env.ASSETS) return c.json({ error: "No encontrado" }, 404);
    const res = await c.env.ASSETS.fetch(c.req.raw);
    const out = new Response(res.body, res);
    out.headers.set("Cache-Control", "no-store");
    out.headers.set("X-Frame-Options", "DENY");
    out.headers.set("Referrer-Policy", "same-origin");
    return out;
  });

  app.notFound((c) => c.json({ error: "No encontrado" }, 404));

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "Error interno" }, 500);
  });

  return app;
}

export default createApp();
