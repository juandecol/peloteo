// Sitio en español e inglés: mensajes de error, nombres de deportes, idioma de
// cada cupo y correos en el idioma de cada jugador.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createApp } from "../src/index.ts";
import { renderEmail } from "../src/lib/email.ts";
import { ERRORS_EN, levelsTextEn, sportNameIn, translateError } from "../src/lib/i18n.ts";
import type { Channel, NoticeEvent, NoticeGame, NoticePlayer } from "../src/lib/notify.ts";
import { emptyGamesDb, TestDb } from "./helpers/db.ts";

const START = new Date("2026-11-16T13:00:00Z"); // lunes 16, 10:00 en Santiago
const DAY = "2026-11-17";
const SITE = "https://peloteo.cl";

// ---------------------------------------------------------------
// Traducciones
// ---------------------------------------------------------------

test("idioma: todo mensaje de error fijo de la API pública tiene su versión en inglés", () => {
  const files = ["src/lib/matching.ts", "src/public.ts", "src/lib/accounts.ts"];
  const missing: string[] = [];
  for (const f of files) {
    const src = readFileSync(f, "utf8");
    const re = /(?:MatchError\(\s*"[^"]+",\s*|AccountError\(\s*"[^"]+",\s*|error:\s*)"([^"]+)"/g;
    for (const m of src.matchAll(re)) if (!ERRORS_EN[m[1]!]) missing.push(`${f}: ${m[1]}`);
  }
  assert.deepEqual(missing, []);
});

test("idioma: los mensajes con datos variables también se traducen", () => {
  assert.equal(translateError("Solo se puede agendar hasta el 2026-12-01.", "en"), "You can only book until 2026-12-01.");
  assert.equal(translateError("Este partido busca jugadores de niveles 2, 3 y 4.", "en"), "This match is looking for players of levels 2, 3 and 4.");
  assert.equal(translateError("Este partido busca jugadores de nivel 1.", "en"), "This match is looking for players of level 1.");
  assert.equal(levelsTextEn("todos los niveles"), "all levels");
  // En español no cambia, y un mensaje desconocido queda tal cual.
  assert.equal(translateError("Ese partido ya no existe.", "es"), "Ese partido ya no existe.");
  assert.equal(translateError("Algo nuevo.", "en"), "Algo nuevo.");
});

test("idioma: nombres de deportes conocidos en inglés, sin importar tildes ni mayúsculas", () => {
  assert.equal(sportNameIn("Tenis", "en"), "Tennis");
  assert.equal(sportNameIn("PÁDEL", "en"), "Padel");
  assert.equal(sportNameIn("Fútbol 7", "en"), "7-a-side football");
  assert.equal(sportNameIn("Bochas", "en"), "Bochas");
  assert.equal(sportNameIn("Tenis", "es"), "Tenis");
});

// ---------------------------------------------------------------
// API: errores en el idioma de la cookie y cupos con su idioma
// ---------------------------------------------------------------

function world(db: TestDb = emptyGamesDb()) {
  const sent: { event: NoticeEvent; player: NoticePlayer; game: NoticeGame }[] = [];
  const capture: Channel = {
    name: "captura",
    async send(event, player, game) {
      sent.push({ event, player: structuredClone(player), game: structuredClone(game) });
    },
  };
  const app = createApp({ now: () => START, channels: [capture] });
  function browser(lang?: string) {
    let cookie = "";
    return async (method: string, path: string, body?: unknown) => {
      const cookies = [cookie, lang ? `peloteo_lang=${lang}` : ""].filter(Boolean).join("; ");
      const res = await app.request(
        path,
        {
          method,
          headers: { "Content-Type": "application/json", ...(cookies ? { Cookie: cookies } : {}) },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        },
        { DB: db },
      );
      const set = res.headers.get("Set-Cookie");
      if (set) cookie = set.split(";")[0]!;
      return { status: res.status, json: (await res.json()) as any };
    };
  }
  return { db, sent, browser };
}

const player = (initials: string, extra: Record<string, unknown> = {}) => ({
  initials,
  level: 3,
  email: initials.toLowerCase() + "@example.com",
  ...extra,
});
const openTenis = (initials: string, extra: Record<string, unknown> = {}) => ({
  sport_id: "D-TEN01",
  capacity: 2,
  date: DAY,
  time: "18:00",
  accepted_levels: [2, 3, 4],
  player: player(initials, extra),
});

