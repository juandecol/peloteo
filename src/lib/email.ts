// Correos de aviso: textos de cada evento y canales de envío.
//
// - resendChannel: envía con la API de Resend (POST https://api.resend.com/emails)
//   usando fetch, sin SDK. La clave es el secret RESEND_API_KEY de Cloudflare.
// - consoleChannel: en local muestra el correo completo en la consola en vez de
//   enviarlo.
//
// Privacidad: el contacto de los compañeros solo va en "partido confirmado".

import type { Channel, NoticeEvent, NoticeGame, NoticePlayer, SuggestedSlot } from "./notify.ts";
import { parseIntList } from "./availability.ts";
import { dayOfWeek } from "./time.ts";
import { asLang, intentLabel, ramaLabel, sportNameIn, type Lang } from "./i18n.ts";

/**
 * Aviso de responsabilidad de los partidos confirmados (2026-11-16). El mismo texto va
 * en la pantalla de confirmación y en "Mis partidos" (public/app.js).
 */
export const DISCLAIMER = {
  es: "Peloteo solo agenda el encuentro entre los jugadores. Jugar queda sujeto a la disponibilidad del lugar, y reservar la cancha es responsabilidad de los jugadores: Peloteo no se hace responsable si no encuentran dónde jugar.",
  en: "Peloteo only schedules the match between players. Playing is subject to the venue's availability, and booking the court is the players' responsibility: Peloteo is not responsible if you can't find a place to play.",
};

const RESEND_URL = "https://api.resend.com/emails";

export interface Email {
  subject: string;
  text: string;
  html: string;
}

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

/** "sábado 21 de noviembre" o, en inglés, "Saturday, November 21". */
export function fechaLarga(date: string, lang: Lang = "es"): string {
  const [, m, d] = date.split("-").map(Number);
  return lang === "en" ? `${DAYS[dayOfWeek(date)]}, ${MONTHS[m! - 1]} ${d}` : `${DIAS[dayOfWeek(date)]} ${d} de ${MESES[m! - 1]}`;
}

const faltan = (n: number, lang: Lang) =>
  lang === "en"
    ? n === 1 ? "1 player needed" : `${n} players needed`
    : n === 1 ? "falta 1 jugador" : `faltan ${n} jugadores`;

