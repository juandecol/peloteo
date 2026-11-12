// Configuración de Peloteo: login del administrador y módulo de configuración.
// Sin framework. Pantallas y textos tomados del prototipo (referencia/peloteo.html).
(function () {
  'use strict';

  const $ = (s) => document.querySelector(s);
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const MESES = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
  const DIAS = ['domingo', 'lunes', 'martes', 'miércoles', 'jueves', 'viernes', 'sábado'];
  const STAT = { operativa: 'Operativa', mantencion: 'En mantención', cerrada: 'Cerrada' };
  const GSTAT = { abierto: 'Abierto', sin_cancha: 'Sin cancha', confirmado: 'Confirmado', cancelado: 'Cancelado' };
  const SURF_DEFAULT = ['Arcilla', 'Carpeta sintética', 'Césped sintético', 'Cemento', 'Césped natural', 'Otra'];
  const parse = (s) => { const a = s.split('-').map(Number); return new Date(a[0], a[1] - 1, a[2], 12); };
  const fecha = (s) => { const d = parse(s); return DIAS[d.getDay()] + ' ' + d.getDate() + ' de ' + MESES[d.getMonth()]; };
  const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);
  const plural = (n, uno, varios) => (n === 1 ? '1 ' + uno : n + ' ' + varios);

  let toastT;
  function toast(m) {
    const t = $('#toast'); t.textContent = m; t.classList.add('on');
    clearTimeout(toastT); toastT = setTimeout(() => t.classList.remove('on'), 3200);
  }

  // ---------------- estado ----------------
  const S = {
    session: null, // respuesta de /admin/session
    view: 'loading',
    venueId: null, sportId: null, courtId: null,
    venues: [], venue: null, sports: [], sport: null, courts: [], court: null, games: [],
    surfaces: SURF_DEFAULT,
    err: '', confirm: null, affected: null, busy: false,
  };

  // ---------------- API ----------------
  async function api(method, path, body) {
    const opts = { method, headers: {} };
    if (body !== undefined) { opts.headers['Content-Type'] = 'application/json'; opts.body = JSON.stringify(body); }
    let res, data = null;
    try {
      res = await fetch(path, opts);
      try { data = await res.json(); } catch (e) { data = null; }
    } catch (e) {
      return { ok: false, status: 0, data: { error: 'No hay conexión. Revisa tu internet e inténtalo de nuevo.' } };
    }
    if (res.status === 401 && path.indexOf('/admin/api/') === 0) {
      await refreshSession();
      toast((data && data.error) || 'Tu sesión expiró. Vuelve a entrar.');
    }
    if (res.status === 403 && data && data.code === 'cambiar_contrasena') await refreshSession();
    return { ok: res.ok, status: res.status, data: data || {} };
  }

  async function refreshSession() {
    const r = await api('GET', '/admin/session');
    S.session = r.ok ? r.data : { logged_in: false };
    if (!S.session.logged_in) S.view = 'login';
    else if (S.session.needs_second_factor) S.view = 'twofa';
    else if (S.session.must_change_password) S.view = 'mustChange';
    else if (['loading', 'login', 'twofa', 'mustChange'].includes(S.view)) S.view = 'venues';
    return S.session;
  }

  // ---------------- carga de datos por pantalla ----------------
  async function load() {
    const v = S.view;
    if (v === 'venues') {
      const r = await api('GET', '/admin/api/venues'); if (r.ok) S.venues = r.data;
    } else if (v === 'venue' || v === 'venueForm') {
      if (S.venueId) {
        const [a, b] = await Promise.all([api('GET', '/admin/api/venues/' + S.venueId), api('GET', '/admin/api/sports?venue_id=' + encodeURIComponent(S.venueId))]);
        S.venue = a.ok ? a.data : null; S.sports = b.ok ? b.data : [];
      } else S.venue = null;
    } else if (v === 'sport' || v === 'sportForm') {
      if (S.venueId && !S.venue) { const a = await api('GET', '/admin/api/venues/' + S.venueId); S.venue = a.ok ? a.data : null; }
      if (S.sportId) {
        const [a, b] = await Promise.all([api('GET', '/admin/api/sports/' + S.sportId), api('GET', '/admin/api/courts?sport_id=' + encodeURIComponent(S.sportId))]);
        S.sport = a.ok ? a.data : null; S.courts = b.ok ? b.data : [];
      } else S.sport = null;
    } else if (v === 'courtForm') {
      if (!S.sport && S.sportId) { const a = await api('GET', '/admin/api/sports/' + S.sportId); S.sport = a.ok ? a.data : null; }
      if (S.courtId) { const a = await api('GET', '/admin/api/courts/' + S.courtId); S.court = a.ok ? a.data : null; } else S.court = null;
      const m = await api('GET', '/admin/api/meta'); if (m.ok && m.data.surfaces) S.surfaces = m.data.surfaces;
    } else if (v === 'games') {
      const r = await api('GET', '/admin/api/games'); if (r.ok) S.games = r.data;
    }
  }

  async function go(view, ids) {
    Object.assign(S, ids || {});
    if (view === 'venues') { S.venueId = S.sportId = S.courtId = null; }
    if (view === 'venue') { S.sportId = S.courtId = null; }
    if (view === 'sport') { S.courtId = null; }
    S.view = view; S.err = ''; S.confirm = null; S.affected = null;
    render(); await load(); render(); window.scrollTo(0, 0);
  }

  // ---------------- vistas ----------------
  const errBox = () => (S.err ? '<p class="err" role="alert">' + esc(S.err) + '</p>' : '');
  const crumbs = (items) => '<p class="crumbs">' + items.map((it) => (it.go ? '<button type="button" data-a="go" data-v="' + it.go + '">' + esc(it.t) + '</button>' : '<span>' + esc(it.t) + '</span>')).join('<span>›</span>') + '</p>';
  const back = (v) => '<p class="crumbs"><button type="button" data-a="go" data-v="' + v + '">‹ Volver</button></p>';
  const delBtn = (key, label) => '<button type="button" class="btn danger sm" data-a="del" data-k="' + key + '">' + (S.confirm === key ? 'Toca de nuevo para eliminar' : label) + '</button>';

  function affectedBox(action) {
    if (!S.affected) return '';
    const gs = S.affected.games || [];
    return '<div class="card warn" role="alert"><h3>' + esc(S.affected.error) + '</h3><ul>' +
      gs.map((g) => '<li>' + cap(fecha(g.date)) + ', ' + g.time + ' · ' + esc(GSTAT[g.status] || g.status) + ' · ' + plural(g.players, 'jugador', 'jugadores') + ' <span class="id">' + esc(g.id) + '</span></li>').join('') +
      '</ul>' + (action ? '<div class="actions"><button type="button" class="btn danger" data-a="' + action + '">Cancelar ' + plural(gs.length, 'encuentro', 'encuentros') + ' y eliminar</button><button type="button" class="btn ghost" data-a="dismiss">Volver</button></div>' : '') + '</div>';
  }

  function vLogin() {
    return '<h1 class="h">Configuración</h1><p class="muted">Acceso del administrador.</p>' +
      '<form data-f="login" novalidate>' +
      '<label class="f" for="u">Usuario</label><input id="u" name="username" type="text" autocomplete="username" autocapitalize="none" spellcheck="false" required>' +
      '<label class="f" for="p">Contraseña</label><input id="p" name="password" type="password" autocomplete="current-password" required>' +
      errBox() + '<div class="actions"><button class="btn block" type="submit"' + (S.busy ? ' disabled' : '') + '>' + (S.busy ? 'Entrando…' : 'Entrar') + '</button></div></form>';
  }

  function vTwoFa() {
    return '<h1 class="h">Segundo paso</h1><p class="muted">Escribe el código de 6 dígitos de tu app autenticadora.</p>' +
      '<form data-f="twofa" novalidate><label class="f" for="code">Código</label><input id="code" name="code" type="text" inputmode="numeric" autocomplete="one-time-code" maxlength="6">' +
      errBox() + '<div class="actions"><button class="btn block" type="submit">Verificar</button><button class="btn ghost" type="button" data-a="logout">Salir</button></div></form>';
  }

  function passwordFields(withConfirm) {
    return '<label class="f" for="cp">Contraseña actual</label><input id="cp" name="current_password" type="password" autocomplete="current-password" required>' +
      '<label class="f" for="np">Nueva contraseña <small>(mínimo 10 caracteres)</small></label><input id="np" name="new_password" type="password" autocomplete="new-password" minlength="10" required>' +
      (withConfirm ? '<label class="f" for="np2">Repite la nueva contraseña</label><input id="np2" name="new_password2" type="password" autocomplete="new-password" required>' : '');
  }

  function vMustChange() {
    return '<h1 class="h">Cambia la contraseña</h1><p class="muted">Es tu primer ingreso: antes de configurar, reemplaza la contraseña inicial por una propia.</p>' +
      '<form data-f="password" novalidate>' + passwordFields(true) + errBox() +
      '<div class="actions"><button class="btn block" type="submit">Guardar contraseña</button></div></form>' +
      '<div class="actions"><button class="btn ghost sm" type="button" data-a="logout">Salir</button></div>';
  }

  function tabs() {
    const cur = (v) => (v === 'venues' ? ['venues', 'venue', 'venueForm', 'sport', 'sportForm', 'courtForm'].includes(S.view) : S.view === v);
    const tab = (v, t) => '<button type="button" data-a="go" data-v="' + v + '" aria-current="' + cur(v) + '">' + t + '</button>';
    return '<h1 class="h">Configuración</h1><nav class="tabs" aria-label="Secciones">' + tab('venues', 'Lugares') + tab('games', 'Encuentros') + tab('security', 'Seguridad') + '<button type="button" data-a="logout">Salir</button></nav>';
  }

  function vVenues() {
    let h = S.venues.length ? '<ul class="list">' + S.venues.map((v) =>
      '<li><button type="button" class="row" data-a="go" data-v="venue" data-venue="' + esc(v.id) + '"><span><span class="name">' + esc(v.name) + '</span><span class="meta">ID ' + esc(v.id) + '. ' + plural(v.sports, 'deporte', 'deportes') + ', ' + plural(v.courts, 'cancha', 'canchas') + '</span></span><span class="go">Abrir</span></button></li>').join('') + '</ul>'
      : '<div class="card"><p>No hay lugares todavía. Crea el primero.</p></div>';
    return h + '<div class="actions"><button type="button" class="btn" data-a="go" data-v="venueForm" data-venue="">Agregar lugar</button></div>';
  }

  function vVenueForm() {
    const ve = S.venueId ? S.venue : null;
    return back(ve ? 'venue' : 'venues') + '<h2>' + (ve ? 'Editar lugar' : 'Nuevo lugar') + '</h2><form data-f="venue" novalidate>' +
      '<label class="f" for="vn">Nombre del lugar</label><input id="vn" name="name" type="text" maxlength="80" placeholder="Country Club Santa Martina" value="' + esc(ve ? ve.name : '') + '" required>' +
      '<label class="f" for="va">Dirección o comuna</label><input id="va" name="address" type="text" maxlength="160" value="' + esc(ve ? ve.address : '') + '">' +
      '<label class="f" for="vm">Enlace de Google Maps <small>(opcional)</small></label><input id="vm" name="maps_url" type="url" inputmode="url" placeholder="https://maps.app.goo.gl/..." value="' + esc(ve ? ve.maps_url : '') + '">' +
      errBox() + affectedBox('delConfirm') + '<div class="actions"><button class="btn" type="submit">Guardar lugar</button>' + (ve ? delBtn('venue', 'Eliminar lugar') : '') + '</div></form>';
  }

  function vVenue() {
    const ve = S.venue;
    if (!ve) return '<p>Ese lugar ya no existe.</p>';
    let h = crumbs([{ t: 'Lugares', go: 'venues' }, { t: ve.name }]) +
      '<div class="card"><h2>' + esc(ve.name) + '</h2><p class="id">ID ' + esc(ve.id) + '</p><p>' + esc(ve.address || 'Sin dirección') + '</p>' +
      (ve.maps_url ? '<p><a href="' + esc(ve.maps_url) + '" target="_blank" rel="noopener">Ver en Google Maps</a></p>' : '') +
      '<div class="actions"><button type="button" class="btn ghost sm" data-a="go" data-v="venueForm">Editar lugar</button></div></div><h3>Deportes en este lugar</h3>';
    h += S.sports.length ? '<ul class="list">' + S.sports.map((s) => {
      const nc = s.categories.filter(Boolean).length;
      return '<li><button type="button" class="row" data-a="go" data-v="sport" data-sport="' + esc(s.id) + '"><span><span class="name">' + esc(s.name) + '</span><span class="meta">ID ' + esc(s.id) + '. ' + plural(nc, 'categoría', 'categorías') + ', ' + plural(s.courts, 'cancha', 'canchas') + '</span></span><span class="go">Abrir</span></button></li>';
    }).join('') + '</ul>' : '<p class="muted">Aún no hay deportes en este lugar.</p>';
    return h + '<div class="actions"><button type="button" class="btn" data-a="go" data-v="sportForm" data-sport="">Agregar deporte</button></div>';
  }

  const sizesText = (sizes) => sizes.map((n) => n + (n === 2 ? ' (singles)' : ' (dobles)')).join(' o ') + ' jugadores';

  function vSportForm() {
    const sp = S.sportId ? S.sport : null;
    const sizes = sp ? sp.match_sizes : [2];
    const cats = sp ? sp.categories : ['', '', '', '', ''];
    return back(sp ? 'sport' : 'venue') + '<h2>' + (sp ? 'Editar deporte' : 'Nuevo deporte en ' + esc(S.venue ? S.venue.name : '')) + '</h2><form data-f="sport" novalidate>' +
      '<label class="f" for="sn">Nombre del deporte</label><input id="sn" name="name" type="text" maxlength="40" placeholder="Tenis" value="' + esc(sp ? sp.name : '') + '" required>' +
      '<fieldset style="border:0;padding:0;margin:0"><legend class="f" style="font-weight:700;font-size:.9rem;margin-top:.9rem">Jugadores por partido <small class="muted" style="font-weight:400">(quien abre el partido elige entre las marcadas)</small></legend><div class="checks">' +
      [2, 4].map((n) => '<label><input type="checkbox" name="match_sizes" value="' + n + '"' + (sizes.includes(n) ? ' checked' : '') + '>' + n + (n === 2 ? ' (singles)' : ' (dobles)') + '</label>').join('') + '</div></fieldset>' +
      '<h3>Categorías <span class="muted small">(1 avanzado, 5 principiante; deja en blanco las que no uses)</span></h3>' +
      [1, 2, 3, 4, 5].map((n) => '<label class="f" for="c' + n + '">Categoría ' + n + '</label><input id="c' + n + '" name="c' + n + '" type="text" maxlength="60" placeholder="' + (n === 1 ? 'Estoy entrenando para Wimbledon' : n === 5 ? 'Apenas logro pasar la pelota' : 'Texto para el nivel ' + n) + '" value="' + esc(cats[n - 1] || '') + '">').join('') +
      errBox() + affectedBox('delConfirm') + '<div class="actions"><button class="btn" type="submit">Guardar deporte</button>' + (sp ? delBtn('sport', 'Eliminar deporte') : '') + '</div></form>';
  }

  function vSport() {
    const sp = S.sport, ve = S.venue;
    if (!sp) return '<p>Ese deporte ya no existe.</p>';
    let h = crumbs([{ t: 'Lugares', go: 'venues' }, { t: ve ? ve.name : 'Lugar', go: 'venue' }, { t: sp.name }]) +
      '<div class="card"><h2>' + esc(sp.name) + '</h2><p class="id">ID ' + esc(sp.id) + '</p><p>' + sizesText(sp.match_sizes) + ' por partido</p>' +
      '<dl class="kv">' + sp.categories.map((c, i) => (c ? '<dt>Nivel ' + (i + 1) + '</dt><dd>' + esc(c) + '</dd>' : '')).join('') + '</dl>' +
      '<div class="actions"><button type="button" class="btn ghost sm" data-a="go" data-v="sportForm">Editar deporte y categorías</button></div></div><h3>Canchas</h3>';
    h += S.courts.length ? '<ul class="list">' + S.courts.map((c) =>
      '<li><button type="button" class="row" data-a="go" data-v="courtForm" data-court="' + esc(c.id) + '"><span><span class="name">' + esc(c.name) + ' <span class="tag ' + (c.status === 'operativa' ? 'ok' : 'off') + '">' + STAT[c.status] + '</span></span><span class="meta">ID ' + esc(c.id) + '. ' + esc(c.surface || 'Sin materialidad') + '. ' + c.open_time + ' a ' + c.close_time + ', turnos de ' + c.slot_minutes + ' min</span></span><span class="go">Editar</span></button></li>').join('') + '</ul>'
      : '<p class="muted">Aún no hay canchas para este deporte.</p>';
    return h + '<div class="actions"><button type="button" class="btn" data-a="go" data-v="courtForm" data-court="">Agregar cancha</button></div>';
  }

  function vCourtForm() {
    const co = S.courtId ? S.court : null;
    if (S.courtId && !co) return back('sport') + '<p>Esa cancha ya no existe.</p>';
    const c = co || { name: '', surface: 'Arcilla', status: 'operativa', maps_url: '', notes: '', days: '0,1,2,3,4,5,6', open_time: '08:00', close_time: '21:00', slot_minutes: 60, available_from: '', available_to: '' };
    const days = String(c.days).split(',').map(Number);
    const surf = S.surfaces.includes(c.surface) || !c.surface ? S.surfaces : S.surfaces.concat([c.surface]);
    return back('sport') + '<h2>' + (co ? 'Editar cancha' : 'Nueva cancha de ' + esc(S.sport ? S.sport.name : '')) + '</h2>' + (co ? '<p class="id">ID ' + esc(co.id) + '</p>' : '') + '<form data-f="court" novalidate>' +
      '<label class="f" for="cn">Nombre</label><input id="cn" name="name" type="text" maxlength="60" placeholder="Cancha 1" value="' + esc(c.name) + '" required>' +
      '<div class="two"><div><label class="f" for="cs">Materialidad</label><select id="cs" name="surface">' + surf.map((s) => '<option' + (s === c.surface ? ' selected' : '') + '>' + esc(s) + '</option>').join('') + '</select></div>' +
      '<div><label class="f" for="ce">Estado</label><select id="ce" name="status">' + Object.keys(STAT).map((k) => '<option value="' + k + '"' + (k === c.status ? ' selected' : '') + '>' + STAT[k] + '</option>').join('') + '</select></div></div>' +
      '<label class="f" for="co">Otras características <small>(techada, iluminación…)</small></label><input id="co" name="notes" type="text" maxlength="300" value="' + esc(c.notes) + '">' +
      '<label class="f" for="cm">Ubicación en Google Maps <small>(pega el enlace)</small></label><input id="cm" name="maps_url" type="url" inputmode="url" placeholder="https://maps.app.goo.gl/..." value="' + esc(c.maps_url) + '">' +
      '<fieldset style="border:0;padding:0;margin:0"><legend class="f" style="font-weight:700;font-size:.9rem;margin-top:.9rem">Días de operación</legend><div class="days">' + [1, 2, 3, 4, 5, 6, 0].map((d) => '<label><input type="checkbox" name="days" value="' + d + '"' + (days.includes(d) ? ' checked' : '') + '><span aria-hidden="true">' + DIAS[d].slice(0, 2) + '</span><span class="sr-only">' + DIAS[d] + '</span></label>').join('') + '</div></fieldset>' +
      '<div class="two"><div><label class="f" for="ca">Abre</label><input id="ca" name="open_time" type="time" value="' + esc(c.open_time) + '"></div><div><label class="f" for="cc">Cierra</label><input id="cc" name="close_time" type="time" value="' + esc(c.close_time) + '"></div></div>' +
      '<label class="f" for="ct">Duración de cada turno</label><select id="ct" name="slot_minutes">' + [60, 90, 120].map((n) => '<option value="' + n + '"' + (Number(c.slot_minutes) === n ? ' selected' : '') + '>' + n + ' minutos</option>').join('') + '</select>' +
      '<div class="two"><div><label class="f" for="cf">Disponible desde <small>(opcional)</small></label><input id="cf" name="available_from" type="date" value="' + esc(c.available_from || '') + '"></div><div><label class="f" for="ch">Hasta <small>(opcional)</small></label><input id="ch" name="available_to" type="date" value="' + esc(c.available_to || '') + '"></div></div>' +
      errBox() + affectedBox(S.affected && S.affected.code === 'requiere_confirmacion' ? 'delConfirm' : null) +
      '<div class="actions"><button class="btn" type="submit">Guardar cancha</button>' + (co ? delBtn('court', 'Eliminar cancha') : '') + '</div></form>';
  }

  function vGames() {
    const gs = S.games;
    if (!gs.length) return '<p class="muted">No hay encuentros agendados de hoy en adelante.</p>';
    return gs.map((g) => {
      const faltan = g.capacity - g.players.length;
      const tag = g.status === 'abierto' ? '<span class="tag">' + (faltan === 1 ? 'Falta 1 jugador' : 'Faltan ' + faltan + ' jugadores') + '</span>'
        : g.status === 'confirmado' ? '<span class="tag ok">Confirmado</span>'
        : '<span class="tag off">' + GSTAT[g.status] + '</span>';
      const key = 'game:' + g.id;
      return '<div class="card"><p>' + tag + ' <span class="id">ID ' + esc(g.id) + '</span></p><h3>' + cap(fecha(g.date)) + ', ' + g.time + '</h3>' +
        '<p>' + esc(g.sport_name) + ' en ' + esc(g.venue_name) + (g.court_name ? ', ' + esc(g.court_name) : ', sin cancha asignada') + '</p>' +
        '<p class="small muted">' + g.capacity + ' jugadores · acepta ' + (g.accepted_levels.length === 1 ? 'nivel ' : 'niveles ') + g.accepted_levels.join(', ') + '</p>' +
        g.players.map((p) => '<p class="small">' + esc(p.initials) + ', nivel ' + p.level + ', <a href="mailto:' + esc(p.email) + '">' + esc(p.email) + '</a>' + (p.whatsapp ? ', ' + esc(p.whatsapp) : '') + '</p>').join('') +
        (g.status !== 'cancelado' ? '<div class="actions"><button type="button" class="btn danger sm" data-a="cancelGame" data-id="' + esc(g.id) + '">' + (S.confirm === key ? 'Toca de nuevo para cancelar' : 'Cancelar encuentro') + '</button></div>' : '') + '</div>';
    }).join('');
  }

  function vSecurity() {
    const s = S.session || {};
    return '<div class="card"><h2>Acceso del administrador</h2><dl class="kv"><dt>Usuario</dt><dd>' + esc(s.username) + '</dd>' +
      '<dt>Primer factor</dt><dd>Usuario y contraseña <span class="tag ok">Activo</span></dd><dt>Segundo factor</dt><dd>Código de 6 dígitos (app autenticadora) <span class="tag">' + (s.totp_enabled ? 'Activo' : 'Preparado, sin activar') + '</span></dd></dl>' +
      '<p class="small muted">El inicio de sesión ya está pensado en dos pasos: hoy el segundo se omite. Después de 5 intentos fallidos, el acceso se bloquea 15 minutos.</p></div>' +
      '<div class="card"><h2>Cambiar contraseña</h2><form data-f="password" novalidate>' + passwordFields(true) + errBox() +
      '<div class="actions"><button class="btn" type="submit">Guardar contraseña</button></div></form></div>' +
      '<div class="card"><h2>Jugadores</h2><p class="small muted">Sin registro. Cada navegador recibe un identificador anónimo (cookie) para reconocer sus partidos.</p></div>';
  }

  function view() {
    switch (S.view) {
      case 'loading': return '<p class="muted" style="padding:2rem 0">Cargando…</p>';
      case 'login': return vLogin();
      case 'twofa': return vTwoFa();
      case 'mustChange': return vMustChange();
    }
    const body = { venues: vVenues, venueForm: vVenueForm, venue: vVenue, sportForm: vSportForm, sport: vSport, courtForm: vCourtForm, games: vGames, security: vSecurity }[S.view];
    return tabs() + (body ? body() : '');
  }

  function render() {
    // Conserva lo escrito en los formularios si la pantalla no cambió.
    const app = $('#app');
    const key = S.view + '|' + S.venueId + '|' + S.sportId + '|' + S.courtId;
    let saved = null, focus = null;
    if (render.key === key) {
      saved = {};
      app.querySelectorAll('[name]').forEach((el) => { saved[el.name + '|' + (el.type === 'checkbox' ? el.value : '')] = el.type === 'checkbox' ? el.checked : el.value; });
      if (document.activeElement && document.activeElement.id && app.contains(document.activeElement)) focus = document.activeElement.id;
    }
    render.key = key;
    app.innerHTML = view();
    if (saved) {
      app.querySelectorAll('[name]').forEach((el) => {
        const k = el.name + '|' + (el.type === 'checkbox' ? el.value : '');
        if (k in saved && el.type !== 'password') { if (el.type === 'checkbox') el.checked = saved[k]; else el.value = saved[k]; }
      });
      if (focus) { const el = document.getElementById(focus); if (el) el.focus({ preventScroll: true }); }
    }
    const firstErr = app.querySelector('.err');
    if (firstErr) firstErr.scrollIntoView({ block: 'nearest' });
  }

  // ---------------- formularios ----------------
  const formData = (form) => {
    const out = {};
    for (const el of form.elements) {
      if (!el.name) continue;
      if (el.type === 'checkbox') { (out[el.name] = out[el.name] || []); if (el.checked) out[el.name].push(Number(el.value)); }
      else out[el.name] = el.value;
    }
    return out;
  };

  function fail(r) {
    if (r.data && r.data.games) { S.affected = r.data; S.err = ''; }
    else { S.affected = null; S.err = (r.data && r.data.error) || 'No se pudo guardar. Inténtalo de nuevo.'; }
    render();
    if (r.data && r.data.field) { const el = document.querySelector('[name="' + r.data.field.split('.')[0] + '"]'); if (el) el.focus(); }
  }

  const submit = {
    async login(d) {
      if (!d.username || !d.password) { S.err = 'Escribe tu usuario y contraseña.'; render(); return; }
      S.busy = true; S.err = ''; render();
      const r = await api('POST', '/admin/login', { username: d.username, password: d.password });
      S.busy = false;
      if (!r.ok) { S.err = r.data.error || 'No se pudo entrar.'; render(); return; }
      await refreshSession(); await load(); render();
    },
    async twofa(d) {
      const r = await api('POST', '/admin/login/2fa', { code: d.code });
      if (!r.ok) { S.err = r.data.error; render(); return; }
      await refreshSession(); await load(); render();
    },
    async password(d) {
      if (d.new_password !== d.new_password2) { S.err = 'Las contraseñas nuevas no coinciden.'; render(); return; }
      const r = await api('POST', '/admin/password', { current_password: d.current_password, new_password: d.new_password });
      if (!r.ok) { fail(r); return; }
      toast('Contraseña guardada.');
      const wasForced = S.view === 'mustChange';
      await refreshSession();
      if (wasForced) await go('venues'); else { S.err = ''; render(); $('#app form').reset(); }
    },
    async venue(d) {
      const r = S.venueId ? await api('PUT', '/admin/api/venues/' + S.venueId, d) : await api('POST', '/admin/api/venues', d);
      if (!r.ok) { fail(r); return; }
      toast('Lugar guardado.'); S.venue = r.data; await go('venue', { venueId: r.data.id });
    },
    async sport(d) {
      const body = { name: d.name, match_sizes: d.match_sizes || [], categories: [1, 2, 3, 4, 5].map((n) => d['c' + n] || ''), venue_id: S.venueId };
      const r = S.sportId ? await api('PUT', '/admin/api/sports/' + S.sportId, body) : await api('POST', '/admin/api/sports', body);
      if (!r.ok) { fail(r); return; }
      toast('Deporte guardado.'); await go('sport', { sportId: r.data.id });
    },
    async court(d) {
      const body = Object.assign({}, d, { days: d.days || [], slot_minutes: Number(d.slot_minutes), sport_id: S.sportId });
      const r = S.courtId ? await api('PUT', '/admin/api/courts/' + S.courtId, body) : await api('POST', '/admin/api/courts', body);
      if (!r.ok) { fail(r); return; }
      toast('Cancha guardada.'); await go('sport');
    },
  };

  // ---------------- acciones ----------------
  const delTarget = (k) => ({ venue: ['/admin/api/venues/' + S.venueId, 'venues'], sport: ['/admin/api/sports/' + S.sportId, 'venue'], court: ['/admin/api/courts/' + S.courtId, 'sport'] }[k]);

  async function doDelete(k, confirm) {
    const [path, after] = delTarget(k);
    const r = await api('DELETE', path + (confirm ? '?confirm=1' : ''));
    if (r.status === 409 && r.data.code === 'requiere_confirmacion') { S.affected = Object.assign({ key: k }, r.data); S.err = ''; render(); return; }
    if (!r.ok) { fail(r); return; }
    toast(r.data.cancelled_games ? 'Eliminado. Se cancelaron ' + plural(r.data.cancelled_games, 'encuentro', 'encuentros') + ' y se avisó a sus jugadores.' : 'Eliminado.');
    await go(after);
  }

  const act = {
    go(d) {
      const ids = {};
      if ('venue' in d) ids.venueId = d.venue || null;
      if ('sport' in d) ids.sportId = d.sport || null;
      if ('court' in d) ids.courtId = d.court || null;
      go(d.v, ids);
    },
    async logout() { await api('POST', '/admin/logout', {}); S.session = { logged_in: false }; S.view = 'login'; S.err = ''; render(); },
    async del(d) {
      if (S.confirm !== d.k) { S.confirm = d.k; render(); return; }
      S.confirm = null; await doDelete(d.k, false);
    },
    async delConfirm() { if (S.affected) await doDelete(S.affected.key, true); },
    dismiss() { S.affected = null; S.err = ''; render(); },
    async cancelGame(d) {
      const key = 'game:' + d.id;
      if (S.confirm !== key) { S.confirm = key; render(); return; }
      S.confirm = null;
      const r = await api('POST', '/admin/api/games/' + encodeURIComponent(d.id) + '/cancel', {});
      if (!r.ok) { toast(r.data.error || 'No se pudo cancelar.'); return; }
      toast('Encuentro cancelado. Se avisó a sus jugadores.');
      await load(); render();
    },
  };

  // ---------------- arranque ----------------
  document.addEventListener('click', (e) => {
    const el = e.target.closest('[data-a]');
    if (!el || el.disabled) return;
    const f = act[el.dataset.a];
    if (f) { e.preventDefault(); f(el.dataset); }
  });
  document.addEventListener('submit', (e) => {
    const form = e.target.closest('form[data-f]');
    if (!form) return;
    e.preventDefault();
    const f = submit[form.dataset.f];
    if (f) f(formData(form));
  });

  (async function boot() {
    await refreshSession();
    await load();
    render();
  })();
})();