test("idioma: con la cookie peloteo_lang=en los errores llegan en inglés, con el mismo código y campo", async () => {
  const w = world();
  const en = await w.browser("en")("POST", "/api/games", openTenis("X"));
  assert.equal(en.status, 400);
  assert.deepEqual(en.json, { error: "Enter your initials (2 to 4 letters).", code: "datos_invalidos", field: "initials" });
  const es = await w.browser()("POST", "/api/games", openTenis("X"));
  assert.equal(es.json.error, "Escribe tus iniciales (2 a 4 letras).");
  // También los errores armados directamente en las rutas.
  assert.equal((await w.browser("en")("GET", "/api/sports/D-NOPE")).json.error, "That sport is no longer available.");
  // Un valor desconocido de la cookie se trata como español.
  assert.equal((await w.browser("fr")("POST", "/api/games", openTenis("X"))).json.error, "Escribe tus iniciales (2 a 4 letras).");
});

test("idioma: cada cupo guarda su idioma y cada jugador recibe el correo en el suyo", async () => {
  const w = world();
  const g = (await w.browser("en")("POST", "/api/games", openTenis("EN", { lang: "en" }))).json.game;
  await w.browser()("POST", `/api/games/${g.id}/join`, { player: player("ES") }); // sin lang: español
  assert.deepEqual(
    w.db.raw.prepare("SELECT initials, lang FROM players ORDER BY rowid").all().map((r) => ({ ...r })),
    [
      { initials: "EN", lang: "en" },
      { initials: "ES", lang: "es" },
    ],
  );
  const confirmed = w.sent.filter((s) => s.event === "partido_confirmado");
  const mail = (initials: string) => {
    const s = confirmed.find((x) => x.player.initials === initials)!;
    return renderEmail(s.event, s.player, s.game, SITE);
  };
  const en = mail("EN");
  assert.equal(en.subject, "Match confirmed: Tennis, Tuesday, November 17 at 18:00");
  assert.match(en.text, /Your partners' contact details/i);
  assert.match(en.text, /ES \(level 3\): es@example\.com/);
  assert.match(en.html, /<html lang="en">/);
  const es = mail("ES");
  assert.equal(es.subject, "Partido confirmado: Tenis, martes 17 de noviembre a las 18:00");
  assert.match(es.text, /EN \(nivel 3\): en@example\.com/);
});

test("idioma: todos los avisos tienen versión en inglés, sin restos en español", async () => {
  const w = world();
  const g = (await w.browser("en")("POST", "/api/games", openTenis("EN", { lang: "en" }))).json.game;
  const s = w.sent[0]!;
  const events: NoticeEvent[] = ["partido_publicado", "jugador_se_sumo", "partido_confirmado", "partido_sin_cancha", "cupo_cancelado", "encuentro_cancelado"];
  for (const ev of events) {
    const m = renderEmail(ev, s.player, { ...s.game, court_mode: "coordinacion", cause: "bloqueo" }, SITE);
    const text = m.text.replace(/https?:\/\/\S+/g, ""); // los enlaces (#mis-partidos) no cuentan
    for (const word of ["partido", "cancha", "jugador", "cupo", "nivel"]) {
      assert.ok(!text.toLowerCase().includes(word), `${ev}: "${word}" en ${m.text}`);
    }
  }
  assert.ok(g.id);
});

// ---------------------------------------------------------------
// Categorías en inglés y migración 0011
// ---------------------------------------------------------------

test("migración 0011: cupos en español por defecto, idioma solo es o en, y categorías traducidas", () => {
  const db = new TestDb();
  assert.equal(db.count("SELECT count(*) AS n FROM players WHERE lang <> 'es'"), 0);
  assert.throws(() => db.exec("UPDATE players SET lang = 'fr'"), /CHECK constraint failed/);
  assert.equal(
    db.get<{ label_en: string }>("SELECT label_en FROM categories WHERE sport_id = 'D-TEN01' AND level = 1")!.label_en,
    "Training for Wimbledon",
  );
  assert.equal(db.count("SELECT count(*) AS n FROM categories WHERE label_en IS NULL"), 0);
});

test("categorías: el texto en inglés se guarda desde el admin y llega al sitio", async () => {
  const db = emptyGamesDb();
  db.exec("UPDATE categories SET label_en = NULL WHERE sport_id = 'D-TEN01'");
  const { updateSport } = await import("../src/lib/config.ts");
  const { listVenuesForSport } = await import("../src/lib/public.ts");
  const { localNow } = await import("../src/lib/time.ts");
  const s = await updateSport(db, "D-TEN01", {
    name: "Tenis",
    match_sizes: [2, 4],
    categories: ["Pro", "", "Medio"],
    categories_en: ["Pro player", "ignored: no Spanish text", "  "],
  });
  assert.deepEqual(s.categories_en, ["Pro player", "", "", "", ""]);
  const offer = (await listVenuesForSport(db, "tenis", localNow(START))).find((o) => o.sport.id === "D-TEN01")!;
  assert.deepEqual(offer.sport.categories, [
    { level: 1, label: "Pro", label_en: "Pro player" },
    { level: 3, label: "Medio", label_en: null },
  ]);
});
