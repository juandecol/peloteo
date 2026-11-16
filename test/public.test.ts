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
  rama: "femenina",
  intent: "salud",
  terms: true,
  ...extra,
});

const openTenis = (initials = "MT", extra: Record<string, unknown> = {}) => ({
  sport_id: "D-TEN01",
  capacity: 2, // tenis admite singles (2) o dobles (4): migración 0008
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
  assert.deepEqual(r[1].sport.match_sizes, [2, 4]); // tenis: singles o dobles (0008)
  assert.deepEqual(r[1].sport.categories[0], { level: 1, label: "Estoy entrenando para Wimbledon", label_en: "Training for Wimbledon" });
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
  // Sin COURT_MODE en el entorno, el modo es "reserva".
  const { sport_names_en, ...rest } = today;
  assert.deepEqual(rest, { date: "2026-11-16", minutes: 600, last_bookable: "2026-12-01", court_mode: "reserva", whatsapp_contact: false });
  assert.equal(sport_names_en.tenis, "Tennis");
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
  w.db.exec("UPDATE settings SET value = '1' WHERE key = 'whatsapp_contact'"); // pedir WhatsApp (Configuración › Opciones)
  const a = w.browser();
  const b = w.browser();
  const c = w.browser();

  const opened = await a.req("POST", "/api/games", openTenis("MT"));
  assert.equal(opened.status, 201, JSON.stringify(opened.json));
  const g = opened.json.game;
  assert.equal(g.status, "abierto");
  assert.equal(g.court, null);
  assert.deepEqual(g.accepted_levels, [2, 3, 4]);
  assert.deepEqual(g.players, [{ initials: "MT", level: 3, rama: "femenina", intent: "salud", me: true }]); // sin contacto mientras está abierto
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
    { initials: "MT", level: 3, rama: "femenina", intent: "salud", me: false, email: "mt@example.com", whatsapp: "+56911112222" },
    { initials: "RS", level: 4, rama: "femenina", intent: "salud", me: true, email: "rs@example.com", whatsapp: null },
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

// ---------------------------------------------------------------
// Inicio: partidos que buscan jugadores en los próximos 8 días (AM/PM)
// ---------------------------------------------------------------

test("inicio: resumen de 8 días con AM y PM; cuenta los propios, no los completos", async () => {
  const w = world();
  const a = w.browser();
  const b = w.browser();
  const tenis = (await a.req("POST", "/api/games", openTenis("MT"))).json.game; // martes 18:00 (PM)
  await a.req("POST", "/api/games", { ...openTenis("MT"), sport_id: "D-PAD01", time: "09:30", capacity: 4 }); // martes 09:30 (AM)

  const seen = (await b.req("GET", "/api/open")).json;
  assert.equal(seen.length, 8);
  assert.equal(seen[0].date, "2026-11-16"); // hoy incluido
  assert.equal(seen[7].date, "2026-11-23");
  assert.deepEqual(seen[1], { date: DAY, am: 1, pm: 1, am_room: true, pm_room: true });
  assert.ok(seen.filter((d: any) => d.date !== DAY).every((d: any) => d.am === 0 && d.pm === 0));
  // Quien abrió también ve sus propios partidos en naranjo (2026-11-15).
  assert.deepEqual((await a.req("GET", "/api/open")).json[1], { date: DAY, am: 1, pm: 1, am_room: true, pm_room: true });

  // Al completarse, el partido de tenis deja de buscar jugadores.
  await b.req("POST", `/api/games/${tenis.id}/join`, { player: player("RS") });
  assert.deepEqual((await w.browser().req("GET", "/api/open")).json[1], { date: DAY, am: 1, pm: 0, am_room: true, pm_room: true });
});

test("inicio: lista de un bloque con deporte, lugar, hora y niveles; sin contactos", async () => {
  const w = world();
  await w.browser().req("POST", "/api/games", openTenis("MT"));
  const b = w.browser();
  const pm = await b.req("GET", `/api/open/block?date=${DAY}&half=pm`);
  assert.equal(pm.status, 200);
  assert.equal(pm.json.length, 1);
  const g = pm.json[0];
  assert.equal(g.time, "18:00");
  assert.equal(g.missing, 1);
  assert.deepEqual(g.accepted_levels, [2, 3, 4]);
  assert.deepEqual(g.sport, { id: "D-TEN01", name: "Tenis", key: "tenis" });
  assert.equal(g.venue.id, "L-SM001");
  assert.deepEqual(g.players, [{ initials: "MT", level: 3, rama: "femenina", intent: "salud" }]);
  assert.ok(!JSON.stringify(pm.json).includes("@"));
  assert.deepEqual((await b.req("GET", `/api/open/block?date=${DAY}&half=am`)).json, []);
  // Fuera de los 8 días o con datos inválidos: error.
  assert.equal((await b.req("GET", "/api/open/block?date=2026-11-24&half=am")).status, 400);
  assert.equal((await b.req("GET", "/api/open/block?date=2026-11-15&half=am")).status, 400);
  assert.equal((await b.req("GET", `/api/open/block?date=${DAY}&half=noche`)).status, 400);
});

test("inicio: un turno pasado (más de 15 minutos) ya no aparece", async () => {
  const w = world();
  await w.browser().req("POST", "/api/games", openTenis("MT"));
  const b = w.browser();
  w.at("2026-11-17T21:10:00Z"); // martes 18:10: sigue visible
  assert.equal((await b.req("GET", "/api/open")).json[0].pm, 1);
  w.at("2026-11-17T21:20:00Z"); // martes 18:20: ya no
  assert.equal((await b.req("GET", "/api/open")).json[0].pm, 0);
  assert.deepEqual((await b.req("GET", `/api/open/block?date=${DAY}&half=pm`)).json, []);
});

// ---------------------------------------------------------------
// Opciones: pedir el WhatsApp de los jugadores (Configuración)
// ---------------------------------------------------------------

test("opciones: el WhatsApp se pide solo si el administrador lo activa; si no, se ignora", async () => {
  const w = world();
  const a = w.browser();
  // Apagado por defecto: /today lo informa y el servidor descarta el número y el aviso.
  assert.equal((await a.req("GET", "/api/today")).json.whatsapp_contact, false);
  const g = (await a.req("POST", "/api/games", openTenis("MT", { player: player("MT", 3, { whatsapp: "+56 9 1111 2222", whatsapp_opt_in: true }) }))).json.game;
  assert.deepEqual(
    { ...w.db.get("SELECT whatsapp, whatsapp_opt_in FROM players WHERE game_id = ?", g.id) },
    { whatsapp: null, whatsapp_opt_in: 0 },
  );
  // Activado: se guarda.
  w.db.exec("UPDATE settings SET value = '1' WHERE key = 'whatsapp_contact'");
  assert.equal((await w.browser().req("GET", "/api/today")).json.whatsapp_contact, true);
  const b = w.browser();
  await b.req("POST", `/api/games/${g.id}/join`, { player: player("RS", 3, { whatsapp: "+56 9 3333 4444" }) });
  assert.equal(w.db.get<{ whatsapp: string }>("SELECT whatsapp FROM players WHERE initials = 'RS'")!.whatsapp, "+56933334444");
});

test("inicio: con ?sport= el resumen y la lista de un bloque muestran solo ese deporte", async () => {
  const w = world();
  await w.browser().req("POST", "/api/games", openTenis("MT")); // martes 18:00 (PM)
  await w.browser().req("POST", "/api/games", { ...openTenis("PD"), sport_id: "D-PAD01", time: "18:30", capacity: 4 }); // martes 18:30 (PM)
  const b = w.browser();
  assert.deepEqual((await b.req("GET", "/api/open")).json[1], { date: DAY, am: 0, pm: 2, am_room: true, pm_room: true });
  assert.deepEqual((await b.req("GET", "/api/open?sport=tenis")).json[1], { date: DAY, am: 0, pm: 1, am_room: true, pm_room: true });
  // Sin tildes ni mayúsculas, como el grupo de deportes.
  assert.deepEqual((await b.req("GET", "/api/open?sport=P%C3%81DEL")).json[1], { date: DAY, am: 0, pm: 1, am_room: true, pm_room: true });
  assert.deepEqual((await b.req("GET", "/api/open?sport=bochas")).json[1], { date: DAY, am: 0, pm: 0, am_room: false, pm_room: false });
  const pm = (await b.req("GET", `/api/open/block?date=${DAY}&half=pm&sport=padel`)).json;
  assert.deepEqual(pm.map((g: any) => g.sport.key), ["padel"]);
  assert.equal((await b.req("GET", `/api/open/block?date=${DAY}&half=pm`)).json.length, 2);
});

test("inicio: los partidos propios aparecen en la lista del bloque marcados como propios", async () => {
  const w = world();
  const a = w.browser();
  const g = (await a.req("POST", "/api/games", openTenis("MT"))).json.game;
  const own = (await a.req("GET", `/api/open/block?date=${DAY}&half=pm`)).json;
  assert.deepEqual(own.map((x: any) => [x.id, x.mine]), [[g.id, true]]);
  // Para otro visitante el mismo partido no es propio y puede sumarse.
  const b = w.browser();
  assert.deepEqual((await b.req("GET", `/api/open/block?date=${DAY}&half=pm`)).json.map((x: any) => x.mine), [false]);
  // Quien se sumó a un partido de 4 también lo ve como propio.
  const d = (await a.req("POST", "/api/games", { ...openTenis("MT"), time: "19:00", capacity: 4 })).json.game;
  await b.req("POST", `/api/games/${d.id}/join`, { player: player("RS") });
  const seen = (await b.req("GET", `/api/open/block?date=${DAY}&half=pm`)).json;
  assert.deepEqual(seen.map((x: any) => [x.time, x.mine]), [["18:00", false], ["19:00", true]]);
  // Sigue sin poder ocupar otro cupo en su propio partido.
  assert.equal((await a.req("POST", `/api/games/${g.id}/join`, { player: player("MT") })).json.code, "ya_inscrito");
});

test("inicio: un bloque sin partidos ni horas libres se marca sin hora (lugar cerrado o sin cupo) (2026-11-16)", async () => {
  const w = world();
  const b = w.browser();
  // Santa Martina cierra el martes; tenis sigue en Los Aromos ese día.
  w.db.exec("UPDATE venues SET hours = '08:00-22:00;08:00-22:00;;08:00-22:00;08:00-22:00;08:00-22:00;08:00-22:00' WHERE id = 'L-SM001'");
  assert.deepEqual((await b.req("GET", "/api/open?sport=tenis")).json[1], { date: DAY, am: 0, pm: 0, am_room: true, pm_room: true });
  // Pádel solo está en Santa Martina: el martes no tiene horas.
  assert.deepEqual((await b.req("GET", "/api/open?sport=padel")).json[1], { date: DAY, am: 0, pm: 0, am_room: false, pm_room: false });
  // Los Aromos abre solo en la tarde: la mañana del martes queda sin horas para tenis.
  w.db.exec("UPDATE venues SET hours = '14:00-22:00;14:00-22:00;14:00-22:00;14:00-22:00;14:00-22:00;14:00-22:00;14:00-22:00' WHERE id = 'L-AR002'");
  assert.deepEqual((await b.req("GET", "/api/open?sport=tenis")).json[1], { date: DAY, am: 0, pm: 0, am_room: false, pm_room: true });
});

test("inicio: en coordinación, una mitad del día con todos los confirmados posibles queda sin horas", async () => {
  const w = world();
  // Los Aromos: una cancha de tenis, abierta solo de 08:00 a 09:00.
  w.db.exec("UPDATE venues SET hours = '08:00-09:00;08:00-09:00;08:00-09:00;08:00-09:00;08:00-09:00;08:00-09:00;08:00-09:00' WHERE id = 'L-AR002'");
  w.db.exec("UPDATE venues SET hours = '20:00-21:00;20:00-21:00;20:00-21:00;20:00-21:00;20:00-21:00;20:00-21:00;20:00-21:00' WHERE id = 'L-SM001'");
  const { openOverview } = await import("../src/lib/public.ts");
  const { createGame, joinGame } = await import("../src/lib/matching.ts");
  const { localNow } = await import("../src/lib/time.ts");
  const now = localNow(START);
  const before = (await openOverview(w.db, "V-x", now, "tenis", "coordinacion"))[1]!;
  assert.equal(before.am_room, true);
  const g = await createGame(w.db, { sport_id: "D-TEN02", capacity: 2, date: DAY, time: "08:00", accepted_levels: [3], player: player("MT") }, "V-1", now, "coordinacion");
  // Con un partido abierto el bloque es naranjo (y aún queda hora).
  assert.deepEqual((await openOverview(w.db, "V-x", now, "tenis", "coordinacion"))[1], { date: DAY, am: 1, pm: 0, am_room: true, pm_room: true });
  await joinGame(w.db, g.game.id, player("RS"), "V-2", now, "coordinacion");
  const after = (await openOverview(w.db, "V-x", now, "tenis", "coordinacion"))[1]!;
  assert.equal(after.am, 0);
  assert.equal(after.am_room, false);
  assert.equal(after.pm_room, true);
});

test("términos y condiciones: obligatorios al abrir y al unirse; se guarda la versión aceptada (2026-11-16)", async () => {
  const w = world();
  const a = w.browser();
  const no = await a.req("POST", "/api/games", openTenis("MT", { player: player("MT", 3, { terms: false }) }));
  assert.equal(no.status, 400);
  assert.equal(no.json.field, "terms");
  assert.equal(no.json.error, "Acepta los términos y condiciones para continuar.");
  const g = (await a.req("POST", "/api/games", openTenis("MT"))).json.game;
  const b = w.browser();
  const noJoin = await b.req("POST", `/api/games/${g.id}/join`, { player: player("RS", 3, { terms: undefined }) });
  assert.equal(noJoin.status, 400);
  assert.equal(noJoin.json.field, "terms");
  // En inglés, el mensaje traducido.
  const en = await b.req("POST", `/api/games/${g.id}/join`, { player: player("RS", 3, { terms: "yes" }) }, { Cookie: "peloteo_lang=en" });
  assert.equal(en.json.error, "Accept the terms and conditions to continue.");
  assert.equal((await b.req("POST", `/api/games/${g.id}/join`, { player: player("RS") })).status, 200);
  assert.equal(w.db.count("SELECT count(*) AS n FROM players WHERE terms_accepted = '2026-11-16'"), 2);
});

test("lugares del deporte: siguen el orden del administrador y luego el alfabético (2026-11-16)", async () => {
  const w = world();
  const b = w.browser();
  const names = async () => ((await b.req("GET", "/api/venues?sport=tenis")).json as any[]).map((o) => o.venue.id);
  assert.deepEqual(await names(), ["L-AR002", "L-SM001"]); // alfabético con el mismo número
  w.db.exec("UPDATE venues SET sort_order = 3 WHERE id = 'L-AR002'");
  assert.deepEqual(await names(), ["L-SM001", "L-AR002"]);
});

test("inicio: con ?venue= el resumen y la lista de un bloque son solo de ese lugar (2026-11-16)", async () => {
  const w = world();
  await w.browser().req("POST", "/api/games", openTenis("MT")); // Santa Martina, martes 18:00
  await w.browser().req("POST", "/api/games", { ...openTenis("PD"), sport_id: "D-TEN02" }); // Los Aromos, martes 18:00
  const b = w.browser();
  assert.equal((await b.req("GET", "/api/open?sport=tenis")).json[1].pm, 2);
  assert.equal((await b.req("GET", "/api/open?sport=tenis&venue=L-AR002")).json[1].pm, 1);
  const list = (await b.req("GET", `/api/open/block?date=${DAY}&half=pm&sport=tenis&venue=L-SM001`)).json;
  assert.deepEqual(list.map((g: any) => g.venue.id), ["L-SM001"]);
  // Las horas libres también son solo de ese lugar: Los Aromos cerrado el martes deja el día gris.
  w.db.exec("UPDATE venues SET hours = '08:00-22:00;08:00-22:00;;08:00-22:00;08:00-22:00;08:00-22:00;08:00-22:00' WHERE id = 'L-AR002'");
  w.db.exec("DELETE FROM players WHERE initials = 'PD'; DELETE FROM games WHERE sport_id = 'D-TEN02'");
  assert.deepEqual((await b.req("GET", "/api/open?sport=tenis&venue=L-AR002")).json[1], { date: DAY, am: 0, pm: 0, am_room: false, pm_room: false });
  assert.equal((await b.req("GET", "/api/open?sport=tenis&venue=L-SM001")).json[1].pm_room, true);
});

test("lugares disponibles: solo visibles y con deportes; en el orden del administrador; el oculto no admite partidos nuevos (2026-11-16)", async () => {
  const w = world();
  const b = w.browser();
  const places = async () => ((await b.req("GET", "/api/places")).json as any[]);
  assert.deepEqual((await places()).map((p) => p.id), ["L-AR002", "L-SM001"]); // mismo número: alfabético
  assert.deepEqual((await places()).find((p) => p.id === "L-SM001").sports.map((s: any) => s.key), ["padel", "tenis"]);
  w.db.exec("UPDATE venues SET sort_order = 2 WHERE id = 'L-AR002'");
  w.db.exec("UPDATE sports SET sort_order = 1 WHERE id = 'D-PAD01'");
  assert.deepEqual((await places()).map((p) => p.id), ["L-SM001", "L-AR002"]);
  assert.deepEqual((await places())[0].sports.map((s: any) => s.key), ["tenis", "padel"]);

  // Un partido abierto antes de ocultar el lugar sigue su curso.
  const g = (await b.req("POST", "/api/games", openTenis("MT"))).json.game;
  w.db.exec("UPDATE venues SET visible = 0 WHERE id = 'L-SM001'");
  assert.deepEqual((await places()).map((p) => p.id), ["L-AR002"]);
  assert.deepEqual(((await b.req("GET", "/api/venues?sport=tenis")).json as any[]).map((o) => o.venue.id), ["L-AR002"]);
  assert.equal(((await b.req("GET", "/api/sports")).json as any[]).some((s) => s.key === "padel"), false);
  const no = await w.browser().req("POST", "/api/games", { ...openTenis("RS"), time: "19:00" });
  assert.equal(no.status, 404);
  assert.equal((await w.browser().req("POST", `/api/games/${g.id}/join`, { player: player("RS") })).status, 200);
});

test("partido publicado y Mis partidos indican si el lugar es un club privado (2026-11-16)", async () => {
  const w = world();
  const a = w.browser();
  assert.equal((await a.req("POST", "/api/games", openTenis("MT"))).json.game.venue.private, false);
  w.db.exec("UPDATE venues SET private = 1 WHERE id = 'L-SM001'");
  const g = (await w.browser().req("POST", "/api/games", { ...openTenis("RS"), time: "19:00" })).json.game;
  assert.equal(g.venue.private, true);
  assert.equal(g.venue.name, "Country Club Santa Martina");
  assert.ok(((await a.req("GET", "/api/me/games")).json as any[]).every((x) => x.venue.private === true));
});

test("lugares del deporte: indican si el lugar es un club privado, para el aviso del formulario (2026-11-16)", async () => {
  const w = world();
  w.db.exec("UPDATE venues SET private = 1 WHERE id = 'L-SM001'");
  const offers = (await w.browser().req("GET", "/api/venues?sport=tenis")).json as any[];
  assert.deepEqual(offers.map((o) => [o.venue.id, o.venue.private]), [["L-AR002", false], ["L-SM001", true]]);
});
