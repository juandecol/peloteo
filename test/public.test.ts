import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/index.ts";
import { sportKey } from "../src/lib/public.ts";
import { emptyGamesDb, TestDb } from "./helpers/db.ts";

// Lunes 16 de noviembre de 2026, 10:00 en Santiago (UTC-3).
const START = new Date("2026-11-16T13:00:00Z");
const DAY = "2026-11-17";

function world(db: TestDb = emptyGamesDb()) {
  let now = START;
  const app = createApp({ now: () => now });
  const env = { DB: db };
  /** Un navegador con su propia cookie de visitante. */
  function browser() {
    let cookie = "";
    async function req(method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
      const res = await app.request(
        path,
        {
          method,
          headers: {
            ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
            ...(cookie ? { Cookie: cookie } : {}),
            ...headers,
          },
          body: body !== undefined ? JSON.stringify(body) : undefined,
        },
        env,
      );
      const set = res.headers.get("Set-Cookie");
      if (set) cookie = set.split(";")[0]!;
      const text = await res.text();
      let json: any;
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
      return { status: res.status, json, setCookie: set };
    }
    return {
      req,
      get cookie() {
        return cookie;
      },
      set cookie(v: string) {
        cookie = v;
      },
    };
  }
  return {
    db,
    browser,
    at(iso: string) {
      now = new Date(iso);
    },
  };
}

const player = (initials: string, level = 3, extra: Record<string, unknown> = {}) => ({
  initials,
  level,
  email: initials.toLowerCase() + "@example.com",
  ...extra,
});

const openTenis = (initials = "MT", extra: Record<string, unknown> = {}) => ({
  sport_id: "D-TEN01",
  date: DAY,
  time: "18:00",
  accepted_levels: [2, 3, 4],
  player: player(initials, 3, { whatsapp: "+56 9 1111 2222" }),
  ...extra,
});

// ---------------------------------------------------------------
// Cookie de visitante
// ---------------------------------------------------------------

