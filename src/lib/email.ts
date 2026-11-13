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

export interface Email {
  subject: string;
  text: string;
  html: string;
}

const MESES = ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"];
const DIAS = ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"];

/** "sábado 21 de noviembre" */
export function fechaLarga(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${DIAS[dayOfWeek(date)]} ${d} de ${MESES[m! - 1]}`;
}

const faltan = (n: number) => (n === 1 ? "falta 1 jugador" : `faltan ${n} jugadores`);

function nivelesTexto(levels: number[]): string {
  if (levels.length === 5) return "todos los niveles";
  if (levels.length === 1) return `nivel ${levels[0]}`;
  return `niveles ${levels.slice(0, -1).join(", ")} y ${levels[levels.length - 1]}`;
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
  | { small: string; links?: [string, string][] };

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
  }
  return out.join("\n\n") + "\n";
}

const GREEN = "#1E6B4F";
const link = (t: string, u: string) => `<a href="${esc(u)}" style="color:${GREEN}">${esc(t)}</a>`;

function toHtml(title: string, blocks: Block[]): string {
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
      return `<p style="margin:16px 0 0;font-size:13px;color:#5b6b63">${esc(b.small)}${(b.links ?? []).map(([t, u]) => ` ${link(t, u)}`).join("")}</p>`;
    })
    .join("\n");
  return `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head>
<body style="margin:0;padding:0;background:#f4f1ea">
<div style="max-width:560px;margin:0 auto;padding:24px 16px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1b2621">
<p style="margin:0 0 16px;font-weight:bold;font-size:18px;color:${GREEN}">Peloteo</p>
<h1 style="font-size:22px;line-height:1.25;margin:0 0 16px">${esc(title)}</h1>
${body}
</div></body></html>`;
}

/** Arma el correo de un evento para un jugador. `site` es la dirección pública, sin "/" final. */
export function renderEmail(event: NoticeEvent, player: NoticePlayer, game: NoticeGame, site: string): Email {
  const cuando = `${fechaLarga(game.date)} a las ${game.time}`;
  const missing = Math.max(0, game.capacity - game.players.length);
  const others = game.players.filter((p) => p.id !== player.id);
  const quienes = (ps: NoticePlayer[]) => ps.map((p) => `${p.initials} (nivel ${p.level})`).join(", ");
  const lugar = game.venue_name + (game.venue_address ? `, ${game.venue_address}` : "");
  const mapa = game.court_maps || game.venue_maps;
  const base: [string, string][] = [
    ["Deporte", game.sport_name],
    ["Cuándo", cuando],
    ["Lugar", lugar],
  ];
  const cancelBlock: Block = {
    small:
      "Si no puedes jugar, libera tu cupo hasta 1 hora antes del inicio para que otro jugador pueda tomarlo. Tus partidos también están en «Mis partidos», en el navegador donde agendaste.",
    links: [
      ["Cancelar mi cupo", cancelUrl(site, player.cancel_token)],
      ["Mis partidos", mineUrl(site)],
    ],
  };
  const footer: Block = { small: "Recibes este correo porque te anotaste en un partido en Peloteo. No respondas a este mensaje." };

  let subject: string;
  let title: string;
  let blocks: Block[];

  switch (event) {
    case "partido_publicado":
      subject = `Tu partido de ${game.sport_name} está publicado`;
      title = "Partido publicado";
      blocks = [
        { p: `Publicamos tu partido. Cuando se complete, le asignamos la primera cancha libre de ese turno y te avisamos.` },
        { kv: [...base, ["Busca", `${faltan(missing)}, ${nivelesTexto(parseIntList(game.accepted_levels, 1, 5))}`]] },
        cancelBlock,
      ];
      break;

    case "jugador_se_sumo": {
      const nuevo = game.players[game.players.length - 1];
      subject = `Se sumó un jugador a tu partido de ${game.sport_name}`;
      title = "Se sumó un jugador";
      blocks = [
        { p: `${nuevo ? `${nuevo.initials} (nivel ${nuevo.level})` : "Un jugador"} se sumó a tu partido. Todavía ${faltan(missing)}.` },
        { kv: [...base, ["Juegan", quienes(game.players)]] },
        cancelBlock,
      ];
      break;
    }

    case "partido_confirmado": {
      subject = `Partido confirmado: ${game.sport_name}, ${cuando}`;
      title = "¡Partido confirmado!";
      const cancha =
        (game.court_name ?? "") +
        (game.court_surface ? `, ${game.court_surface.toLowerCase()}` : "") +
        (game.court_notes ? `. ${game.court_notes}` : "");
      const saludo = `Hola, soy ${player.initials}. Jugamos ${game.sport_name} por Peloteo el ${cuando} en ${game.venue_name}.`;
      blocks = [
        { p: "Ya tienen cancha asignada. Estos son los datos del partido." },
        { kv: [...base, ["Cancha", cancha], ["Juegan", quienes(game.players)]] },
        ...(mapa ? [{ button: ["Cómo llegar", mapa] as [string, string] }] : []),
        { h: "Contacto de tus compañeros" },
        {
          list: others.map((p) => ({
            text: `${p.initials} (nivel ${p.level}): ${p.email}${p.whatsapp ? `, WhatsApp ${p.whatsapp}` : ""}`,
            links: [
              ["Escribir correo", `mailto:${p.email}`] as [string, string],
              ...(p.whatsapp ? [["Escribir por WhatsApp", waLink(p.whatsapp, saludo)] as [string, string]] : []),
            ],
          })),
        },
        cancelBlock,
      ];
      break;
    }

    case "partido_sin_cancha": {
      subject = `Tu partido de ${game.sport_name} se completó, pero no quedan canchas`;
      title = "Partido completo, sin cancha";
      const sug = game.suggestions ?? [];
      blocks = [
        {
          p: `El partido del ${cuando} se completó, pero ya no queda ninguna cancha libre a esa hora, así que no pudimos confirmarlo.`,
        },
        { kv: [...base, ["Juegan", quienes(game.players)]] },
        ...(sug.length
          ? ([
              { h: "Turnos con cancha libre" },
              { list: sug.map((s: SuggestedSlot) => ({ text: `${fechaLarga(s.date)} a las ${s.time}` })) },
              {
                p: "Pónganse de acuerdo: uno de ustedes abre el partido en otro turno y los demás se suman. Después, cada uno cancela su cupo en este.",
              },
              { button: ["Ver turnos en Peloteo", site + "/"] },
            ] as Block[])
          : [{ p: "Por ahora no vemos otros turnos libres cercanos. Revisa el calendario en Peloteo." }, { button: ["Abrir Peloteo", site + "/"] } as Block]),
        cancelBlock,
      ];
      break;
    }

    case "cupo_cancelado":
      subject = `Un jugador dejó tu partido de ${game.sport_name}`;
      title = "Se liberó un cupo";
      blocks = [
        {
          p: `Un jugador canceló su cupo, así que el partido vuelve a buscar jugadores: ${faltan(missing)}. La cancha que tenía asignada quedó libre; cuando se complete, se asigna la primera cancha libre del turno.`,
        },
        { kv: [...base, ["Juegan", quienes(game.players)]] },
        cancelBlock,
      ];
      break;

    case "encuentro_cancelado":
      subject = `Partido cancelado: ${game.sport_name}, ${cuando}`;
      title = "Partido cancelado";
      blocks = [
        {
          p:
            game.cause === "bloqueo"
              ? "Lo sentimos: la cancha no estará disponible en ese horario, así que el partido se canceló."
              : "Lo sentimos: la administración del lugar canceló este partido.",
        },
        { kv: base },
        { p: "Puedes agendar otro turno cuando quieras." },
        { button: ["Agendar otro partido", site + "/"] },
      ];
      break;
  }

  blocks.push(footer);
  return { subject, text: `${title}\n\n${toText(blocks)}`, html: toHtml(title, blocks) };
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

const RESEND_URL = "https://api.resend.com/emails";

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