function nivelesTexto(levels: number[], lang: Lang): string {
  const y = lang === "en" ? "and" : "y";
  if (levels.length === 5) return lang === "en" ? "all levels" : "todos los niveles";
  if (levels.length === 1) return `${lang === "en" ? "level" : "nivel"} ${levels[0]}`;
  return `${lang === "en" ? "levels" : "niveles"} ${levels.slice(0, -1).join(", ")} ${y} ${levels[levels.length - 1]}`;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

/** Enlace de cancelación: el token va en el fragmento (#), que no llega a ningún servidor. */
export const cancelUrl = (site: string, token: string) => `${site}/#cancelar=${token}`;
export const mineUrl = (site: string) => `${site}/#mis-partidos`;

function waLink(whatsapp: string, text: string): string {
  return `https://wa.me/${whatsapp.replace(/\D/g, "")}?text=${encodeURIComponent(text)}`;
}

// Bloques de contenido, que se convierten a texto plano y a HTML.
type Block =
  | { p: string }
  | { kv: [string, string][] }
  | { h: string }
  | { list: { text: string; links?: [string, string][] }[] }
  | { button: [string, string] }
  | { small: string; links?: [string, string][] }
  | { panel: { title: string; text: string; buttons: PanelButton[]; note?: string } };

/** Botón de un panel: "peligro" (relleno, color arcilla) o "contorno" (verde). */
type PanelButton = { label: string; url: string; kind: "peligro" | "contorno" };

function toText(blocks: Block[]): string {
  const out: string[] = [];
  for (const b of blocks) {
    if ("p" in b) out.push(b.p);
    else if ("h" in b) out.push(b.h.toUpperCase());
    else if ("kv" in b) out.push(b.kv.map(([k, v]) => `${k}: ${v}`).join("\n"));
    else if ("list" in b)
      out.push(b.list.map((i) => `- ${i.text}${(i.links ?? []).map(([t, u]) => `\n  ${t}: ${u}`).join("")}`).join("\n"));
    else if ("button" in b) out.push(`${b.button[0]}: ${b.button[1]}`);
    else if ("small" in b) out.push(b.small + (b.links ?? []).map(([t, u]) => `\n${t}: ${u}`).join(""));
    else if ("panel" in b)
      out.push(
        [
          b.panel.title.toUpperCase(),
          b.panel.text,
          ...b.panel.buttons.map((x) => `${x.label}: ${x.url}`),
          ...(b.panel.note ? [b.panel.note] : []),
        ].join("\n"),
      );
  }
  return out.join("\n\n") + "\n";
}

const GREEN = "#1E6B4F";
const CLAY = "#A8492A";
const link = (t: string, u: string) => `<a href="${esc(u)}" style="color:${GREEN}">${esc(t)}</a>`;

function toHtml(title: string, blocks: Block[], lang: Lang = "es"): string {
  const body = blocks
    .map((b) => {
      if ("p" in b) return `<p style="margin:0 0 16px">${esc(b.p)}</p>`;
      if ("h" in b) return `<h2 style="font-size:16px;margin:24px 0 8px">${esc(b.h)}</h2>`;
      if ("kv" in b)
        return `<table role="presentation" style="border-collapse:collapse;margin:0 0 16px">${b.kv
          .map(
            ([k, v]) =>
              `<tr><td style="padding:4px 16px 4px 0;color:#5b6b63;vertical-align:top">${esc(k)}</td><td style="padding:4px 0">${esc(v)}</td></tr>`,
          )
          .join("")}</table>`;
      if ("list" in b)
        return `<ul style="margin:0 0 16px;padding-left:20px">${b.list
          .map((i) => `<li style="margin:0 0 6px">${esc(i.text)}${(i.links ?? []).map(([t, u]) => ` · ${link(t, u)}`).join("")}</li>`)
          .join("")}</ul>`;
      if ("button" in b)
        return `<p style="margin:8px 0 20px"><a href="${esc(b.button[1])}" style="display:inline-block;background:${GREEN};color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:8px">${esc(b.button[0])}</a></p>`;
      if ("panel" in b) {
        const btn = (x: PanelButton) => {
          const colors =
            x.kind === "peligro"
              ? `background:${CLAY};border:2px solid ${CLAY};color:#ffffff`
              : `background:#ffffff;border:2px solid ${GREEN};color:${GREEN}`;
          return `<a href="${esc(x.url)}" style="display:inline-block;margin:6px 8px 6px 0;${colors};text-decoration:none;font-weight:bold;font-size:16px;padding:12px 22px;border-radius:8px">${esc(x.label)}</a>`;
        };
        return `<div style="margin:24px 0 8px;padding:16px 18px;background:#DDE9E0;border-radius:12px">
<p style="margin:0 0 6px;font-weight:bold;font-size:16px">${esc(b.panel.title)}</p>
<p style="margin:0 0 10px">${esc(b.panel.text)}</p>
<div>${b.panel.buttons.map(btn).join("")}</div>${
          b.panel.note ? `\n<p style="margin:10px 0 0;font-size:13px;color:#5b6b63">${esc(b.panel.note)}</p>` : ""
        }
</div>`;
      }
      return `<p style="margin:16px 0 0;font-size:13px;color:#5b6b63">${esc(b.small)}${(b.links ?? []).map(([t, u]) => ` ${link(t, u)}`).join("")}</p>`;
    })
    .join("\n");
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f4f1ea">
<div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1b2621">
<p style="margin:0 0 16px;font-weight:bold;font-size:18px;color:${GREEN}">Peloteo</p>
<h1 style="font-size:22px;line-height:1.25;margin:0 0 16px">${esc(title)}</h1>
${body}
</div></body></html>`;
}

/** Arma el correo de un evento para un jugador, en su idioma (players.lang). `site` es la dirección pública, sin "/" final. */
export function renderEmail(event: NoticeEvent, player: NoticePlayer, game: NoticeGame, site: string): Email {
  const lang = asLang(player.lang);
  const en = lang === "en";
  const T = (es: string, eng: string) => (en ? eng : es);
  const sport = sportNameIn(game.sport_name, lang);
  const fecha = (d: string) => fechaLarga(d, lang);
  const cuando = en ? `${fecha(game.date)} at ${game.time}` : `${fecha(game.date)} a las ${game.time}`;
  // Coordinación: Peloteo no asigna cancha; los jugadores la reservan con el club.
  const coord = game.court_mode === "coordinacion";
  const missing = Math.max(0, game.capacity - game.players.length);
  const falta = (n: number) => faltan(n, lang);
  const others = game.players.filter((p) => p.id !== player.id);
  // Rama e intención antes del nivel (2026-11-16); los cupos anteriores no las tienen.
  const nivel = (p: NoticePlayer) =>
    `${p.initials} (${[ramaLabel(p.rama, lang).toLowerCase(), intentLabel(p.intent, lang).toLowerCase(), `${T("nivel", "level")} ${p.level}`]
      .filter(Boolean)
      .join(", ")})`;
  const quienes = (ps: NoticePlayer[]) => ps.map(nivel).join(", ");
  const lugar = game.venue_name + (game.venue_address ? `, ${game.venue_address}` : "");
  const mapa = game.court_maps || game.venue_maps;
  const JUEGAN = T("Juegan", "Players");
  const base: [string, string][] = [
    [T("Deporte", "Sport"), sport],
    [T("Cuándo", "When"), cuando],
    [T("Lugar", "Venue"), lugar],
  ];
  const cancelBlock: Block = {
    panel: {
      title: T("¿Cambio de planes?", "Change of plans?"),
      text: T(
        "Si no puedes jugar, libera tu cupo hasta 1 hora antes del inicio para que otro jugador pueda tomarlo.",
        "If you can't play, free up your spot up to 1 hour before the start so someone else can take it.",
      ),
      buttons: [
        { label: T("Cancelar mi cupo", "Cancel my spot"), url: cancelUrl(site, player.cancel_token), kind: "peligro" },
        { label: T("Ver mis partidos", "See my matches"), url: mineUrl(site), kind: "contorno" },
      ],
      note: T(
        "«Mis partidos» muestra tus partidos en el navegador donde agendaste.",
        "“My matches” shows your matches in the browser where you booked them.",
      ),
    },
  };
  const footer: Block = {
    small: T(
      "Recibes este correo porque te anotaste en un partido en Peloteo. No respondas a este mensaje.",
      "You're receiving this email because you signed up for a match on Peloteo. Please don't reply to this message.",
    ),
  };

  let subject: string;
  let title: string;
  let blocks: Block[];

  switch (event) {
    case "partido_publicado":
      subject = T(`Tu partido de ${sport} está publicado`, `Your ${sport} match is posted`);
      title = T("Partido publicado", "Match posted");
      blocks = [
        {
          p: coord
            ? T(
                "Publicamos tu partido. Cuando se complete, te avisamos y te pasamos el contacto de tus compañeros para que reserven la cancha con el club.",
                "Your match is posted. When it fills up, we'll let you know and share your partners' contact details so you can book the court with the club.",
              )
            : T(
                "Publicamos tu partido. Cuando se complete, le asignamos la primera cancha libre de ese turno y te avisamos.",
                "Your match is posted. When it fills up, we'll assign the first free court at that time and let you know.",
              ),
        },
        { kv: [...base, [T("Busca", "Looking for"), `${falta(missing)}, ${nivelesTexto(parseIntList(game.accepted_levels, 1, 5), lang)}`]] },
        cancelBlock,
      ];
      break;

    case "jugador_se_sumo": {
      const nuevo = game.players[game.players.length - 1];
      subject = T(`Se sumó un jugador a tu partido de ${sport}`, `A player joined your ${sport} match`);
      title = T("Se sumó un jugador", "A player joined");
      blocks = [
        {
          p: en
            ? `${nuevo ? nivel(nuevo) : "A player"} joined your match. Still ${falta(missing)}.`
            : `${nuevo ? nivel(nuevo) : "Un jugador"} se sumó a tu partido. Todavía ${falta(missing)}.`,
        },
        { kv: [...base, [JUEGAN, quienes(game.players)]] },
        cancelBlock,
      ];
      break;
    }

    case "partido_confirmado": {
      subject = T(`Partido confirmado: ${sport}, ${cuando}`, `Match confirmed: ${sport}, ${cuando}`);
      title = T("¡Partido confirmado!", "Match confirmed!");
      const cancha =
        (game.court_name ?? "") +
        (game.court_surface ? `, ${game.court_surface.toLowerCase()}` : "") +
        (game.court_notes ? `. ${game.court_notes}` : "");
      // El saludo de WhatsApp va en el idioma de quien lo envía.
      const saludo = T(
        `Hola, soy ${player.initials}. Jugamos ${sport} por Peloteo el ${cuando} en ${game.venue_name}.`,
        `Hi, I'm ${player.initials}. We're playing ${sport} through Peloteo on ${cuando} at ${game.venue_name}.`,
      );
      blocks = [
        {
          p: game.court_name
            ? T("Ya tienen cancha asignada. Estos son los datos del partido.", "You have a court assigned. Here are the match details.")
            : T(
                "¡Ya están todos! Pónganse de acuerdo y reserven la cancha directamente con el club.",
                "Everyone's in! Get in touch with each other and book the court directly with the club.",
              ),
        },
        {
          kv: [
            ...base,
            ...(game.court_name ? [[T("Cancha", "Court"), cancha] as [string, string]] : []),
            [JUEGAN, quienes(game.players)],
          ],
        },
        ...(mapa ? [{ button: [T("Cómo llegar", "Directions"), mapa] as [string, string] }] : []),
        { p: T(DISCLAIMER.es, DISCLAIMER.en) },
        { h: T("Contacto de tus compañeros", "Your partners' contact details") },
        {
          list: others.map((p) => ({
            text: `${nivel(p)}: ${p.email}${p.whatsapp ? `, WhatsApp ${p.whatsapp}` : ""}`,
            links: [
              [T("Escribir correo", "Send an email"), `mailto:${p.email}`] as [string, string],
              ...(p.whatsapp ? [[T("Escribir por WhatsApp", "Message on WhatsApp"), waLink(p.whatsapp, saludo)] as [string, string]] : []),
            ],
          })),
        },
        cancelBlock,
      ];
      break;
    }

    case "partido_sin_cancha": {
      subject = T(`Tu partido de ${sport} se completó, pero no quedan canchas`, `Your ${sport} match filled up, but there are no courts left`);
      title = T("Partido completo, sin cancha", "Match full, no court");
      const sug = game.suggestions ?? [];
      blocks = [
        {
          p: T(
            `El partido del ${cuando} se completó, pero ya no queda ninguna cancha libre a esa hora, así que no pudimos confirmarlo.`,
            `The match on ${cuando} filled up, but there are no free courts left at that time, so we couldn't confirm it.`,
          ),
        },
        { kv: [...base, [JUEGAN, quienes(game.players)]] },
        ...(sug.length
          ? ([
              { h: T("Turnos con cancha libre", "Times with a free court") },
              { list: sug.map((s: SuggestedSlot) => ({ text: en ? `${fecha(s.date)} at ${s.time}` : `${fecha(s.date)} a las ${s.time}` })) },
              {
                p: T(
                  "Pónganse de acuerdo: uno de ustedes abre el partido en otro turno y los demás se suman. Después, cada uno cancela su cupo en este.",
                  "Agree among yourselves: one of you opens the match at another time and the others join. Then each of you cancels your spot in this one.",
                ),
              },
              { button: [T("Ver turnos en Peloteo", "See times on Peloteo"), site + "/"] },
            ] as Block[])
          : [
              { p: T("Por ahora no vemos otros turnos libres cercanos. Revisa el calendario en Peloteo.", "We don't see other free times nearby right now. Check the calendar on Peloteo.") },
              { button: [T("Abrir Peloteo", "Open Peloteo"), site + "/"] } as Block,
            ]),
        cancelBlock,
      ];
      break;
    }

    case "cupo_cancelado":
      subject = T(`Un jugador dejó tu partido de ${sport}`, `A player left your ${sport} match`);
      title = T("Se liberó un cupo", "A spot opened up");
      blocks = [
        {
          p: coord
            ? T(
                `Un jugador canceló su cupo, así que el partido vuelve a buscar jugadores: ${falta(missing)}. Si ya habían reservado la cancha con el club, revisen si la mantienen.`,
                `A player cancelled their spot, so the match is looking for players again: ${falta(missing)}. If you already booked the court with the club, check whether you'll keep it.`,
              )
            : T(
                `Un jugador canceló su cupo, así que el partido vuelve a buscar jugadores: ${falta(missing)}. La cancha que tenía asignada quedó libre; cuando se complete, se asigna la primera cancha libre del turno.`,
                `A player cancelled their spot, so the match is looking for players again: ${falta(missing)}. Its court was released; when it fills up, the first free court at that time will be assigned.`,
              ),
        },
        { kv: [...base, [JUEGAN, quienes(game.players)]] },
        cancelBlock,
      ];
      break;

    case "encuentro_cancelado":
      subject = T(`Partido cancelado: ${sport}, ${cuando}`, `Match cancelled: ${sport}, ${cuando}`);
      title = T("Partido cancelado", "Match cancelled");
      blocks = [
        {
          p:
            game.cause === "bloqueo"
              ? T(
                  "Lo sentimos: la cancha no estará disponible en ese horario, así que el partido se canceló.",
                  "Sorry: the court won't be available at that time, so the match was cancelled.",
                )
              : T("Lo sentimos: la administración del lugar canceló este partido.", "Sorry: the venue's management cancelled this match."),
        },
        { kv: base },
        { p: T("Puedes agendar otro turno cuando quieras.", "You can book another time whenever you like.") },
        { button: [T("Agendar otro partido", "Book another match"), site + "/"] },
      ];
      break;
  }

  blocks.push(footer);
  return { subject, text: `${title}\n\n${toText(blocks)}`, html: toHtml(title, blocks, lang) };
}

