import { Hono } from "hono";

// Punto de entrada del Worker. Las rutas de la aplicación se agregan
// en las etapas siguientes (ver CLAUDE.md).
const app = new Hono<{ Bindings: Env }>();

// Verificación de la etapa 1: el Worker responde y D1 tiene el esquema cargado.
app.get("/api/health", async (c) => {
  const tables = ["venues", "sports", "courts", "games", "players"] as const;
  const counts: Record<string, number> = {};
  for (const t of tables) {
    const row = await c.env.DB.prepare(`SELECT count(*) AS n FROM ${t}`).first<{ n: number }>();
    counts[t] = row?.n ?? 0;
  }
  return c.json({ ok: true, counts });
});

app.notFound((c) => c.json({ error: "No encontrado" }, 404));

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: "Error interno" }, 500);
});

export default app;