test("visitante: la primera visita recibe una cookie aleatoria HttpOnly, Secure, SameSite=Lax y de larga duración", async () => {
  const w = world();
  const a = w.browser();
  const r = await a.req("GET", "/api/sports");
  assert.equal(r.status, 200);
  const c = r.setCookie!;
  assert.match(c, /^visitor_id=V-[0-9a-f]{32};/);
  assert.match(c, /HttpOnly/);
  assert.match(c, /Secure/);
  assert.match(c, /SameSite=Lax/);
  assert.match(c, /Path=\//);
  assert.match(c, /Max-Age=34560000/);
  // En las visitas siguientes no se reemplaza.
  assert.equal((await a.req("GET", "/api/sports")).setCookie, null);
  // Otro navegador recibe otra.
  const b = w.browser();
  await b.req("GET", "/api/sports");
  assert.notEqual(a.cookie, b.cookie);
  // Una cookie inválida se reemplaza.
  b.cookie = "visitor_id=V-DEMO1";
  assert.match((await b.req("GET", "/api/sports")).setCookie!, /^visitor_id=V-[0-9a-f]{32};/);
});

// ---------------------------------------------------------------
// Deportes y lugares
// ---------------------------------------------------------------

test("deportes: se agrupan por nombre normalizado (sin tildes ni mayúsculas)", async () => {
  assert.equal(sportKey("  Pádel  Playa "), "padel playa");
  const w = world();
  w.db.exec(`INSERT INTO sports (id, venue_id, name, match_sizes) VALUES ('D-PAD02', 'L-AR002', 'PADEL', '4');
             INSERT INTO courts (id, sport_id, venue_id, name, open_time, close_time, slot_minutes)
             VALUES ('C-PA2AR', 'D-PAD02', 'L-AR002', 'Cancha P', '08:00', '20:00', 90);`);
  const r = (await w.browser().req("GET", "/api/sports")).json;
  assert.deepEqual(r, [
    { key: "padel", name: "Pádel", venues: 2, courts: 3 },
    { key: "tenis", name: "Tenis", venues: 2, courts: 3 }, // la cancha 3 está en mantención
  ]);
});

test("deportes: sin canchas operativas o eliminados no aparecen", async () => {
  const w = world();
  w.db.exec("UPDATE courts SET status = 'cerrada' WHERE sport_id = 'D-PAD01'");
  w.db.exec("UPDATE venues SET deleted_at = '2026-11-01T00:00:00Z' WHERE id = 'L-AR002'");
  const r = (await w.browser().req("GET", "/api/sports")).json;
  assert.deepEqual(r, [{ key: "tenis", name: "Tenis", venues: 1, courts: 2 }]);
});

test("lugares: los que ofrecen un deporte, con categorías, cantidades y partidos abiertos", async () => {
  const w = world();
  const a = w.browser();
  await a.req("POST", "/api/games", openTenis());
  const r = (await a.req("GET", "/api/venues?sport=Tenis")).json;
  assert.deepEqual(r.map((x: any) => [x.venue.name, x.sport.id, x.courts, x.open_games]), [
    ["Club Los Aromos (ejemplo)", "D-TEN02", 1, 0],
    ["Country Club Santa Martina", "D-TEN01", 2, 1],
  ]);
  assert.deepEqual(r[1].sport.match_sizes, [2]);
  assert.deepEqual(r[1].sport.categories[0], { level: 1, label: "Estoy entrenando para Wimbledon" });
  const padel = (await a.req("GET", "/api/sports/D-PAD01")).json;
  assert.deepEqual(padel.match_sizes, [2, 4]);
  assert.equal((await a.req("GET", "/api/sports/D-NOPE")).status, 404);
});

// ---------------------------------------------------------------
// Disponibilidad
// ---------------------------------------------------------------

test("disponibilidad: resumen del mes y turnos del día", async () => {
  const w = world();
  const a = w.browser();
  const today = (await a.req("GET", "/api/today")).json;
  assert.deepEqual(today, { date: "2026-11-16", minutes: 600, last_bookable: "2026-12-01" });
  const month = (await a.req("GET", "/api/availability?sport_id=D-TEN01&month=2026-11")).json;
  assert.equal(month.days[0].date, "2026-11-16");
  const day = (await a.req("GET", `/api/availability?sport_id=D-TEN01&date=${DAY}`)).json;
  assert.equal(day.slots.length, 13);
  assert.equal((await a.req("GET", "/api/availability?sport_id=D-TEN01")).status, 400);
  assert.equal((await a.req("GET", "/api/availability?sport_id=D-TEN01&date=2026-02-30")).status, 400);
});

// ---------------------------------------------------------------
// Abrir, unirse, confirmación y privacidad
// ---------------------------------------------------------------

test("flujo: abrir, otro jugador se une, se asigna cancha y ambos ven el contacto del otro", async () => {
  const w = world();
  const a = w.browser();
  const b = w.browser();
  const c = w.browser();

  const opened = await a.req("POST", "/api/games", openTenis("MT"));
  assert.equal(opened.status, 201, JSON.stringify(opened.json));
  const g = opened.json.game;
  assert.equal(g.status, "abierto");
  assert.equal(g.court, null);
  assert.deepEqual(g.accepted_levels, [2, 3, 4]);
  assert.deepEqual(g.players, [{ initials: "MT", level: 3, me: true }]); // sin contacto mientras está abierto
  assert.equal(g.can_cancel, true);

  // Un tercero ve el partido en el día y en la búsqueda, solo con iniciales y nivel.
  const day = (await c.req("GET", `/api/availability?sport_id=D-TEN01&date=${DAY}`)).json;
  const slot = day.slots.find((s: any) => s.time === "18:00");
  assert.equal(slot.open_games[0].id, g.id);
  assert.equal(slot.open_games[0].mine, false);
  const found = (await c.req("GET", "/api/search?sport_id=D-TEN01&level=4")).json;
  assert.deepEqual(found.map((x: any) => x.id), [g.id]);
  for (const text of [JSON.stringify(day), JSON.stringify(found)]) {
    assert.ok(!text.includes("example.com"));
    assert.ok(!text.includes("1111"));
  }
  // Para quien lo abrió, aparece como propio y no en su búsqueda.
  const mineDay = (await a.req("GET", `/api/availability?sport_id=D-TEN01&date=${DAY}`)).json;
  assert.equal(mineDay.slots.find((s: any) => s.time === "18:00").open_games[0].mine, true);
  assert.deepEqual((await a.req("GET", "/api/search?sport_id=D-TEN01&level=3")).json, []);

  // B se une: se completa, se asigna la cancha y B ve el contacto de A.
  const joined = await b.req("POST", `/api/games/${g.id}/join`, { player: player("RS", 4) });
  assert.equal(joined.status, 200, JSON.stringify(joined.json));
  const jg = joined.json.game;
  assert.equal(jg.status, "confirmado");
  assert.equal(jg.court.name, "Cancha 1");
  assert.deepEqual(jg.players, [
    { initials: "MT", level: 3, me: false, email: "mt@example.com", whatsapp: "+56911112222" },
    { initials: "RS", level: 4, me: true, email: "rs@example.com", whatsapp: null },
  ]);

  // A también ve el contacto de B en Mis partidos.
  const mineA = (await a.req("GET", "/api/me/games")).json;
  assert.equal(mineA.length, 1);
  assert.equal(mineA[0].players[1].email, "rs@example.com");
  // C no ve nada: no comparte el encuentro.
  assert.deepEqual((await c.req("GET", "/api/me/games")).json, []);
  // Ya no aparece en la búsqueda: está completo.
  assert.deepEqual((await c.req("GET", "/api/search?sport_id=D-TEN01&level=3")).json, []);
});

test("flujo: pádel de 4 con niveles aceptados; un nivel fuera del rango no puede unirse", async () => {
  const w = world();
  const [a, b, c] = [w.browser(), w.browser(), w.browser()];
  const g = (await a.req("POST", "/api/games", {
    sport_id: "D-PAD01", date: DAY, time: "18:30", capacity: 4, accepted_levels: [3], player: player("AA", 3),
  })).json.game;
  assert.equal(g.capacity, 4);
  assert.equal(g.missing, 3);
  const bad = await b.req("POST", `/api/games/${g.id}/join`, { player: player("BB", 2) });
  assert.equal(bad.status, 400);
  assert.equal(bad.json.code, "nivel_no_aceptado");
  // La búsqueda de un nivel 2 no lo muestra; la de un nivel 3 sí.
  assert.deepEqual((await b.req("GET", "/api/search?sport_id=D-PAD01&level=2")).json, []);
  assert.equal((await c.req("GET", "/api/search?sport_id=D-PAD01&level=3")).json.length, 1);
});

test("errores: datos inválidos, turno ocupado, ya inscrito y partido completo", async () => {
  const w = world();
  const [a, b, c, d] = [w.browser(), w.browser(), w.browser(), w.browser()];
  const invalid = await a.req("POST", "/api/games", openTenis("M"));
  assert.equal(invalid.status, 400);
  assert.equal(invalid.json.field, "initials");
  assert.equal(invalid.json.error, "Escribe tus iniciales (2 a 4 letras).");

  const g = (await a.req("POST", "/api/games", openTenis())).json.game;
  const again = await a.req("POST", `/api/games/${g.id}/join`, { player: player("MT") });
  assert.equal(again.status, 409);
  assert.equal(again.json.code, "ya_inscrito");
  await b.req("POST", `/api/games/${g.id}/join`, { player: player("RS") });
  const full = await c.req("POST", `/api/games/${g.id}/join`, { player: player("CC") });
  assert.equal(full.status, 409);
  assert.equal(full.json.code, "encuentro_completo");

  // Con las dos canchas confirmadas, no se puede abrir otro partido a esa hora.
  const g2 = (await c.req("POST", "/api/games", openTenis("CC"))).json.game;
  await d.req("POST", `/api/games/${g2.id}/join`, { player: player("DD") });
  const busy = await w.browser().req("POST", "/api/games", openTenis("EE"));
  assert.equal(busy.status, 409);
  assert.equal(busy.json.code, "turno_ocupado");
  assert.equal((await a.req("POST", "/api/games/E-NOPE1/join", { player: player("ZZ") })).status, 404);
});

test("CSRF: los POST públicos exigen JSON", async () => {
  const w = world();
  const r = await w.browser().req("POST", "/api/games", undefined, { "Content-Type": "text/plain" });
  assert.equal(r.status, 415);
});

// ---------------------------------------------------------------
// Mis partidos y cancelación
// ---------------------------------------------------------------

test("Mis partidos: cancelar el cupo hasta 1 hora antes; después la opción no está disponible", async () => {
  const w = world();
  const [a, b] = [w.browser(), w.browser()];
  const g = (await a.req("POST", "/api/games", openTenis())).json.game;
  await b.req("POST", `/api/games/${g.id}/join`, { player: player("RS") });

  // 17:01 del martes: faltan 59 minutos.
  w.at("2026-11-17T20:01:00Z");
  const late = (await b.req("GET", "/api/me/games")).json;
  assert.equal(late[0].can_cancel, false);
  const refused = await b.req("POST", `/api/games/${g.id}/cancel`, {});
  assert.equal(refused.status, 400);
  assert.equal(refused.json.code, "cancelacion_cerrada");

  // 16:59: todavía se puede.
  w.at("2026-11-17T19:59:00Z");
  assert.equal((await b.req("GET", "/api/me/games")).json[0].can_cancel, true);
  const ok = await b.req("POST", `/api/games/${g.id}/cancel`, {});
  assert.deepEqual(ok.json, { cancelled: true, game_deleted: false });
  assert.deepEqual((await b.req("GET", "/api/me/games")).json, []);
  // A vuelve a tener el partido abierto y sin cancha, sin contactos.
  const mine = (await a.req("GET", "/api/me/games")).json[0];
  assert.equal(mine.status, "abierto");
  assert.equal(mine.court, null);
  assert.equal(mine.players.length, 1);
  assert.equal(mine.players[0].email, undefined);
});

test("Mis partidos: muestra los cancelados por el administrador, sin opción de cancelar", async () => {
  const w = world();
  const a = w.browser();
  const g = (await a.req("POST", "/api/games", openTenis())).json.game;
  w.db.exec(`UPDATE games SET status = 'cancelado' WHERE id = '${g.id}'`);
  const mine = (await a.req("GET", "/api/me/games")).json;
  assert.equal(mine[0].status, "cancelado");
  assert.equal(mine[0].can_cancel, false);
  assert.equal((await a.req("POST", `/api/games/${g.id}/cancel`, {})).status, 409);
});

test("Mis partidos: no se puede cancelar el cupo de otro", async () => {
  const w = world();
  const [a, b] = [w.browser(), w.browser()];
  const g = (await a.req("POST", "/api/games", openTenis())).json.game;
  const r = await b.req("POST", `/api/games/${g.id}/cancel`, {});
  assert.equal(r.status, 404);
  assert.equal((await a.req("GET", "/api/me/games")).json.length, 1);
});