/** Correo con el enlace de ingreso a la cuenta (cuentas: preparadas, desactivadas). */
export function renderLoginEmail(site: string, token: string, minutes: number): Email {
  const url = `${site}/#entrar=${token}`;
  const blocks: Block[] = [
    { p: "Toca el botón para entrar a tu cuenta de Peloteo. El enlace sirve una sola vez." },
    { button: ["Entrar a Peloteo", url] },
    { small: `Vence en ${minutes} minutos. Si no lo pediste, ignora este correo: nadie puede entrar sin él.` },
  ];
  return { subject: "Tu enlace para entrar a Peloteo", text: `Entrar a Peloteo\n\n${toText(blocks)}`, html: toHtml("Entrar a Peloteo", blocks) };
}

/** Envía un correo suelto (no ligado a un partido) con Resend. */
export async function sendResendMail(apiKey: string, from: string, to: string, mail: Email, fetchFn: typeof fetch = fetch): Promise<void> {
  const res = await fetchFn(RESEND_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", "User-Agent": "peloteo/1.0" },
    body: JSON.stringify({ from, to: [to], subject: mail.subject, html: mail.html, text: mail.text }),
  });
  if (!res.ok) throw new Error(`Resend respondió ${res.status}`);
}

// ---------------------------------------------------------------
// Canales
// ---------------------------------------------------------------

