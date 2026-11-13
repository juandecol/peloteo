// Peloteo: flujo público. Deporte → lugar → calendario → horas → formulario →
// confirmación, búsqueda de jugadores y "Mis partidos".
// Sin framework. Pantallas y textos tomados del prototipo (referencia/peloteo.html),
// con las reglas actuales de CLAUDE.md: quien abre elige cuántos jugadores y qué
// niveles acepta, y la cancha se asigna recién al completarse el partido.
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const DOW = ['lu', 'ma', 'mi', 'ju', 'vi', 'sá', 'do'];
  const pad = (n) => String(n).padStart(2, '0');
  const parse = (s) => { const a = s.split('-').map(Number); return new Date(a[0], a[1] - 1, a[2], 12); };
  const fecha = (s) => { const d = parse(s); return DIAS[d.getDay()] + ' ' + d.getDate() + ' de ' + MESES[d.getMonth()]; };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const plural = (n, uno, varios) => (n === 1 ? '1 ' + uno : n + ' ' + varios);
  const faltan = (n) => (n === 1 ? 'falta 1 jugador' : 'faltan ' + n + ' jugadores');
  const levelsText = (ls) => (ls.length === 1 ? 'nivel ' + ls[0] : ls.length === 5 ? 'todos los niveles' : 'niveles ' + ls.slice(0, -1).join(', ') + ' y ' + ls[ls.length - 1]);
  const who = (players) => players.map((p) => esc(p.initials) + ' (nivel ' + p.level + ')').join(', ');

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
      return { ok: false, status: 0, data: { error: 'No hay conexión. Revisa tu internet e inténtalo de nuevo.' } };
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
    if (view === 'home') { S.sports = (await get('/api/sports')) || []; }
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
    const t = parse(S.today.date);
    S.ym = { y: t.getFullYear(), m: t.getMonth() };
    S.date = null; S.slots = [];
    S.view = 'calendar'; render(); window.scrollTo(0, 0);
    await loadMonth(); render();
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
  const sportName = () => (S.offer ? S.offer.sport.name : '');

  function crumbs(upTo) {
    const parts = [];
    if (S.offer) parts.push('<button type="button" data-a="go" data-v="home">' + esc(sportName()) + '</button>');
    if (upTo >= 2 && S.offer) parts.push('<span>›</span><button type="button" data-a="toVenues">' + esc(S.offer.venue.name) + '</button>');
    if (upTo >= 3 && S.date) parts.push('<span>›</span><button type="button" data-a="toCalendar">' + esc(fecha(S.date)) + '</button>');
    return parts.length ? '<p class="crumbs">' + parts.join('') + '</p>' : '';
  }

  function vHome() {
    let h = '<section class="hero"><h1>¿Jugamos?</h1><p>Elige deporte, lugar y hora. Si alguien de tu nivel busca partido, les asignamos cancha.</p></section>';
    if (!S.sports.length) {
      return h + '<div class="card"><h2>Todavía no hay deportes disponibles</h2><p class="muted">Pronto aparecerán aquí las canchas para agendar.</p></div>';
    }
    h += '<h2>Elige tu deporte</h2><ul class="list">' + S.sports.map((n) =>
      '<li><button type="button" class="row tile" data-a="sport" data-k="' + esc(n.key) + '"><span><span class="name">' + esc(n.name) + '</span><span class="meta">' +
      plural(n.venues, 'lugar', 'lugares') + ', ' + plural(n.courts, 'cancha', 'canchas') + '</span></span><span class="go">Elegir</span></button></li>').join('') + '</ul>';
    h += '<h2>¿Buscas con quién jugar?</h2><ul class="list"><li><button type="button" class="row" data-a="go" data-v="search"><span><span class="name">Buscar jugadores</span><span class="meta">Filtra por lugar, fechas, horas y tu nivel</span></span><span class="go">Buscar</span></button></li></ul>';
    return h;
  }

  function vVenue() {
    if (!S.offers.length) return '<p>Ese deporte ya no está disponible.</p><div class="actions"><button type="button" class="btn" data-a="go" data-v="home">Volver al inicio</button></div>';
    return '<p class="crumbs"><button type="button" data-a="go" data-v="home">‹ Deportes</button></p><h1 class="h">¿Dónde quieres jugar?</h1><ul class="list">' + S.offers.map((o, i) =>
      '<li><button type="button" class="row" data-a="offer" data-i="' + i + '"><span><span class="name">' + esc(o.venue.name) + '</span><span class="meta">' +
      esc(o.venue.address || '') + (o.venue.address ? '. ' : '') + plural(o.courts, 'cancha operativa', 'canchas operativas') +
      (o.open_games ? '. ' + (o.open_games === 1 ? '1 partido busca jugadores' : o.open_games + ' partidos buscan jugadores') : '') +
      '</span></span><span class="go">Elegir</span></button></li>').join('') + '</ul>';
  }

  function vCalendar() {
    const y = S.ym.y, m = S.ym.m;
    const first = new Date(y, m, 1), off = (first.getDay() + 6) % 7, n = new Date(y, m + 1, 0).getDate();
    const info = new Map(S.days.map((d) => [d.date, d]));
    const t = parse(S.today.date), last = parse(S.today.last_bookable);
    const isFirstMonth = y === t.getFullYear() && m === t.getMonth();
    const isLastMonth = y === last.getFullYear() && m === last.getMonth();
    let cells = DOW.map((d) => '<span class="dow" aria-hidden="true">' + d + '</span>').join('');
    for (let i = 0; i < off; i++) cells += '<span></span>';
    for (let d = 1; d <= n; d++) {
      const ds = y + '-' + pad(m + 1) + '-' + pad(d);
      const di = info.get(ds);
      const usable = !!(di && (di.available || di.open_games));
      const has = !!(di && di.open_games);
      cells += '<button type="button" data-a="day" data-d="' + ds + '" class="' + (ds === S.today.date ? 'today ' : '') + (ds === S.date ? 'sel ' : '') + (has ? 'has' : '') + '"' +
        (usable ? '' : ' disabled') + ' aria-label="' + fecha(ds) + (has ? ', hay partidos buscando jugadores' : '') + (usable ? '' : ', no disponible') + '"' +
        (ds === S.date ? ' aria-pressed="true"' : '') + '>' + d + '</button>';
    }
    let h = crumbs(2) + '<h1 class="h">Elige día y hora</h1>' +
      '<div class="cal-head"><button type="button" data-a="month" data-n="-1" aria-label="Mes anterior"' + (isFirstMonth ? ' disabled' : '') + '>‹</button><strong>' + MESES[m] + ' ' + y + '</strong>' +
      '<button type="button" data-a="month" data-n="1" aria-label="Mes siguiente"' + (isLastMonth ? ' disabled' : '') + '>›</button></div>' +
      '<div class="cal">' + cells + '</div><p class="legend"><i></i> Hay alguien buscando partido ese día</p>' +
      '<p class="small muted">Puedes agendar hasta el ' + fecha(S.today.last_bookable) + '.</p>';
    if (S.date) {
      h += '<h2 id="dia">' + cap(fecha(S.date)) + '</h2>';
      h += S.slots.length ? '<ul class="slots">' + S.slots.map((s) => {
        const o = [];
        s.open_games.forEach((g) => {
          if (g.mine) o.push('<div class="opt mine"><span>Tu partido: ' + faltan(g.missing) + '</span></div>');
          else o.push('<button type="button" class="opt join" data-a="pickGame" data-id="' + esc(g.id) + '"><span>' + who(g.players) + ': ' + faltan(g.missing) +
            '<br><small>Busca ' + levelsText(g.accepted_levels) + '</small></span><b>Unirme</b></button>');
        });
        if (s.free_courts) o.push('<button type="button" class="opt" data-a="pickTime" data-t="' + s.time + '"><span>' + plural(s.free_courts, 'cancha libre', 'canchas libres') + '</span><b>Abrir partido</b></button>');
        if (!o.length) o.push('<div class="opt full">Completo</div>');
        return '<li class="slot"><time>' + s.time + '</time><div class="opts">' + o.join('') + '</div></li>';
      }).join('') + '</ul>' : '<p class="muted">No quedan horas disponibles ese día.</p>';
    } else h += '<p class="muted" style="margin-top:1rem">Toca un día para ver las horas disponibles.</p>';
    return h;
  }

  function levelRadios(sport, allowed, selected) {
    return '<fieldset style="border:0;padding:0;margin:0"><legend class="f" style="font-weight:700;font-size:.9rem;margin-top:.9rem">Tu nivel de juego <small style="font-weight:400" class="muted">(1 avanzado, 5 principiante)</small></legend><div class="levels">' +
      sport.categories.map((c) => {
        const ok = !allowed || allowed.includes(c.level);
        return '<label class="lvl"' + (ok ? '' : ' style="opacity:.45"') + '><input type="radio" name="level" value="' + c.level + '"' + (selected === c.level && ok ? ' checked' : '') + (ok ? '' : ' disabled') +
          '><span class="n">' + c.level + '</span><span>' + esc(c.label) + (ok ? '' : ' <small>(este partido no lo acepta)</small>') + '</span></label>';
      }).join('') + '</div></fieldset>';
  }

  function vForm() {
    const g = S.game, sport = S.offer && S.offer.sport, venue = S.offer && S.offer.venue;
    if (!sport || !venue) return '<p>Ese partido ya no está disponible.</p><div class="actions"><button type="button" class="btn" data-a="go" data-v="home">Volver al inicio</button></div>';
    const date = g ? g.date : S.date, time = g ? g.time : S.time;
    const key = 'lvl_' + sport.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    const myLevel = prefs[key] || null;
    const sizes = sport.match_sizes;
    let h = '<p class="crumbs"><button type="button" data-a="back">‹ Volver</button></p><h1 class="h">' + (g ? 'Unirme al partido' : 'Abrir partido') + '</h1>' +
      '<div class="card"><dl class="kv"><dt>Deporte</dt><dd>' + esc(sport.name) + '</dd><dt>Lugar</dt><dd>' + esc(venue.name) + '</dd><dt>Cuándo</dt><dd>' + cap(fecha(date)) + ', ' + time + '</dd>' +
      (g ? '<dt>Ya están</dt><dd>' + who(g.players) + '</dd><dt>Busca</dt><dd>' + cap(levelsText(g.accepted_levels)) + ', ' + faltan(g.missing) + '</dd>' : '') + '</dl>' +
      (g ? '' : '<p class="small muted">La cancha se asigna cuando el partido se completa.</p>') + '</div>' +
      '<form data-f="play" novalidate>' +
      '<label class="f" for="ini">Tus iniciales</label><input id="ini" name="initials" type="text" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="JR" value="' + esc(prefs.initials || '') + '">' +
      levelRadios(sport, g ? g.accepted_levels : null, myLevel);
    if (!g) {
      if (sizes.length > 1) {
        h += '<fieldset style="border:0;padding:0;margin:0"><legend class="f" style="font-weight:700;font-size:.9rem;margin-top:.9rem">¿Cuántos jugadores?</legend><div class="checks">' +
          sizes.map((n) => '<label><input type="radio" name="capacity" value="' + n + '"' + (n === sizes[0] ? ' checked' : '') + '>' + n + (n === 2 ? ' (singles)' : ' (dobles)') + '</label>').join('') + '</div></fieldset>';
      }
      h += '<fieldset style="border:0;padding:0;margin:0"><legend class="f" style="font-weight:700;font-size:.9rem;margin-top:.9rem">Niveles que aceptas <small style="font-weight:400" class="muted">(incluye el tuyo)</small></legend><div class="checks">' +
        sport.categories.map((c) => '<label title="' + esc(c.label) + '"><input type="checkbox" name="accepted_levels" value="' + c.level + '" checked>Nivel ' + c.level + '</label>').join('') + '</div></fieldset>';
    }
    h += '<label class="f" for="email">Email de contacto</label><input id="email" name="email" type="email" inputmode="email" autocomplete="email" placeholder="tu@correo.cl" value="' + esc(prefs.email || '') + '">' +
      '<label class="f" for="wa">WhatsApp <small>(opcional)</small></label><input id="wa" name="whatsapp" type="tel" inputmode="tel" autocomplete="tel" placeholder="+56 9 1234 5678" value="' + esc(prefs.whatsapp || '') + '">' +
      '<div class="checks" style="margin-top:.6rem"><label><input type="checkbox" name="whatsapp_opt_in" value="1"' + (prefs.whatsapp_opt_in ? ' checked' : '') + '>Avísenme también por WhatsApp</label></div>' +
      '<p class="small muted">Tu contacto solo se comparte con quienes jueguen contigo, cuando el partido se confirme.</p>' +
      errBox() + '<div class="actions"><button class="btn block" type="submit"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Enviando…' : g ? 'Unirme al partido' : 'Publicar partido') + '</button></div></form>';
    return h;
  }

  const STATUS_TAG = {
    abierto: (g) => '<span class="tag">' + cap(faltan(g.missing)) + '</span>',
    confirmado: () => '<span class="tag ok">Confirmado</span>',
    sin_cancha: () => '<span class="tag off">Sin cancha</span>',
    cancelado: () => '<span class="tag off">Cancelado</span>',
  };

  function gameCard(g, withCancel) {
    let h = '<div class="card"><p>' + STATUS_TAG[g.status](g) + '</p>' +
      '<h3>' + esc(g.sport.name) + ', ' + fecha(g.date) + ' a las ' + g.time + '</h3>' +
      '<dl class="kv"><dt>Lugar</dt><dd>' + esc(g.venue.name) + (g.venue.address ? ', ' + esc(g.venue.address) : '') + '</dd>' +
      '<dt>Cancha</dt><dd>' + (g.court ? esc(g.court.name) + (g.court.surface ? ', ' + esc(g.court.surface.toLowerCase()) : '') + (g.court.notes ? '. ' + esc(g.court.notes) : '')
        : g.status === 'abierto' ? 'Se asigna cuando se complete' : g.status === 'sin_cancha' ? 'No quedó cancha libre' : '—') + '</dd>' +
      '<dt>Juegan</dt><dd>' + who(g.players) + '</dd>' +
      (g.status === 'abierto' ? '<dt>Busca</dt><dd>' + cap(levelsText(g.accepted_levels)) + '</dd>' : '') + '</dl>';
    const map = (g.court && g.court.maps_url) || g.venue.maps_url;
    if (map && g.status !== 'cancelado') h += '<p><a href="' + esc(map) + '" target="_blank" rel="noopener">Cómo llegar (Google Maps)</a></p>';
    if (g.status === 'sin_cancha') h += '<p class="small">El partido se completó, pero ya no quedan canchas libres a esa hora. Elige otro turno o cancela tu cupo.</p>';
    if (g.status === 'cancelado') h += '<p class="small">El administrador canceló este partido.</p>';
    const others = g.players.filter((p) => !p.me && p.email);
    if (others.length) {
      h += '<h3>Contacto de tus compañeros</h3>' + others.map((p) => {
        const wa = (p.whatsapp || '').replace(/\D/g, '');
        const msg = encodeURIComponent('Hola, soy tu compañero de ' + g.sport.name + ' por Peloteo: ' + fecha(g.date) + ' a las ' + g.time + '.');
        return '<p>' + esc(p.initials) + ': <a href="mailto:' + esc(p.email) + '">' + esc(p.email) + '</a>' +
          (wa ? ' o <a href="https://wa.me/' + wa + '?text=' + msg + '" target="_blank" rel="noopener">escribirle por WhatsApp</a>' : '') + '</p>';
      }).join('');
    }
    if (withCancel && g.status !== 'cancelado') {
      if (g.can_cancel) {
        h += '<div class="actions"><button type="button" class="btn danger sm" data-a="cancelMine" data-id="' + esc(g.id) + '">' + (S.confirm === g.id ? 'Toca de nuevo para cancelar' : 'Cancelar mi cupo') + '</button></div>';
      } else {
        h += '<p class="small muted">Ya no se puede cancelar: el plazo termina 1 hora antes del inicio.</p>';
      }
    }
    return h + '</div>';
  }

  function vDone() {
    const g = S.done;
    if (!g) return '<p>Ese partido ya no existe.</p><div class="actions"><button type="button" class="btn" data-a="go" data-v="home">Volver al inicio</button></div>';
    const title = g.status === 'confirmado' ? '¡Partido confirmado!' : g.status === 'sin_cancha' ? 'Partido completo, sin cancha' : 'Partido publicado';
    const text = g.status === 'confirmado' ? 'Ya tienen cancha asignada. Estos son los datos.'
      : g.status === 'sin_cancha' ? 'Se completó, pero ya no quedan canchas libres a esa hora. Les avisaremos para elegir otro turno.'
      : 'Cuando se complete, les asignamos la primera cancha libre de ese turno y te avisamos.';
    return '<h1 class="h">' + title + '</h1><p>' + text + '</p>' + gameCard(g, false) +
      '<div class="actions"><button type="button" class="btn" data-a="go" data-v="mine">Ver mis partidos</button><button type="button" class="btn ghost" data-a="go" data-v="home">Agendar otro</button></div>';
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
    if (!q) return '<h1 class="h">Buscar jugadores</h1><p class="muted">Cargando…</p>';
    if (!S.sports.length) return '<h1 class="h">Buscar jugadores</h1><p class="muted">Todavía no hay deportes disponibles.</p>';
    const offer = S.searchOffers.find((o) => o.sport.id === q.sportId);
    let h = '<h1 class="h">Buscar jugadores</h1><p class="muted">Encuentra partidos abiertos que aceptan tu nivel.</p><form data-f="search" novalidate>' +
      '<div class="two"><div><label class="f" for="s-sp">Deporte</label><select id="s-sp" name="sportKey" data-s="sportKey">' + S.sports.map((n) => '<option value="' + esc(n.key) + '"' + (n.key === q.sportKey ? ' selected' : '') + '>' + esc(n.name) + '</option>').join('') + '</select></div>' +
      '<div><label class="f" for="s-ve">Lugar</label><select id="s-ve" name="sportId" data-s="sportId">' + S.searchOffers.map((o) => '<option value="' + esc(o.sport.id) + '"' + (o.sport.id === q.sportId ? ' selected' : '') + '>' + esc(o.venue.name) + '</option>').join('') + '</select></div></div>' +
      '<div class="two"><div><label class="f" for="s-f">Desde el día</label><input id="s-f" name="from" type="date" value="' + q.from + '" min="' + S.today.date + '" max="' + S.today.last_bookable + '"></div>' +
      '<div><label class="f" for="s-t">Hasta el día</label><input id="s-t" name="to" type="date" value="' + q.to + '" min="' + S.today.date + '" max="' + S.today.last_bookable + '"></div></div>' +
      '<div class="two"><div><label class="f" for="s-h1">Desde las</label><input id="s-h1" name="t1" type="time" value="' + q.t1 + '"></div>' +
      '<div><label class="f" for="s-h2">Hasta las</label><input id="s-h2" name="t2" type="time" value="' + q.t2 + '"></div></div>' +
      (offer ? levelRadios(offer.sport, null, q.level) : '') +
      errBox() + '<div class="actions"><button class="btn block" type="submit">Buscar partidos</button></div></form>';
    if (S.results) {
      const r = S.results;
      h += '<h2 id="resultados">' + (r.length ? (r.length === 1 ? '1 partido encontrado' : r.length + ' partidos encontrados') : 'Nadie busca partido en ese rango') + '</h2>';
      if (!r.length) h += '<p class="muted">Abre tú un partido y quien busque después te encontrará.</p><div class="actions"><button type="button" class="btn ghost" data-a="openFromSearch">Abrir un partido</button></div>';
      else h += '<ul class="list">' + r.map((g) =>
        '<li><button type="button" class="row" data-a="pickResult" data-id="' + esc(g.id) + '"><span><span class="name">' + cap(fecha(g.date)) + ', ' + g.time + '</span><span class="meta">' +
        who(g.players) + '. ' + cap(faltan(g.missing)) + '. Busca ' + levelsText(g.accepted_levels) + '</span></span><span class="go">Unirme</span></button></li>').join('') + '</ul>';
    }
    return h;
  }

  function vMine() {
    let h = '<h1 class="h">Mis partidos</h1>';
    if (!S.mineLoaded) return h + '<p class="muted">Cargando…</p>';
    if (!S.mine.length) return h + '<div class="card"><p>Aún no tienes partidos agendados.</p><div class="actions"><button type="button" class="btn" data-a="go" data-v="home">Agendar un partido</button></div></div>';
    return h + S.mine.map((g) => gameCard(g, true)).join('') +
      '<p class="small muted">Tus partidos quedan guardados en este navegador. Cada correo de aviso trae un enlace para cancelar desde otro dispositivo.</p>';
  }

  // ---------------- enlace de cancelación (correo) ----------------
  function vToken() {
    let h = '<h1 class="h">Cancelar mi cupo</h1>';
    if (S.tokenDone) {
      return h + '<div class="card"><p>Listo, liberaste tu cupo. Avisamos al resto de los jugadores.</p><div class="actions"><button type="button" class="btn" data-a="go" data-v="home">Agendar otro partido</button></div></div>';
    }
    const g = S.tokenGame;
    if (!g) {
      return h + '<div class="card"><p>' + esc(S.err || 'Cargando…') + '</p>' + (S.err ? '<div class="actions"><button type="button" class="btn" data-a="go" data-v="home">Ir al inicio</button></div>' : '') + '</div>';
    }
    h += gameCard(g, false);
    if (g.status === 'cancelado') return h + '<p class="muted">Este partido ya fue cancelado; no tienes que hacer nada.</p>';
    if (!g.can_cancel) return h + '<p class="muted">Ya no se puede cancelar: el plazo termina 1 hora antes del inicio.</p>';
    return h + (S.err ? '<p class="err" role="alert">' + esc(S.err) + '</p>' : '') +
      '<p>Si no puedes jugar, libera tu cupo para que otro jugador pueda tomarlo. Avisaremos al resto.</p>' +
      '<div class="actions"><button type="button" class="btn danger" data-a="cancelToken">' + (S.confirm === 'token' ? 'Toca de nuevo para cancelar' : 'Cancelar mi cupo') + '</button>' +
      '<button type="button" class="btn ghost" data-a="go" data-v="home">No, mantenerlo</button></div>';
  }

  async function openToken(token) {
    S.view = 'token'; S.token = token; S.tokenGame = null; S.tokenDone = false; S.err = ''; S.confirm = null;
    render();
    const r = await api('POST', '/api/token/game', { token });
    if (r.ok) S.tokenGame = r.data.game; else S.err = r.data.error || 'No pudimos abrir ese enlace.';
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
      case 'loading': return '<p class="muted" style="padding:2rem 0">Cargando canchas…</p>';
      case 'venue': return vVenue();
      case 'calendar': return vCalendar();
      case 'form': return vForm();
      case 'done': return vDone();
      case 'search': return vSearch();
      case 'mine': return vMine();
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
    $('#bar').innerHTML = '<button type="button" class="brand" data-a="go" data-v="home">Peloteo</button><nav aria-label="Principal">' +
      '<button type="button" data-a="go" data-v="search" aria-current="' + (S.view === 'search') + '">Buscar</button>' +
      '<button type="button" data-a="go" data-v="mine" aria-current="' + (S.view === 'mine') + '">Mis partidos' + (n ? '<b aria-label="' + n + ' activos">' + n + '</b>' : '') + '</button></nav>';
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
    S.err = ini.length < 2 || ini.length > 4 ? 'Escribe tus iniciales (2 a 4 letras).'
      : !level ? 'Elige tu nivel de juego.'
      : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test((d.email || '').trim()) ? 'Revisa el email: lo usamos para avisarte.'
      : (d.whatsapp && d.whatsapp.replace(/\D/g, '').length < 8) ? 'Revisa el número de WhatsApp o déjalo en blanco.'
      : (!S.game && !(d.accepted_levels || []).length) ? 'Elige qué niveles aceptas.'
      : (!S.game && !(d.accepted_levels || []).includes(level)) ? 'Incluye tu propio nivel entre los aceptados.' : '';
    if (S.err) { render(); return; }

    const key = 'lvl_' + sport.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
    prefs = Object.assign({}, prefs, { initials: ini, email: d.email.trim(), whatsapp: d.whatsapp || '', whatsapp_opt_in: !!d.whatsapp_opt_in });
    prefs[key] = level;
    LS.set('peloteo_prefs', prefs);

    const player = { initials: ini, level, email: d.email.trim(), whatsapp: d.whatsapp || '', whatsapp_opt_in: !!d.whatsapp_opt_in };
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
        toast(r.data.error || 'Ese turno ya no está disponible. Elige otro.');
        const back = S.fromSearch ? 'search' : 'calendar';
        S.game = null;
        if (back === 'calendar' && S.date) { S.view = 'calendar'; await Promise.all([loadMonth(), loadDay()]); render(); }
        else go(back);
        return;
      }
      if (code === 'ya_inscrito') { toast(r.data.error); go('mine'); return; }
      S.err = r.data.error || 'No se pudo guardar. Inténtalo de nuevo.'; S.field = r.data.field || ''; render(); return;
    }
    S.done = r.data.game; S.game = null;
    await loadMine();
    go('done');
  }

  const submit = {
    play: submitPlay,
    async search(d) {
      const q = S.search;
      Object.assign(q, { from: d.from, to: d.to, t1: d.t1, t2: d.t2, level: Number(d.level) || null });
      if (!q.level) { S.err = 'Elige tu nivel de juego.'; render(); return; }
      if (q.to < q.from || q.t2 < q.t1) { S.err = 'Revisa el rango: el final está antes del inicio.'; render(); return; }
      S.err = '';
      const qs = new URLSearchParams({ sport_id: q.sportId, level: String(q.level), date_from: q.from, date_to: q.to, time_from: q.t1, time_to: q.t2 });
      const r = await api('GET', '/api/search?' + qs);
      if (!r.ok) { S.err = r.data.error || 'No se pudo buscar.'; render(); return; }
      S.results = r.data; render();
      const el = document.getElementById('resultados'); if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  };

  // ---------------- acciones ----------------
  const act = {
    go(d) { S.fromSearch = false; go(d.v); },
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
    pickTime(d) { S.time = d.t; S.game = null; S.fromSearch = false; go('form'); },
    pickGame(d) {
      for (const s of S.slots) { const g = s.open_games.find((x) => x.id === d.id); if (g) { S.game = g; S.time = g.time; break; } }
      S.fromSearch = false; go('form');
    },
    pickResult(d) {
      const g = (S.results || []).find((x) => x.id === d.id); if (!g) return;
      const offer = S.searchOffers.find((o) => o.sport.id === S.search.sportId);
      S.offer = offer; S.sportKey = S.search.sportKey; S.game = g; S.date = g.date; S.time = g.time; S.fromSearch = true;
      go('form');
    },
    back() { if (S.fromSearch) go('search'); else act.toCalendar(); },
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
        S.err = r.data.error || 'No se pudo cancelar.';
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
      if (!r.ok) { toast(r.data.error || 'No se pudo cancelar.'); await loadMine(); render(); return; }
      toast('Cancelaste tu cupo.'); await loadMine(); render();
    },
  };

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
    const [today, sports] = await Promise.all([get('/api/today'), get('/api/sports')]);
    if (!today) { $('#app').innerHTML = '<div class="card"><h2>No pudimos cargar las canchas</h2><p class="muted">Revisa tu conexión y vuelve a intentarlo.</p><div class="actions"><button class="btn" onclick="location.reload()">Reintentar</button></div></div>'; return; }
    S.today = today; S.sports = sports || [];
    if (!fromHash()) { S.view = 'home'; render(); }
    await loadMine(); render();
  })();
  window.addEventListener('hashchange', () => { if (S.today) fromHash(); });
})();
