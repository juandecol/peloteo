// Peloteo: flujo público. Deporte → lugar → calendario → horas → formulario →
// confirmación, búsqueda de jugadores y "Mis partidos".
// Sin framework. Pantallas y textos tomados del prototipo (referencia/peloteo.html),
// con las reglas actuales de CLAUDE.md: quien abre elige cuántos jugadores y qué
// niveles acepta, y la cancha se asigna recién al completarse el partido.
(function () {
  'use strict';

  // Campo WhatsApp del formulario: solo si el administrador activó "Pedir el
  // WhatsApp de los jugadores" en Configuración › Opciones (llega en /api/today
  // como whatsapp_contact). Si está apagado, el servidor además ignora el número.
  const waField = () => !!(S.today && S.today.whatsapp_contact);

  // Avisos por WhatsApp (etapa 6, todavía no implementada): mientras sea false,
  // el formulario no muestra la casilla "Avísenme también por WhatsApp" y
  // siempre envía whatsapp_opt_in = false. El servidor, la base (players.whatsapp_opt_in)
  // y el perfil de las cuentas ya la soportan: para activarla basta con poner true
  // cuando exista el canal de WhatsApp en notify().
  const WHATSAPP_NOTICES = false;

  // Modo de canchas (lo informa /api/today): en "coordinacion" (el actual, mientras
  // Peloteo no esté conectado al sistema de reservas de los clubes) no se muestran
  // canchas: solo el deporte, el lugar y la hora, para ponerse de acuerdo; los
  // jugadores reservan la cancha con el club. En "reserva" se muestran las canchas
  // libres y la cancha asignada.
  const coord = () => !S.today || S.today.court_mode !== 'reserva';

  // Idioma de la interfaz: español (por defecto) o inglés. Se elige con ESP/ENG en
  // la barra superior y se guarda en la cookie peloteo_lang (400 días), que el
  // servidor usa para los mensajes de error. Sin elección, siempre español: el
  // idioma solo cambia cuando el jugador toca ENG. L('texto', 'text') elige según el idioma.
  const LANG_COOKIE = 'peloteo_lang';
  const cookieLang = () => { const m = /(?:^|;\s*)peloteo_lang=(es|en)(?:;|$)/.exec(document.cookie); return m ? m[1] : null; };
  let lang = cookieLang() || 'es';
  const L = (es, en) => (lang === 'en' ? en : es);
  // Aplica el idioma a la página; con remember, además lo guarda (solo al elegirlo el jugador).
  function saveLang(remember) {
    if (remember) document.cookie = LANG_COOKIE + '=' + lang + '; Max-Age=34560000; Path=/; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
    document.documentElement.lang = lang === 'en' ? 'en' : 'es-CL';
    document.title = L('Peloteo, agenda de partidos', 'Peloteo, book a match');
  }

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MESES_ES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const MESES_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const DIAS_ES = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const DIAS_EN = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MESES = () => L(MESES_ES, MESES_EN);
  const DIAS = () => L(DIAS_ES, DIAS_EN);
  const DOW = () => L(['lu', 'ma', 'mi', 'ju', 'vi', 'sá', 'do'], ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su']);
  const pad = (n) => String(n).padStart(2, '0');
  const parse = (s) => { const a = s.split('-').map(Number); return new Date(a[0], a[1] - 1, a[2], 12); };
  // "lunes 16 de noviembre" / "Monday, November 16"
  const fecha = (s) => { const d = parse(s); return lang === 'en' ? DIAS_EN[d.getDay()] + ', ' + MESES_EN[d.getMonth()] + ' ' + d.getDate() : DIAS_ES[d.getDay()] + ' ' + d.getDate() + ' de ' + MESES_ES[d.getMonth()]; };
  // "lunes 16 de noviembre, 18:00" / "Monday, November 16 at 18:00"
  const fechaHora = (s, t) => cap(fecha(s)) + L(', ', ' at ') + t;
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const plural = (n, uno, varios) => (n === 1 ? '1 ' + uno : n + ' ' + varios);
  const faltan = (n) => (lang === 'en' ? (n === 1 ? '1 player needed' : n + ' players needed') : n === 1 ? 'falta 1 jugador' : 'faltan ' + n + ' jugadores');
  const levelsText = (ls) => (ls.length === 1 ? L('nivel ', 'level ') + ls[0] : ls.length === 5 ? L('todos los niveles', 'all levels') : L('niveles ', 'levels ') + ls.slice(0, -1).join(', ') + L(' y ', ' and ') + ls[ls.length - 1]);
  const who = (players) => players.map((p) => esc(p.initials) + ' (' + L('nivel ', 'level ') + p.level + ')').join(', ');
  // Nombres de deportes en inglés (los entrega /api/today); los lugares no se traducen.
  const sportKeyOf = (name) => String(name || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().trim().replace(/\s+/g, ' ');
  const sportLabel = (name) => (lang === 'en' && S.today && S.today.sport_names_en && S.today.sport_names_en[sportKeyOf(name)]) || name;
  // Texto de una categoría: en inglés si el administrador lo definió; si no, el de español.
  const catLabel = (c) => (lang === 'en' && c.label_en) || c.label;

  // Preferencias de este navegador (solo comodidad: se pueden perder sin problema).
  const LS = {
    get(k, f) { try { const v = localStorage.getItem(k); return v == null ? f : JSON.parse(v); } catch (e) { return f; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } },
  };
  let prefs = LS.get('peloteo_prefs', {});

  let toastT;
  function toast(m) {
    const t = $('#toast'); t.textContent = m; t.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 3500);
  }

  // ---------------- estado ----------------
  const S = {
    view: 'loading',
    today: null, // { date, minutes, last_bookable }
    sports: [], sportKey: null,
    offers: [], offer: null, // { venue, sport, courts, open_games }
    ym: null, days: [], date: null, slots: [], time: null,
    game: null, // encuentro al que unirse (vista pública)
    done: null, // encuentro recién creado o al que se unió (vista del jugador)
    mine: [], mineLoaded: false,
    open: null, // resumen de 8 días (AM/PM) del inicio
    block: null, blockGames: null, // bloque elegido { date, half } y sus partidos
    preset: null, // { date, half } al crear un partido desde un bloque
    fromBlock: false,
    token: null, tokenGame: null, tokenDone: false, // enlace de cancelación de un correo
    search: null, searchOffers: [], results: null,
    err: '', field: '', busy: false, confirm: null,
  };

  // ---------------- API ----------------
  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    try {
      const res = await fetch(path, opts);
      let data = null;
      try { data = await res.json(); } catch (e) { data = null; }
      return { ok: res.ok, status: res.status, data: data || {} };
    } catch (e) {
      return { ok: false, status: 0, data: { error: L('No hay conexión. Revisa tu internet e inténtalo de nuevo.', "You're offline. Check your connection and try again.") } };
    }
  }
  const get = async (path) => { const r = await api('GET', path); return r.ok ? r.data : null; };

  async function loadMine() {
    const r = await get('/api/me/games');
    S.mine = r || []; S.mineLoaded = true;
  }
  const activeMine = () => S.mine.filter((g) => g.status !== 'cancelado').length;

  // ---------------- navegación ----------------
  async function go(view, opts) {
    S.view = view; S.err = ''; S.field = ''; S.confirm = null;
    if (!opts || !opts.keepScroll) window.scrollTo(0, 0);
    render();
    if (view === 'home') { S.preset = null; [S.sports] = await Promise.all([get('/api/sports').then((r) => r || []), loadOpen()]); }
    if (view === 'block') { S.blockGames = null; render(); S.blockGames = (await get('/api/open/block?date=' + S.block.date + '&half=' + S.block.half)) || []; }
    if (view === 'mine') { await loadMine(); }
    if (view === 'search') { await prepareSearch(); }
    render();
  }

  async function chooseSport(key) {
    S.sportKey = key; S.offers = (await get('/api/venues?sport=' + encodeURIComponent(key))) || [];
    if (S.offers.length === 1) return chooseOffer(S.offers[0]);
    go('venue');
  }

  async function chooseOffer(offer) {
    S.offer = offer; S.sportKey = S.sportKey || null;
    // Desde un bloque del inicio, el calendario abre en ese día y esa mitad del día.
    const t = parse(S.preset ? S.preset.date : S.today.date);
    S.ym = { y: t.getFullYear(), m: t.getMonth() };
    S.date = S.preset ? S.preset.date : null; S.slots = [];
    S.view = 'calendar'; render(); window.scrollTo(0, 0);
    await Promise.all([loadMonth(), S.date ? loadDay() : null]); render();
  }

  async function loadMonth() {
    const month = S.ym.y + '-' + pad(S.ym.m + 1);
    const r = await get('/api/availability?sport_id=' + encodeURIComponent(S.offer.sport.id) + '&month=' + month);
    S.days = (r && r.days) || [];
  }
  async function loadDay() {
    const r = await get('/api/availability?sport_id=' + encodeURIComponent(S.offer.sport.id) + '&date=' + S.date);
    S.slots = (r && r.slots) || [];
  }

  // ---------------- vistas ----------------
  const errBox = () => (S.err ? '<p class="err" role="alert">' + esc(S.err) + '</p>' : '');
  const sportName = () => (S.offer ? sportLabel(S.offer.sport.name) : '');

  function crumbs(upTo) {
    const parts = [];
    if (S.offer) parts.push('<button type="button" data-a="go" data-v="home">' + esc(sportName()) + '</button>');
    if (upTo >= 2 && S.offer) parts.push('<span>›</span><button type="button" data-a="toVenues">' + esc(S.offer.venue.name) + '</button>');
    if (upTo >= 3 && S.date) parts.push('<span>›</span><button type="button" data-a="toCalendar">' + esc(fecha(S.date)) + '</button>');
    return parts.length ? '<p class="crumbs">' + parts.join('') + '</p>' : '';
  }

  // Íconos de trazo (dirección visual A): 24×24, trazo 2,25 px, puntas redondas.
  const ICONS = {
    padel: '<ellipse cx="10" cy="9" rx="6" ry="6.5"/><path d="M14.3 13.7L20 20"/><circle cx="8" cy="8" r=".6"/><circle cx="11.5" cy="7" r=".6"/><circle cx="9.5" cy="11" r=".6"/>',
    tenis: '<circle cx="12" cy="12" r="8.5"/><path d="M5.5 6.5c3.5 2.8 3.5 8.2 0 11M18.5 6.5c-3.5 2.8-3.5 8.2 0 11"/>',
    pelota: '<circle cx="12" cy="12" r="8.5"/><path d="M4 10.5c5 1.5 11 1.5 16 0"/>',
    buscar: '<circle cx="11" cy="11" r="6.5"/><path d="M16 16l4.5 4.5"/>',
    mis: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8 3v4M16 3v4M8.75 15.25l2.25 2.25 4.25-4.25"/>',
    seguir: '<path d="M9 5l7 7-7 7"/>',
    ajustes: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  };
  const HALF = (h) => (h === 'am' ? L('mañana', 'morning') : L('tarde', 'afternoon'));
  const halfOf = (time) => (time < '12:00' ? 'am' : 'pm');
  let todayLoadedAt = Date.now();
  const nowHHMM = () => {
    const m = Math.min(24 * 60 - 1, S.today.minutes + Math.floor((Date.now() - todayLoadedAt) / 60000));
    return pad(Math.floor(m / 60)) + ':' + pad(m % 60);
  };
  const diaCorto = (s) => { const d = parse(s); return DIAS()[d.getDay()].slice(0, lang === 'en' ? 3 : 2); };
  const icon = (name, size) => '<svg width="' + (size || 24) + '" height="' + (size || 24) + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.25" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">' + ICONS[name] + '</svg>';
  // Banderas del selector de idioma: España (ESP) y Reino Unido (ENG), en SVG para
  // que se vean igual en todos los sistemas (Windows no dibuja banderas emoji).
  const FLAGS = {
    es: '<svg class="flag" viewBox="0 0 30 20" aria-hidden="true" focusable="false"><rect width="30" height="20" fill="#AA151B"/><rect y="5" width="30" height="10" fill="#F1BF00"/></svg>',
    // Union Jack (2:1), recortado al centro en 3:2 para que mida lo mismo que la de España.
    en: '<svg class="flag" viewBox="7.5 0 45 30" aria-hidden="true" focusable="false"><clipPath id="flag-uk-t"><path d="M30 15h30v15zv15H0zH0V0zV0h30z"/></clipPath>' +
      '<rect width="60" height="30" fill="#012169"/><path d="M0 0l60 30m0-30L0 30" stroke="#FFFFFF" stroke-width="6"/>' +
      '<path d="M0 0l60 30m0-30L0 30" clip-path="url(#flag-uk-t)" stroke="#C8102E" stroke-width="4"/>' +
      '<path d="M30 0v30M0 15h60" stroke="#FFFFFF" stroke-width="10"/><path d="M30 0v30M0 15h60" stroke="#C8102E" stroke-width="6"/></svg>',
  };
  const sportIcon = (key) => icon(/padel/.test(key) ? 'padel' : /tenis/.test(key) ? 'tenis' : 'pelota', 26);
  function vHome() {
    // La foto de fondo (public/img/inicio-tenis.webp) es decorativa: va en CSS, no como <img>.
    let h = '<section class="hero photo"><div class="shade"></div><h1 class="' + lang + '">' + L('¿Jugamos?', "Let's play?") + '</h1><p>' +
      (coord() ? L('Elige deporte, lugar y hora, y encuentra con quién jugar.', 'Pick a sport, place and time, and find someone to play with.')
        : L('Elige deporte, lugar y hora. Si alguien de tu nivel busca partido, les asignamos cancha.', "Pick a sport, place and time. If someone at your level is looking for a match, we'll assign you a court.")) + '</p>' +
      '<button type="button" class="how" data-a="intro">' + L('¿Cómo funciona?', 'How does it work?') + '</button></section>';
    if (!S.sports.length) {
      return h + '<div class="card"><h2>' + L('Todavía no hay deportes disponibles', 'No sports available yet') + '</h2><p class="muted">' + L('Pronto aparecerán aquí las canchas para agendar.', 'Courts to book will show up here soon.') + '</p></div>';
    }
    h += vWeek();
    h += '<section class="card create" aria-labelledby="crea"><h2 id="crea">' + L('Crea un partido', 'Create a match') + '</h2>' +
      sportPicker('create', L('Elige el deporte; después, el lugar, el día y la hora.', 'Pick the sport; then the place, day and time.'), L('Ver días y horas', 'See days and times')) + '</section>';
    return h;
  }

  // Elegir deporte: siempre un menú desplegable (hoy solo tenis; listo para sumar otros).
  // `form` identifica el formulario (data-f) que recibe { sport }.
  function sportPicker(form, hint, button) {
    // Por defecto: el último elegido en este navegador; si no, tenis (el deporte principal); si no, el primero.
    const has = (k) => S.sports.some((n) => n.key === k);
    const last = prefs.sport && has(prefs.sport) ? prefs.sport : has('tenis') ? 'tenis' : (S.sports[0] && S.sports[0].key);
    return '<form data-f="' + form + '" class="picker" novalidate><label class="f" for="sp-' + form + '">' + L('Deporte', 'Sport') + '</label>' +
      '<select id="sp-' + form + '" name="sport">' + S.sports.map((n) =>
        '<option value="' + esc(n.key) + '"' + (n.key === last ? ' selected' : '') + '>' + esc(sportLabel(n.name)) + (coord() ? '' : ' · ' + plural(n.venues, L('lugar', 'place'), L('lugares', 'places')) + ', ' + plural(n.courts, L('cancha', 'court'), L('canchas', 'courts'))) + '</option>').join('') + '</select>' +
      (hint ? '<p class="small muted">' + hint + '</p>' : '') +
      '<div class="actions"><button class="btn block" type="submit">' + button + '</button></div></form>';
  }

  // Calendario horizontal de 8 días (hoy incluido): un bloque AM y uno PM por día.
  // Naranja si hay partidos que buscan jugadores en esa mitad del día; blanco si no.
  function vWeek() {
    const days = S.open || [];
    const cell = (d, half) => {
      const n = d[half];
      const label = cap(fecha(d.date)) + ', ' + HALF(half) + ': ' + (n ? (n === 1 ? L('1 partido busca jugadores', '1 match looking for players') : n + L(' partidos buscan jugadores', ' matches looking for players')) : L('nadie busca jugadores todavía', 'nobody is looking for players yet'));
      return '<button type="button" class="blk ' + half + (n ? ' on' : '') + '" data-a="block" data-d="' + d.date + '" data-h="' + half + '" aria-label="' + label + '">' + half.toUpperCase() + '</button>';
    };
    return '<section class="cta week" aria-labelledby="buscas"><h2 id="buscas">' + L('¿Buscas con quién jugar?', 'Looking for someone to play with?') + '</h2>' +
      '<p>' + L('Toca un bloque: <b class="dot"></b> naranjo si hay jugadores esperando.', 'Tap a block: <b class="dot"></b> orange if players are waiting.') + '</p>' +
      (days.length ? '<div class="days8">' + days.map((d) => {
        const t = parse(d.date);
        return '<div class="day8' + (d.date === S.today.date ? ' today' : '') + '"><span class="dl" aria-hidden="true">' + (d.date === S.today.date ? L('hoy', 'today') : diaCorto(d.date)) + '</span><span class="dn" aria-hidden="true">' + t.getDate() + '</span><span class="pair">' + cell(d, 'am') + cell(d, 'pm') + '</span></div>';
      }).join('') + '</div>' : '<p class="small">' + L('Cargando…', 'Loading…') + '</p>') +
      '</section>';
  }

  // Partidos que buscan jugadores en un día y mitad del día.
  function vBlock() {
    const b = S.block;
    if (!b) return '';
    let h = '<p class="crumbs"><button type="button" data-a="go" data-v="home">‹ ' + L('Inicio', 'Home') + '</button></p>' +
      '<h1 class="h">' + cap(fecha(b.date)) + ' · ' + HALF(b.half) + '</h1>';
    if (!S.blockGames) return h + '<p class="muted">' + L('Cargando…', 'Loading…') + '</p>';
    if (!S.blockGames.length) {
      h += '<p class="muted">' + L('Nadie busca jugadores ' + (b.half === 'am' ? 'en la mañana' : 'en la tarde') + ' de ese día. Abre tú un partido y otros podrán sumarse.',
        'Nobody is looking for players that ' + (b.half === 'am' ? 'morning' : 'afternoon') + '. Open a match yourself and others can join.') + '</p>';
    } else {
      h += '<p class="muted">' + (S.blockGames.length === 1 ? L('1 partido busca jugadores.', '1 match is looking for players.') : S.blockGames.length + L(' partidos buscan jugadores.', ' matches are looking for players.')) + L(' Toca uno para sumarte.', ' Tap one to join.') + '</p>' +
        '<ul class="list open-list">' + S.blockGames.map((g) =>
          '<li><button type="button" class="row open" data-a="pickOpen" data-id="' + esc(g.id) + '"><time>' + g.time + '</time><span class="txt"><span class="name">' + esc(sportLabel(g.sport.name)) + ' · ' + esc(g.venue.name) + '</span>' +
          '<span class="meta">' + cap(levelsText(g.accepted_levels)) + ' · ' + faltan(g.missing) + '</span><span class="meta">' + L('Juegan ', 'Playing: ') + who(g.players) + '</span></span><span class="go">' + L('Unirme', 'Join') + '</span></button></li>').join('') + '</ul>';
    }
    h += '<h2 class="label">' + (b.half === 'am' ? L('Crear un partido ese día', 'Create a match that day') : L('Crear un partido en la tarde', 'Create a match that afternoon')) + '</h2>' +
      (S.sports.length ? '<div class="card create">' + sportPicker('createIn', b.half === 'am' ? L('Te mostramos las horas libres de ese día, mañana y tarde.', "We'll show you that day's free times, morning and afternoon.") : L('Te mostramos las horas libres de esa tarde.', "We'll show you that afternoon's free times."), L('Ver horas libres', 'See free times')) + '</div>'
        : '<p class="muted">' + L('Todavía no hay deportes disponibles.', 'No sports available yet.') + '</p>');
    return h;
  }

  async function loadOpen() { S.open = (await get('/api/open')) || []; }

  function vVenue() {
    if (!S.offers.length) return '<p>' + L('Ese deporte ya no está disponible.', 'That sport is no longer available.') + '</p><div class="actions"><button type="button" class="btn" data-a="go" data-v="home">' + L('Volver al inicio', 'Back to home') + '</button></div>';
    return '<p class="crumbs"><button type="button" data-a="go" data-v="home">‹ ' + L('Deportes', 'Sports') + '</button></p><h1 class="h">' + L('¿Dónde quieres jugar?', 'Where do you want to play?') + '</h1><ul class="list">' + S.offers.map((o, i) =>
      '<li><button type="button" class="row" data-a="offer" data-i="' + i + '"><span><span class="name">' + esc(o.venue.name) + '</span><span class="meta">' +
      esc(o.venue.address || '') + (coord() ? '' : (o.venue.address ? '. ' : '') + plural(o.courts, L('cancha operativa', 'court open'), L('canchas operativas', 'courts open'))) +
      (o.open_games ? '. ' + (o.open_games === 1 ? L('1 partido busca jugadores', '1 match looking for players') : o.open_games + L(' partidos buscan jugadores', ' matches looking for players')) : '') +
      '</span></span><span class="go">' + L('Elegir', 'Choose') + '</span></button></li>').join('') + '</ul>';
  }

  function vCalendar() {
    const y = S.ym.y, m = S.ym.m;
    const first = new Date(y, m, 1), off = (first.getDay() + 6) % 7, n = new Date(y, m + 1, 0).getDate();
    const info = new Map(S.days.map((d) => [d.date, d]));
    const t = parse(S.today.date), last = parse(S.today.last_bookable);
    const isFirstMonth = y === t.getFullYear() && m === t.getMonth();
    const isLastMonth = y === last.getFullYear() && m === last.getMonth();
    let cells = DOW().map((d) => '<span class="dow" aria-hidden="true">' + d + '</span>').join('');
    for (let i = 0; i < off; i++) cells += '<span></span>';
    for (let d = 1; d <= n; d++) {
      const ds = y + '-' + pad(m + 1) + '-' + pad(d);
      const di = info.get(ds);
      const usable = !!(di && (di.available || di.open_games));
      const has = !!(di && di.open_games);
      cells += '<button type="button" data-a="day" data-d="' + ds + '" class="' + (ds === S.today.date ? 'today ' : '') + (ds === S.date ? 'sel ' : '') + (has ? 'has' : '') + '"' +
        (usable ? '' : ' disabled') + ' aria-label="' + fecha(ds) + (has ? L(', hay partidos buscando jugadores', ', matches looking for players') : '') + (usable ? '' : L(', no disponible', ', not available')) + '"' +
        (ds === S.date ? ' aria-pressed="true"' : '') + '>' + d + '</button>';
    }
    let h = crumbs(2) + '<h1 class="h">' + L('Elige día y hora', 'Pick a day and time') + '</h1>' +
      '<div class="cal-head"><button type="button" data-a="month" data-n="-1" aria-label="' + L('Mes anterior', 'Previous month') + '"' + (isFirstMonth ? ' disabled' : '') + '>‹</button><strong>' + MESES()[m] + ' ' + y + '</strong>' +
      '<button type="button" data-a="month" data-n="1" aria-label="' + L('Mes siguiente', 'Next month') + '"' + (isLastMonth ? ' disabled' : '') + '>›</button></div>' +
      '<div class="cal">' + cells + '</div><p class="legend"><i></i> ' + L('Hay alguien buscando partido ese día', 'Someone is looking for a match that day') + '</p>' +
      '<p class="small muted">' + L('Puedes agendar hasta el ', 'You can book until ') + fecha(S.today.last_bookable) + '.</p>';
    if (S.date) {
      // Al crear desde un bloque del inicio: desde AM se ofrece el día completo y
      // desde PM solo la tarde. Si el día es hoy, solo horas que aún no comienzan.
      const fromBlock = S.preset && S.preset.date === S.date;
      const half = fromBlock && S.preset.half === 'pm' ? 'pm' : null;
      const after = fromBlock && S.date === S.today.date ? nowHHMM() : null;
      const slots = S.slots.filter((s) => (!half || halfOf(s.time) === half) && (!after || s.time > after));
      h += '<h2 id="dia">' + cap(fecha(S.date)) + (half ? ' · ' + HALF(half) : '') + '</h2>';
      if (half) h += '<p class="small"><button type="button" class="linkbtn" data-a="allDay">' + L('Ver todo el día', 'See the whole day') + '</button></p>';
      h += slots.length ? '<ul class="slots">' + slots.map((s) => {
        const o = [];
        s.open_games.forEach((g) => {
          if (g.mine) o.push('<div class="opt mine"><span>' + L('Tu partido: ', 'Your match: ') + faltan(g.missing) + '</span></div>');
          else o.push('<button type="button" class="opt join" data-a="pickGame" data-id="' + esc(g.id) + '"><span>' + who(g.players) + ': ' + faltan(g.missing) +
            '<br><small>' + L('Busca ', 'Looking for ') + levelsText(g.accepted_levels) + '</small></span><b>' + L('Unirme', 'Join') + '</b></button>');
        });
        if (s.free_courts) o.push('<button type="button" class="opt" data-a="pickTime" data-t="' + s.time + '"><span>' + (coord() ? L('Hora disponible', 'Time available') : plural(s.free_courts, L('cancha libre', 'free court'), L('canchas libres', 'free courts'))) + '</span><b>' + L('Abrir partido', 'Open a match') + '</b></button>');
        if (!o.length) o.push('<div class="opt full">' + L('Completo', 'Full') + '</div>');
        return '<li class="slot"><time>' + s.time + '</time><div class="opts">' + o.join('') + '</div></li>';
      }).join('') + '</ul>' : '<p class="muted">' + L('No quedan horas disponibles ' + (half ? 'esa ' + HALF(half) + '.' : 'ese día.'), 'No times left ' + (half ? 'that ' + HALF(half) + '.' : 'that day.')) + '</p>';
    } else h += '<p class="muted" style="margin-top:1rem">' + L('Toca un día para ver las horas disponibles.', 'Tap a day to see the available times.') + '</p>';
    return h;
  }

  function levelRadios(sport, allowed, selected) {
    return '<fieldset style="border:0;padding:0;margin:0"><legend class="f" style="font-weight:700;font-size:.9rem;margin-top:.9rem">' + L('Tu nivel de juego', 'Your playing level') + ' <small style="font-weight:400" class="muted">' + L('(1 avanzado, 5 principiante)', '(1 advanced, 5 beginner)') + '</small></legend><div class="levels">' +
      sport.categories.map((c) => {
        const ok = !allowed || allowed.includes(c.level);
        return '<label class="lvl"' + (ok ? '' : ' style="opacity:.45"') + '><input type="radio" name="level" value="' + c.level + '"' + (selected === c.level && ok ? ' checked' : '') + (ok ? '' : ' disabled') +
          '><span class="n">' + c.level + '</span><span>' + esc(catLabel(c)) + (ok ? '' : ' <small>' + L('(este partido no lo acepta)', "(this match doesn't accept it)") + '</small>') + '</span></label>';
      }).join('') + '</div></fieldset>';
  }

  function vForm() {
    const g = S.game, sport = S.offer && S.offer.sport, venue = S.offer && S.offer.venue;
    if (!sport || !venue) return '<p>' + L('Ese partido ya no está disponible.', 'That match is no longer available.') + '</p><div class="actions"><button type="button" class="btn" data-a="go" data-v="home">' + L('Volver al inicio', 'Back to home') + '</button></div>';
    const date = g ? g.date : S.date, time = g ? g.time : S.time;
    const key = 'lvl_' + sport.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const myLevel = prefs[key] || null;
    const sizes = sport.match_sizes;
    let h = '<p class="crumbs"><button type="button" data-a="back">‹ ' + L('Volver', 'Back') + '</button></p><h1 class="h">' + (g ? L('Unirme al partido', 'Join the match') : L('Abrir partido', 'Open a match')) + '</h1>' +
      '<div class="card"><dl class="kv"><dt>' + L('Deporte', 'Sport') + '</dt><dd>' + esc(sportLabel(sport.name)) + '</dd><dt>' + L('Lugar', 'Place') + '</dt><dd>' + esc(venue.name) + '</dd><dt>' + L('Cuándo', 'When') + '</dt><dd>' + fechaHora(date, time) + '</dd>' +
      (g ? '<dt>' + L('Ya están', 'Already in') + '</dt><dd>' + who(g.players) + '</dd><dt>' + L('Busca', 'Looking for') + '</dt><dd>' + cap(levelsText(g.accepted_levels)) + ', ' + faltan(g.missing) + '</dd>' : '') + '</dl>' +
      (g ? '' : '<p class="small muted">' + (coord() ? L('Cuando se complete, les pasamos el contacto de todos para que reserven la cancha con el club.', "When it fills up, we'll share everyone's contact details so you can book the court with the club.") : L('La cancha se asigna cuando el partido se completa.', 'The court is assigned when the match fills up.')) + '</p>') + '</div>' +
      '<form data-f="play" novalidate>' +
      '<label class="f" for="ini">' + L('Tus iniciales', 'Your initials') + '</label><input id="ini" name="initials" type="text" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="JR" value="' + esc(prefs.initials || '') + '">' +
      levelRadios(sport, g ? g.accepted_levels : null, myLevel);
    if (!g) {
      if (sizes.length > 1) {
        h += '<fieldset style="border:0;padding:0;margin:0"><legend class="f" style="font-weight:700;font-size:.9rem;margin-top:.9rem">' + L('¿Cuántos jugadores?', 'How many players?') + '</legend><div class="checks">' +
          sizes.map((n) => '<label><input type="radio" name="capacity" value="' + n + '"' + (n === sizes[0] ? ' checked' : '') + '>' + n + (n === 2 ? ' (singles)' : L(' (dobles)', ' (doubles)')) + '</label>').join('') + '</div></fieldset>';
      }
      h += '<fieldset style="border:0;padding:0;margin:0"><legend class="f" style="font-weight:700;font-size:.9rem;margin-top:.9rem">' + L('Niveles que aceptas', 'Levels you accept') + ' <small style="font-weight:400" class="muted">' + L('(incluye el tuyo)', '(include yours)') + '</small></legend><div class="checks">' +
        sport.categories.map((c) => '<label title="' + esc(catLabel(c)) + '"><input type="checkbox" name="accepted_levels" value="' + c.level + '" checked>' + L('Nivel ', 'Level ') + c.level + '</label>').join('') + '</div></fieldset>';
    }
    h += '<label class="f" for="email">' + L('Email de contacto', 'Contact email') + '</label><input id="email" name="email" type="email" inputmode="email" autocomplete="email" placeholder="' + L('tu@correo.cl', 'you@email.com') + '" value="' + esc(prefs.email || '') + '">' +
      (waField() ? '<label class="f" for="wa">WhatsApp <small>' + L('(opcional)', '(optional)') + '</small></label><input id="wa" name="whatsapp" type="tel" inputmode="tel" autocomplete="tel" placeholder="+56 9 1234 5678" value="' + esc(prefs.whatsapp || '') + '">' : '') +
      (waField() && WHATSAPP_NOTICES ? '<div class="checks" style="margin-top:.6rem"><label><input type="checkbox" name="whatsapp_opt_in" value="1"' + (prefs.whatsapp_opt_in ? ' checked' : '') + '>' + L('Avísenme también por WhatsApp', 'Also notify me on WhatsApp') + '</label></div>' : '') +
      '<p class="small muted">' + L('Tu contacto solo se comparte con quienes jueguen contigo, cuando el partido se confirme.', 'Your contact details are only shared with the people playing with you, once the match is confirmed.') + '</p>' +
      (lang === 'en' ? '<p class="small muted">We\'ll email you in English.</p>' : '') +
      errBox() + '<div class="actions"><button class="btn block" type="submit"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? L('Enviando…', 'Sending…') : g ? L('Unirme al partido', 'Join the match') : L('Publicar partido', 'Post match')) + '</button></div></form>';
    return h;
  }

  const STATUS_TAG = {
    abierto: (g) => '<span class="tag">' + cap(faltan(g.missing)) + '</span>',
    confirmado: () => '<span class="tag ok">' + L('Confirmado', 'Confirmed') + '</span>',
    sin_cancha: () => '<span class="tag off">' + L('Sin cancha', 'No court') + '</span>',
    cancelado: () => '<span class="tag off">' + L('Cancelado', 'Cancelled') + '</span>',
  };

  function gameCard(g, withCancel) {
    let h = '<div class="card"><p>' + STATUS_TAG[g.status](g) + '</p>' +
      '<h3>' + esc(sportLabel(g.sport.name)) + ', ' + fecha(g.date) + L(' a las ', ' at ') + g.time + '</h3>' +
      '<dl class="kv"><dt>' + L('Lugar', 'Place') + '</dt><dd>' + esc(g.venue.name) + (g.venue.address ? ', ' + esc(g.venue.address) : '') + '</dd>' +
      (g.court ? '<dt>' + L('Cancha', 'Court') + '</dt><dd>' + esc(g.court.name) + (g.court.surface ? ', ' + esc(g.court.surface.toLowerCase()) : '') + (g.court.notes ? '. ' + esc(g.court.notes) : '') + '</dd>'
        : coord() ? (g.status === 'confirmado' ? '<dt>' + L('Cancha', 'Court') + '</dt><dd>' + L('Resérvenla con el club', 'Book it with the club') + '</dd>' : '')
        : '<dt>' + L('Cancha', 'Court') + '</dt><dd>' + (g.status === 'abierto' ? L('Se asigna cuando se complete', "Assigned when it's full") : g.status === 'sin_cancha' ? L('No quedó cancha libre', 'No free court left') : '—') + '</dd>') +
      '<dt>' + L('Juegan', 'Players') + '</dt><dd>' + who(g.players) + '</dd>' +
      (g.status === 'abierto' ? '<dt>' + L('Busca', 'Looking for') + '</dt><dd>' + cap(levelsText(g.accepted_levels)) + '</dd>' : '') + '</dl>';
    const map = (g.court && g.court.maps_url) || g.venue.maps_url;
    if (map && g.status !== 'cancelado') h += '<p><a href="' + esc(map) + '" target="_blank" rel="noopener">' + L('Cómo llegar (Google Maps)', 'Directions (Google Maps)') + '</a></p>';
    if (g.status === 'sin_cancha') h += '<p class="small">' + L('El partido se completó, pero ya no quedan canchas libres a esa hora. Elige otro turno o cancela tu cupo.', 'The match filled up, but there are no free courts left at that time. Pick another time or cancel your spot.') + '</p>';
    if (g.status === 'cancelado') h += '<p class="small">' + L('El administrador canceló este partido.', 'The administrator cancelled this match.') + '</p>';
    const others = g.players.filter((p) => !p.me && p.email);
    if (others.length) {
      h += '<h3>' + L('Contacto de tus compañeros', "Your partners' contact details") + '</h3>' + others.map((p) => {
        const wa = (p.whatsapp || '').replace(/\D/g, '');
        const msg = encodeURIComponent(L('Hola, soy tu compañero de ' + g.sport.name + ' por Peloteo: ' + fecha(g.date) + ' a las ' + g.time + '.',
          "Hi, I'm your " + sportLabel(g.sport.name) + ' partner from Peloteo: ' + fecha(g.date) + ' at ' + g.time + '.'));
        return '<p>' + esc(p.initials) + ': <a href="mailto:' + esc(p.email) + '">' + esc(p.email) + '</a>' +
          (wa ? L(' o ', ' or ') + '<a href="https://wa.me/' + wa + '?text=' + msg + '" target="_blank" rel="noopener">' + L('escribirle por WhatsApp', 'message on WhatsApp') + '</a>' : '') + '</p>';
      }).join('');
    }
    if (withCancel && g.status !== 'cancelado') {
      if (g.can_cancel) {
        h += '<div class="actions"><button type="button" class="btn danger sm" data-a="cancelMine" data-id="' + esc(g.id) + '">' + (S.confirm === g.id ? L('Toca de nuevo para cancelar', 'Tap again to cancel') : L('Cancelar mi cupo', 'Cancel my spot')) + '</button></div>';
      } else {
        h += '<p class="small muted">' + L('Ya no se puede cancelar: el plazo termina 1 hora antes del inicio.', 'It can no longer be cancelled: the deadline is 1 hour before the start.') + '</p>';
      }
    }
    return h + '</div>';
  }

  function vDone() {
    const g = S.done;
    if (!g) return '<p>' + L('Ese partido ya no existe.', 'That match no longer exists.') + '</p><div class="actions"><button type="button" class="btn" data-a="go" data-v="home">' + L('Volver al inicio', 'Back to home') + '</button></div>';
    const title = g.status === 'confirmado' ? L('¡Partido confirmado!', 'Match confirmed!') : g.status === 'sin_cancha' ? L('Partido completo, sin cancha', 'Match full, no court') : L('Partido publicado', 'Match posted');
    const text = g.status === 'confirmado' ? (g.court ? L('Ya tienen cancha asignada. Estos son los datos.', 'You have a court assigned. Here are the details.') : L('¡Ya están todos! Pónganse de acuerdo y reserven la cancha con el club.', "Everyone's in! Get in touch and book the court with the club."))
      : g.status === 'sin_cancha' ? L('Se completó, pero ya no quedan canchas libres a esa hora. Les avisaremos para elegir otro turno.', "It filled up, but there are no free courts left at that time. We'll let you know so you can pick another time.")
      : coord() ? L('Cuando se complete, te avisamos y les pasamos el contacto de todos para que reserven la cancha con el club.', "When it fills up, we'll let you know and share everyone's contact details so you can book the court with the club.")
      : L('Cuando se complete, les asignamos la primera cancha libre de ese turno y te avisamos.', "When it fills up, we'll assign the first free court at that time and let you know.");
    return '<h1 class="h">' + title + '</h1><p>' + text + '</p>' + gameCard(g, false) +
      '<div class="actions"><button type="button" class="btn" data-a="go" data-v="mine">' + L('Ver mis partidos', 'See my matches') + '</button><button type="button" class="btn ghost" data-a="go" data-v="home">' + L('Agendar otro', 'Book another') + '</button></div>';
  }

  // ---------------- búsqueda ----------------
  async function prepareSearch() {
    if (!S.sports.length) S.sports = (await get('/api/sports')) || [];
    if (!S.search) {
      const key = S.sportKey && S.sports.some((n) => n.key === S.sportKey) ? S.sportKey : (S.sports[0] ? S.sports[0].key : '');
      S.search = { sportKey: key, sportId: '', from: S.today.date, to: S.today.last_bookable, t1: '07:00', t2: '23:00', level: null };
      S.results = null;
    }
    await loadSearchOffers();
  }

  async function loadSearchOffers() {
    const q = S.search;
    S.searchOffers = q.sportKey ? (await get('/api/venues?sport=' + encodeURIComponent(q.sportKey))) || [] : [];
    if (!S.searchOffers.some((o) => o.sport.id === q.sportId)) {
      const pref = S.offer && S.searchOffers.find((o) => o.sport.id === S.offer.sport.id);
      q.sportId = pref ? pref.sport.id : (S.searchOffers[0] ? S.searchOffers[0].sport.id : '');
    }
    const offer = S.searchOffers.find((o) => o.sport.id === q.sportId);
    if (offer && !q.level) {
      const key = 'lvl_' + offer.sport.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      q.level = prefs[key] || null;
    }
  }

  function vSearch() {
    const q = S.search;
    const title = '<h1 class="h">' + L('Buscar jugadores', 'Find players') + '</h1>';
    if (!q) return title + '<p class="muted">' + L('Cargando…', 'Loading…') + '</p>';
    if (!S.sports.length) return title + '<p class="muted">' + L('Todavía no hay deportes disponibles.', 'No sports available yet.') + '</p>';
    const offer = S.searchOffers.find((o) => o.sport.id === q.sportId);
    let h = title + '<p class="muted">' + L('Encuentra partidos abiertos que aceptan tu nivel.', 'Find open matches that accept your level.') + '</p><form data-f="search" novalidate>' +
      '<div class="two"><div><label class="f" for="s-sp">' + L('Deporte', 'Sport') + '</label><select id="s-sp" name="sportKey" data-s="sportKey">' + S.sports.map((n) => '<option value="' + esc(n.key) + '"' + (n.key === q.sportKey ? ' selected' : '') + '>' + esc(sportLabel(n.name)) + '</option>').join('') + '</select></div>' +
      '<div><label class="f" for="s-ve">' + L('Lugar', 'Place') + '</label><select id="s-ve" name="sportId" data-s="sportId">' + S.searchOffers.map((o) => '<option value="' + esc(o.sport.id) + '"' + (o.sport.id === q.sportId ? ' selected' : '') + '>' + esc(o.venue.name) + '</option>').join('') + '</select></div></div>' +
      '<div class="two"><div><label class="f" for="s-f">' + L('Desde el día', 'From') + '</label><input id="s-f" name="from" type="date" value="' + q.from + '" min="' + S.today.date + '" max="' + S.today.last_bookable + '"></div>' +
      '<div><label class="f" for="s-t">' + L('Hasta el día', 'To') + '</label><input id="s-t" name="to" type="date" value="' + q.to + '" min="' + S.today.date + '" max="' + S.today.last_bookable + '"></div></div>' +
      '<div class="two"><div><label class="f" for="s-h1">' + L('Desde las', 'From (time)') + '</label><input id="s-h1" name="t1" type="time" value="' + q.t1 + '"></div>' +
      '<div><label class="f" for="s-h2">' + L('Hasta las', 'To (time)') + '</label><input id="s-h2" name="t2" type="time" value="' + q.t2 + '"></div></div>' +
      (offer ? levelRadios(offer.sport, null, q.level) : '') +
      errBox() + '<div class="actions"><button class="btn block" type="submit">' + L('Buscar partidos', 'Search matches') + '</button></div></form>';
    if (S.results) {
      const r = S.results;
      h += '<h2 id="resultados">' + (r.length ? (r.length === 1 ? L('1 partido encontrado', '1 match found') : r.length + L(' partidos encontrados', ' matches found')) : L('Nadie busca partido en ese rango', 'Nobody is looking for a match in that range')) + '</h2>';
      if (!r.length) h += '<p class="muted">' + L('Abre tú un partido y quien busque después te encontrará.', "Open a match yourself and whoever searches later will find you.") + '</p><div class="actions"><button type="button" class="btn ghost" data-a="openFromSearch">' + L('Abrir un partido', 'Open a match') + '</button></div>';
      else h += '<ul class="list">' + r.map((g) =>
        '<li><button type="button" class="row" data-a="pickResult" data-id="' + esc(g.id) + '"><span><span class="name">' + fechaHora(g.date, g.time) + '</span><span class="meta">' +
        who(g.players) + '. ' + cap(faltan(g.missing)) + '. ' + L('Busca ', 'Looking for ') + levelsText(g.accepted_levels) + '</span></span><span class="go">' + L('Unirme', 'Join') + '</span></button></li>').join('') + '</ul>';
    }
    return h;
  }

  function vMine() {
    let h = '<h1 class="h">' + L('Mis partidos', 'My matches') + '</h1>';
    if (!S.mineLoaded) return h + '<p class="muted">' + L('Cargando…', 'Loading…') + '</p>';
    if (!S.mine.length) return h + '<div class="card"><p>' + L('Aún no tienes partidos agendados.', "You don't have any matches booked yet.") + '</p><div class="actions"><button type="button" class="btn" data-a="go" data-v="home">' + L('Agendar un partido', 'Book a match') + '</button></div></div>';
    return h + S.mine.map((g) => gameCard(g, true)).join('') +
      '<p class="small muted">' + L('Tus partidos quedan guardados en este navegador. Cada correo de aviso trae un enlace para cancelar desde otro dispositivo.', 'Your matches are saved in this browser. Every notification email has a link to cancel from another device.') + '</p>';
  }

  // ---------------- enlace de cancelación (correo) ----------------
  function vToken() {
    let h = '<h1 class="h">' + L('Cancelar mi cupo', 'Cancel my spot') + '</h1>';
    if (S.tokenDone) {
      return h + '<div class="card"><p>' + L('Listo, liberaste tu cupo. Avisamos al resto de los jugadores.', "Done, you've freed up your spot. We've let the other players know.") + '</p><div class="actions"><button type="button" class="btn" data-a="go" data-v="home">' + L('Agendar otro partido', 'Book another match') + '</button></div></div>';
    }
    const g = S.tokenGame;
    if (!g) {
      return h + '<div class="card"><p>' + esc(S.err || L('Cargando…', 'Loading…')) + '</p>' + (S.err ? '<div class="actions"><button type="button" class="btn" data-a="go" data-v="home">' + L('Ir al inicio', 'Go to home') + '</button></div>' : '') + '</div>';
    }
    h += gameCard(g, false);
    if (g.status === 'cancelado') return h + '<p class="muted">' + L('Este partido ya fue cancelado; no tienes que hacer nada.', "This match was already cancelled; you don't need to do anything.") + '</p>';
    if (!g.can_cancel) return h + '<p class="muted">' + L('Ya no se puede cancelar: el plazo termina 1 hora antes del inicio.', 'It can no longer be cancelled: the deadline is 1 hour before the start.') + '</p>';
    return h + (S.err ? '<p class="err" role="alert">' + esc(S.err) + '</p>' : '') +
      '<p>' + L('Si no puedes jugar, libera tu cupo para que otro jugador pueda tomarlo. Avisaremos al resto.', "If you can't play, free up your spot so someone else can take it. We'll let the others know.") + '</p>' +
      '<div class="actions"><button type="button" class="btn danger" data-a="cancelToken">' + (S.confirm === 'token' ? L('Toca de nuevo para cancelar', 'Tap again to cancel') : L('Cancelar mi cupo', 'Cancel my spot')) + '</button>' +
      '<button type="button" class="btn ghost" data-a="go" data-v="home">' + L('No, mantenerlo', 'No, keep it') + '</button></div>';
  }

  async function openToken(token) {
    S.view = 'token'; S.token = token; S.tokenGame = null; S.tokenDone = false; S.err = ''; S.confirm = null;
    render();
    const r = await api('POST', '/api/token/game', { token });
    if (r.ok) S.tokenGame = r.data.game; else S.err = r.data.error || L('No pudimos abrir ese enlace.', "We couldn't open that link.");
    render();
  }

  // Enlaces de los correos: #cancelar=<token> y #mis-partidos. El token se
  // quita de la barra de direcciones para que no quede en el historial.
  function fromHash() {
    const h = location.hash;
    if (!h) return false;
    const m = /^#cancelar=([0-9a-f]{32})$/.exec(h);
    try { history.replaceState(null, '', location.pathname + location.search); } catch (e) { /* sin historial */ }
    if (m) { openToken(m[1]); return true; }
    if (h === '#mis-partidos') { go('mine'); return true; }
    return false;
  }

  function view() {
    switch (S.view) {
      case 'loading': return '<p class="muted" style="padding:2rem 0">' + L('Cargando canchas…', 'Loading courts…') + '</p>';
      case 'venue': return vVenue();
      case 'calendar': return vCalendar();
      case 'form': return vForm();
      case 'done': return vDone();
      case 'search': return vSearch();
      case 'mine': return vMine();
      case 'block': return vBlock();
      case 'token': return vToken();
      default: return vHome();
    }
  }

  let lastKey = '';
  function render() {
    const app = $('#app');
    const key = S.view + '|' + (S.game ? S.game.id : '') + '|' + (S.time || '');
    let saved = null, focus = null;
    const k = (el) => el.name + ((el.type === 'radio' || el.type === 'checkbox') ? '|' + el.value : '');
    if (key === lastKey) {
      saved = {};
      app.querySelectorAll('[name]').forEach((el) => { saved[k(el)] = (el.type === 'radio' || el.type === 'checkbox') ? el.checked : el.value; });
      const a = document.activeElement; if (a && a.id && app.contains(a)) focus = a.id;
    }
    lastKey = key;
    app.innerHTML = view();
    if (saved) {
      app.querySelectorAll('[name]').forEach((el) => {
        const kk = k(el);
        if (kk in saved && !el.dataset.s) { if (el.type === 'radio' || el.type === 'checkbox') el.checked = saved[kk]; else el.value = saved[kk]; }
      });
      if (focus) { const el = document.getElementById(focus); if (el) el.focus({ preventScroll: true }); }
    }
    if (S.field) { const el = app.querySelector('[name="' + S.field + '"]'); if (el) el.focus(); S.field = ''; }
    const n = activeMine();
    const langBtn = (l, code, name) => '<button type="button" data-a="lang" data-l="' + l + '" lang="' + l + '" aria-pressed="' + (lang === l) + '" aria-label="' + name + '" title="' + name + '">' + FLAGS[l] + '<span>' + code + '</span></button>';
    $('#bar').innerHTML = '<button type="button" class="brand" data-a="go" data-v="home"><img src="/img/logo.png" alt="' + L('Peloteo, ir al inicio', 'Peloteo, go to home') + '" width="648" height="120"></button><nav aria-label="' + L('Principal', 'Main') + '">' +
      '<button type="button" data-a="go" data-v="search" aria-current="' + (S.view === 'search') + '">' + icon('buscar', 18) + '<span class="lbl">' + L('Buscar', 'Search') + '</span></button>' +
      '<span class="langs" role="group" aria-label="Idioma / Language">' + langBtn('es', 'ESP', 'Español') + langBtn('en', 'ENG', 'English') + '</span>' +
      '<button type="button" data-a="go" data-v="mine" aria-current="' + (S.view === 'mine') + '">' + icon('mis', 18) + '<span class="lbl">' + L('Mis partidos', 'My matches') + '</span>' + (n ? '<b aria-label="' + n + L(' activos', ' active') + '">' + n + '</b>' : '') + '</button>' +
      '<a href="/admin/" class="navlink">' + icon('ajustes', 18) + '<span class="lbl">' + L('Configuración', 'Settings') + '</span></a></nav>';
  }

  // ---------------- formularios ----------------
  function formData(form) {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') { if (el.name === 'whatsapp_opt_in') out[el.name] = el.checked; else { (out[el.name] = out[el.name] || []); if (el.checked) out[el.name].push(Number(el.value)); } }
      else if (el.type === 'radio') { if (el.checked) out[el.name] = el.value; }
      else out[el.name] = el.value;
    }
    return out;
  }

  async function submitPlay(d) {
    const sport = S.offer.sport;
    const level = Number(d.level) || 0;
    const ini = (d.initials || '').toUpperCase().replace(/[^A-ZÑÁÉÍÓÚÜ]/g, '');
    S.err = ini.length < 2 || ini.length > 4 ? L('Escribe tus iniciales (2 a 4 letras).', 'Enter your initials (2 to 4 letters).')
      : !level ? L('Elige tu nivel de juego.', 'Choose your playing level.')
      : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((d.email || '').trim()) ? L('Revisa el email: lo usamos para avisarte.', 'Check your email address: we use it to keep you posted.')
      : (d.whatsapp && d.whatsapp.replace(/\D/g, '').length < 8) ? L('Revisa el número de WhatsApp o déjalo en blanco.', 'Check the WhatsApp number or leave it blank.')
      : (!S.game && !(d.accepted_levels || []).length) ? L('Elige qué niveles aceptas.', 'Choose which levels you accept.')
      : (!S.game && !(d.accepted_levels || []).includes(level)) ? L('Incluye tu propio nivel entre los aceptados.', 'Include your own level among the accepted ones.') : '';
    if (S.err) { render(); return; }

    const key = 'lvl_' + sport.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    prefs = Object.assign({}, prefs, { initials: ini, email: d.email.trim(), whatsapp: waField() ? d.whatsapp || '' : prefs.whatsapp || '', whatsapp_opt_in: !!d.whatsapp_opt_in });
    prefs[key] = level;
    LS.set('peloteo_prefs', prefs);

    const player = { initials: ini, level, email: d.email.trim(), whatsapp: waField() ? d.whatsapp || '' : '', whatsapp_opt_in: waField() && WHATSAPP_NOTICES && !!d.whatsapp_opt_in, lang };
    S.busy = true; S.err = ''; render();
    const r = S.game
      ? await api('POST', '/api/games/' + encodeURIComponent(S.game.id) + '/join', { player })
      : await api('POST', '/api/games', {
        sport_id: sport.id, date: S.date, time: S.time, capacity: d.capacity ? Number(d.capacity) : sport.match_sizes[0],
        accepted_levels: d.accepted_levels, player,
      });
    S.busy = false;
    if (!r.ok) {
      const code = r.data.code;
      if (code === 'turno_ocupado' || code === 'encuentro_completo' || code === 'turno_cerrado' || code === 'encuentro_cancelado' || code === 'encuentro_no_existe') {
        toast(r.data.error || L('Ese turno ya no está disponible. Elige otro.', 'That time is no longer available. Pick another one.'));
        const back = S.fromSearch ? 'search' : S.fromBlock ? 'block' : 'calendar';
        S.game = null;
        if (back === 'calendar' && S.date) { S.view = 'calendar'; await Promise.all([loadMonth(), loadDay()]); render(); }
        else go(back);
        return;
      }
      if (code === 'ya_inscrito') { toast(r.data.error); go('mine'); return; }
      S.err = r.data.error || L('No se pudo guardar. Inténtalo de nuevo.', "We couldn't save it. Please try again."); S.field = r.data.field || ''; render(); return;
    }
    S.done = r.data.game; S.game = null;
    await loadMine();
    go('done');
  }

  function rememberSport(key) { prefs = Object.assign({}, prefs, { sport: key }); LS.set('peloteo_prefs', prefs); }
  const submit = {
    play: submitPlay,
    create(d) { if (!d.sport) return; rememberSport(d.sport); S.preset = null; chooseSport(d.sport); },
    createIn(d) { if (!d.sport) return; rememberSport(d.sport); S.preset = { date: S.block.date, half: S.block.half }; S.fromBlock = false; chooseSport(d.sport); },
    async search(d) {
      const q = S.search;
      Object.assign(q, { from: d.from, to: d.to, t1: d.t1, t2: d.t2, level: Number(d.level) || null });
      if (!q.level) { S.err = L('Elige tu nivel de juego.', 'Choose your playing level.'); render(); return; }
      if (q.to < q.from || q.t2 < q.t1) { S.err = L('Revisa el rango: el final está antes del inicio.', 'Check the range: the end is before the start.'); render(); return; }
      S.err = '';
      const qs = new URLSearchParams({ sport_id: q.sportId, level: String(q.level), date_from: q.from, date_to: q.to, time_from: q.t1, time_to: q.t2 });
      const r = await api('GET', '/api/search?' + qs);
      if (!r.ok) { S.err = r.data.error || L('No se pudo buscar.', "We couldn't search."); render(); return; }
      S.results = r.data; render();
      const el = document.getElementById('resultados'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  };

  // ---------------- acciones ----------------
  const act = {
    go(d) { S.fromSearch = false; S.fromBlock = false; go(d.v); },
    block(d) { S.block = { date: d.d, half: d.h }; S.fromBlock = false; go('block'); },
    allDay() { S.preset = null; render(); },
    intro() { openIntro(); },
    lang(d) {
      if (d.l === lang) return;
      lang = d.l === 'en' ? 'en' : 'es'; saveLang(true); lastKey = ''; render();
      toast(L('Sitio en español.', 'Site in English.'));
    },
    async pickOpen(d) {
      const g = (S.blockGames || []).find((x) => x.id === d.id); if (!g) return;
      const offers = (await get('/api/venues?sport=' + encodeURIComponent(g.sport.key))) || [];
      const offer = offers.find((o) => o.sport.id === g.sport.id);
      if (!offer) { toast(L('Ese partido ya no está disponible.', 'That match is no longer available.')); go('block'); return; }
      S.offers = offers; S.offer = offer; S.sportKey = g.sport.key;
      S.game = g; S.date = g.date; S.time = g.time; S.fromSearch = false; S.fromBlock = true;
      go('form');
    },
    sport(d) { chooseSport(d.k); },
    offer(d) { chooseOffer(S.offers[Number(d.i)]); },
    toVenues() { if (S.offers.length > 1) go('venue'); else go('home'); },
    async toCalendar() { S.view = 'calendar'; S.game = null; render(); await loadDay(); render(); },
    async month(d) {
      S.ym = { y: S.ym.m + Number(d.n) > 11 ? S.ym.y + 1 : S.ym.m + Number(d.n) < 0 ? S.ym.y - 1 : S.ym.y, m: (S.ym.m + Number(d.n) + 12) % 12 };
      S.date = null; S.slots = []; render(); await loadMonth(); render();
    },
    async day(d) {
      S.date = d.d; S.slots = []; render(); await loadDay(); render();
      const el = document.getElementById('dia'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
    pickTime(d) { S.time = d.t; S.game = null; S.fromSearch = false; S.fromBlock = false; go('form'); },
    pickGame(d) {
      for (const s of S.slots) { const g = s.open_games.find((x) => x.id === d.id); if (g) { S.game = g; S.time = g.time; break; } }
      S.fromSearch = false; S.fromBlock = false; go('form');
    },
    pickResult(d) {
      const g = (S.results || []).find((x) => x.id === d.id); if (!g) return;
      const offer = S.searchOffers.find((o) => o.sport.id === S.search.sportId);
      S.offer = offer; S.sportKey = S.search.sportKey; S.game = g; S.date = g.date; S.time = g.time; S.fromSearch = true;
      go('form');
    },
    back() { if (S.fromSearch) go('search'); else if (S.fromBlock) go('block'); else act.toCalendar(); },
    async openFromSearch() {
      const offer = S.searchOffers.find((o) => o.sport.id === S.search.sportId);
      if (!offer) { go('home'); return; }
      S.sportKey = S.search.sportKey; S.offers = S.searchOffers; chooseOffer(offer);
    },
    async cancelToken() {
      if (S.confirm !== 'token') { S.confirm = 'token'; render(); return; }
      S.confirm = null;
      const r = await api('POST', '/api/token/cancel', { token: S.token });
      if (!r.ok) {
        S.err = r.data.error || L('No se pudo cancelar.', "We couldn't cancel it.");
        const again = await api('POST', '/api/token/game', { token: S.token });
        S.tokenGame = again.ok ? again.data.game : null;
        render(); return;
      }
      S.tokenDone = true; S.token = null; await loadMine(); render();
    },
    async cancelMine(d) {
      if (S.confirm !== d.id) { S.confirm = d.id; render(); return; }
      S.confirm = null;
      const r = await api('POST', '/api/games/' + encodeURIComponent(d.id) + '/cancel', {});
      if (!r.ok) { toast(r.data.error || L('No se pudo cancelar.', "We couldn't cancel it.")); await loadMine(); render(); return; }
      toast(L('Cancelaste tu cupo.', 'You cancelled your spot.')); await loadMine(); render();
    },
  };

  // ---------------- guía de bienvenida ----------------
  // Cuatro pasos que explican para qué sirve Peloteo. Aparece al entrar hasta que
  // se marca "No volver a mostrar" en el último paso; eso se guarda en la cookie
  // peloteo_intro (400 días). Sin marcarla, vuelve a aparecer en la próxima visita
  // (no en la misma). Se puede abrir de nuevo con "¿Cómo funciona?" en el inicio.
  const INTRO_COOKIE = 'peloteo_intro';
  const introSeen = () => document.cookie.split(/;\s*/).includes(INTRO_COOKIE + '=1');
  const introRemember = () => {
    document.cookie = INTRO_COOKIE + '=1; Max-Age=34560000; Path=/; SameSite=Lax' + (location.protocol === 'https:' ? '; Secure' : '');
  };
  // Ilustraciones: siempre sobre verde cancha, así se ven igual en modo claro y oscuro.
  const ART = () => {
    const W = 'rgba(255,255,255,.9)', LINE = 'rgba(255,255,255,.22)', BALL = '#D7E845', INK = '#1B2905', OR = '#EE8A24';
    const court = '<g fill="none" stroke="' + LINE + '" stroke-width="1.5"><rect x="18" y="14" width="204" height="112" rx="2"/><path d="M18 30h204M18 110h204M120 14v112M60 30v80M180 30v80M60 70h120"/></g>';
    const ball = (x, y, r) => '<circle cx="' + x + '" cy="' + y + '" r="' + r + '" fill="' + BALL + '"/>' +
      '<path d="M' + (x - r * 0.72) + ' ' + (y - r * 0.7) + 'c' + (r * 0.55) + ' ' + (r * 0.45) + ' ' + (r * 0.55) + ' ' + (r * 0.95) + ' 0 ' + (r * 1.4) +
      'M' + (x + r * 0.72) + ' ' + (y - r * 0.7) + 'c' + (-r * 0.55) + ' ' + (r * 0.45) + ' ' + (-r * 0.55) + ' ' + (r * 0.95) + ' 0 ' + (r * 1.4) +
      '" fill="none" stroke="' + INK + '" stroke-opacity=".55" stroke-width="' + Math.max(1.5, r / 9) + '" stroke-linecap="round"/>';
    const person = (x, y, c) => '<g fill="none" stroke="' + c + '" stroke-width="3.5" stroke-linecap="round"><circle cx="' + x + '" cy="' + y + '" r="10"/><path d="M' + (x - 17) + ' ' + (y + 38) + 'a17 17 0 0 1 34 0"/></g>';
    const spark = (x, y, c) => '<path d="M' + x + ' ' + (y - 7) + 'v14M' + (x - 7) + ' ' + y + 'h14" stroke="' + c + '" stroke-width="2.5" stroke-linecap="round"/>';
    const svg = (inner) => '<svg viewBox="0 0 240 140" aria-hidden="true" focusable="false"><rect width="240" height="140" fill="#1E6B4F"/>' + court + inner + '</svg>';
    // Bloques AM (redondeado arriba) y PM (redondeado abajo), como en el inicio.
    const blk = (x, y, top, fill) => '<path d="' + (top
      ? 'M' + x + ' ' + (y + 26) + 'V' + (y + 6) + 'a6 6 0 0 1 6-6h14a6 6 0 0 1 6 6V' + (y + 26) + 'z'
      : 'M' + x + ' ' + y + 'h26V' + (y + 20) + 'a6 6 0 0 1-6 6H' + (x + 6) + 'a6 6 0 0 1-6-6z') + '" fill="' + fill + '"/>';
    const days = L(['L', 'M', 'M', 'J', 'V'], ['M', 'T', 'W', 'T', 'F']);
    return [
      // 1. Dos jugadores y la pelota que va de uno a otro.
      svg(person(62, 52, W) + person(178, 52, W) +
        '<path d="M80 50Q120 0 160 50" fill="none" stroke="' + BALL + '" stroke-width="2.5" stroke-dasharray="2 7" stroke-linecap="round"/>' + ball(120, 27, 9) +
        '<rect x="' + L(84, 78) + '" y="104" width="' + L(72, 84) + '" height="20" rx="10" fill="' + BALL + '"/><text x="120" y="118" text-anchor="middle" font-size="11" font-weight="800" fill="' + INK + '">' + L('¿JUGAMOS?', "LET'S PLAY?") + '</text>'),
      // 2. El calendario de bloques AM y PM, con uno naranjo elegido y su hora.
      svg(days.map((d, i) => {
        const x = 47 + i * 30, pick = i === 2;
        return '<text x="' + (x + 13) + '" y="30" text-anchor="middle" font-size="10" font-weight="800" fill="' + W + '">' + d + '</text>' +
          blk(x, 36, true, i === 3 ? OR : '#FFFFFF') + blk(x, 64, false, pick || i === 0 ? OR : '#FFFFFF') +
          (pick ? '<rect x="' + (x - 3.5) + '" y="60.5" width="33" height="33" rx="8" fill="none" stroke="' + BALL + '" stroke-width="3"/>' : '');
      }).join('') +
        '<path d="M120 96v8" stroke="' + BALL + '" stroke-width="3" stroke-linecap="round"/>' +
        '<rect x="84" y="104" width="72" height="22" rx="11" fill="' + BALL + '"/><text x="120" y="119" text-anchor="middle" font-size="12" font-weight="800" fill="' + INK + '">18:00</text>'),
      // 3. Dos mensajes entre los jugadores para ponerse de acuerdo.
      svg('<path d="M30 26h138a10 10 0 0 1 10 10v16a10 10 0 0 1-10 10H50l-12 9v-9h-8a10 10 0 0 1-10-10V36a10 10 0 0 1 10-10z" fill="#FFFFFF"/>' +
        '<text x="32" y="48" font-size="11.5" font-weight="700" fill="#14251D">' + L('¿Reservo yo la cancha?', 'Shall I book the court?') + '</text>' +
        '<path d="M72 78h138a10 10 0 0 1 10 10v16a10 10 0 0 1-10 10h-8v9l-12-9H72a10 10 0 0 1-10-10V88a10 10 0 0 1 10-10z" fill="' + BALL + '"/>' +
        '<text x="74" y="100" font-size="11.5" font-weight="700" fill="' + INK + '">' + L('¡Dale! Nos vemos ahí.', 'Great! See you there.') + '</text>'),
      // 4. A jugar: la pelota en movimiento y una celebración.
      svg('<g stroke="' + W + '" stroke-width="3" stroke-linecap="round"><path d="M56 58h26M46 72h32M58 86h22"/></g>' + ball(120, 72, 27) +
        spark(176, 40, OR) + spark(194, 92, BALL) + spark(66, 112, W) + spark(168, 112, OR)),
    ];
  };
  const introSteps = () => [
    { t: L('Encuentra con quién jugar', 'Find someone to play with'), p: L('¿Tienes ganas de jugar y te falta con quién? En Peloteo te pones de acuerdo con otras personas de tu nivel para armar un partido. No necesitas crear una cuenta.',
      'Want to play but have no one to play with? On Peloteo you team up with other people at your level to set up a match. No account needed.') },
    { t: L('Elige el día y la hora', 'Pick the day and time'), p: L('Los bloques naranjos del inicio son partidos donde alguien busca jugador: súmate a uno. Si ninguno te acomoda, crea el tuyo eligiendo deporte, lugar, día y hora, y te avisamos cuando alguien se una.',
      "The orange blocks on the home page are matches where someone is looking for a player: join one. If none suits you, create your own by picking the sport, place, day and time, and we'll let you know when someone joins.") },
    { t: L('Pónganse de acuerdo', 'Get in touch'), p: coord()
      ? L('Cuando el partido se completa, les avisamos por correo y les compartimos el contacto de cada uno, para que se escriban y reserven la cancha con el club.',
        "When the match fills up, we email everyone and share each player's contact details so you can talk and book the court with the club.")
      : L('Cuando el partido se completa, les asignamos una cancha, les avisamos por correo y les compartimos el contacto de cada uno para que se escriban.',
        "When the match fills up, we assign a court, email everyone and share each player's contact details so you can talk.") },
    { t: L('¡Listo, a jugar!', "All set, let's play!"), p: L('Solo queda llegar a la cancha y disfrutar. Si te surge algo, libera tu cupo desde «Mis partidos» hasta una hora antes, así otra persona puede tomarlo.',
      'All that\'s left is to show up and enjoy. If something comes up, free your spot from “My matches” up to one hour before, so someone else can take it.') },
  ];
  let introStep = 0;
  function introRender(dlg) {
    const steps = introSteps(), st = steps[introStep], last = introStep === steps.length - 1;
    const keep = dlg.querySelector('input[name="intro_hide"]');
    const checked = keep ? keep.checked : false;
    dlg.innerHTML = '<div class="art">' + ART()[introStep] + '<button type="button" class="x" data-i="close" aria-label="' + L('Cerrar la guía', 'Close the guide') + '">×</button></div>' +
      '<div class="body"><p class="step">' + L('Paso ', 'Step ') + (introStep + 1) + L(' de ', ' of ') + steps.length + '</p>' +
      '<h2 id="intro-t" tabindex="-1">' + esc(st.t) + '</h2><p id="intro-p">' + esc(st.p) + '</p>' +
      (last ? '<label class="hide"><input type="checkbox" name="intro_hide"' + (checked ? ' checked' : '') + '>' + L('No volver a mostrar esta guía', "Don't show this guide again") + '</label>' : '') +
      '<div class="nav"><span class="dots" aria-hidden="true">' + steps.map((_, i) => '<i' + (i === introStep ? ' class="on"' : '') + '></i>').join('') + '</span>' +
      (introStep ? '<button type="button" class="btn ghost sm" data-i="prev">' + L('Atrás', 'Back') + '</button>' : '<button type="button" class="btn ghost sm" data-i="close">' + L('Saltar', 'Skip') + '</button>') +
      '<button type="button" class="btn sm" data-i="' + (last ? 'done' : 'next') + '">' + (last ? L('¡A jugar!', "Let's play!") : L('Siguiente', 'Next')) + '</button></div></div>';
    const h = dlg.querySelector('#intro-t'); if (h) h.focus({ preventScroll: true });
  }
  function openIntro() {
    let dlg = document.getElementById('intro');
    if (!dlg) {
      dlg = document.createElement('dialog');
      dlg.id = 'intro'; dlg.className = 'intro';
      dlg.setAttribute('aria-labelledby', 'intro-t'); dlg.setAttribute('aria-describedby', 'intro-p');
      document.body.appendChild(dlg);
      dlg.addEventListener('click', (e) => {
        if (e.target === dlg) { dlg.close(); return; } // toque fuera de la ventana
        const b = e.target.closest('[data-i]'); if (!b) return;
        const a = b.dataset.i;
        if (a === 'next' || a === 'prev') { introStep += a === 'next' ? 1 : -1; introRender(dlg); }
        else dlg.close();
      });
      dlg.addEventListener('keydown', (e) => {
        if (e.target.name === 'intro_hide') return;
        if (e.key === 'ArrowRight' && introStep < 3) { introStep++; introRender(dlg); }
        if (e.key === 'ArrowLeft' && introStep > 0) { introStep--; introRender(dlg); }
      });
      // Al cerrar de cualquier forma (botón, Esc o tocando fuera) se respeta la casilla.
      dlg.addEventListener('close', () => {
        const keep = dlg.querySelector('input[name="intro_hide"]');
        if (keep && keep.checked) introRemember();
      });
    }
    introStep = 0;
    introRender(dlg);
    if (typeof dlg.showModal === 'function') dlg.showModal(); else dlg.setAttribute('open', '');
    const h = dlg.querySelector('#intro-t'); if (h) h.focus({ preventScroll: true });
  }
  function maybeIntro() {
    if (introSeen()) return;
    try { if (sessionStorage.getItem(INTRO_COOKIE)) return; sessionStorage.setItem(INTRO_COOKIE, '1'); } catch (e) { /* sin almacenamiento: se muestra igual */ }
    openIntro();
  }

  // ---------------- arranque ----------------
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-a]');
    if (!el || el.disabled) return;
    const f = act[el.dataset.a];
    if (f) { e.preventDefault(); f(el.dataset, el); }
  });
  document.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-f]');
    if (!form) return;
    e.preventDefault();
    const f = submit[form.dataset.f];
    if (f) f(formData(form));
  });
  document.addEventListener('change', async (e) => {
    const el = e.target;
    if (el.dataset && el.dataset.s && S.search) {
      S.search[el.dataset.s] = el.value;
      if (el.dataset.s === 'sportKey') { S.search.sportId = ''; S.search.level = null; }
      if (el.dataset.s === 'sportId') S.search.level = null;
      S.results = null;
      await loadSearchOffers(); render();
    }
    // Al elegir tu nivel al abrir un partido, se marca entre los aceptados.
    if (el.name === 'level' && el.form && el.form.dataset.f === 'play') {
      const box = el.form.querySelector('input[name="accepted_levels"][value="' + el.value + '"]');
      if (box) box.checked = true;
    }
  });

  (async function boot() {
    saveLang(false); // lang y título de la página; la cookie solo se escribe al elegir idioma
    const [today, sports, open] = await Promise.all([get('/api/today'), get('/api/sports'), get('/api/open')]);
    if (!today) { $('#app').innerHTML = '<div class="card"><h2>' + L('No pudimos cargar las canchas', "We couldn't load the courts") + '</h2><p class="muted">' + L('Revisa tu conexión y vuelve a intentarlo.', 'Check your connection and try again.') + '</p><div class="actions"><button class="btn" onclick="location.reload()">' + L('Reintentar', 'Try again') + '</button></div></div>'; return; }
    S.today = today; todayLoadedAt = Date.now(); S.sports = sports || []; S.open = open || [];
    if (!fromHash()) { S.view = 'home'; render(); maybeIntro(); }
    await loadMine(); render();
  })();
  window.addEventListener('hashchange', () => { if (S.today) fromHash(); });
})();