export interface MailConfig {
  /** Dirección pública para los enlaces, sin "/" final. */
  site: string;
  /** Remitente, por ejemplo "Peloteo <avisos@peloteo.cl>". */
  from: string;
}


/** Envía con Resend. Lanza un error (sin datos del jugador) si la API responde mal. */
export function resendChannel(apiKey: string, config: MailConfig, fetchFn: typeof fetch = fetch): Channel {
  return {
    name: "correo",
    async send(event, player, game) {
      const mail = renderEmail(event, player, game, config.site);
      const res = await fetchFn(RESEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "User-Agent": "peloteo/1.0",
        },
        body: JSON.stringify({
          from: config.from,
          to: [player.email],
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          tags: [{ name: "evento", value: event }],
        }),
      });
      if (!res.ok) {
        let detail = "";
        try {
          const body = (await res.json()) as { name?: string };
          detail = body.name ? ` (${body.name})` : "";
        } catch {
          // sin cuerpo JSON
        }
        throw new Error(`Resend respondió ${res.status}${detail} al avisar ${event} a ${player.id}`);
      }
    },
  };
}

/** Canal de desarrollo: muestra el correo en la consola, sin enviarlo. */
export function consoleChannel(config: MailConfig, out: (s: string) => void = console.info): Channel {
  return {
    name: "consola",
    async send(event, player, game) {
      const mail = renderEmail(event, player, game, config.site);
      out(
        [
          "──────── correo (no enviado) ────────",
          `De: ${config.from}`,
          `Para: ${player.email}`,
          `Asunto: ${mail.subject}`,
          "",
          mail.text.trimEnd(),
          "─────────────────────────────────────",
        ].join("\n"),
      );
    },
  };
}
