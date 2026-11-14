# Peloteo: agenda de encuentros deportivos

Sistema web para que jugadores se pongan de acuerdo en un deporte, lugar, día y hora, y se les asigne una cancha. Este archivo es la fuente de verdad del proyecto: léelo antes de cada tarea y actualízalo cuando cambie una decisión.

El archivo `referencia/peloteo.html` es el prototipo aprobado. Úsalo como guía de flujo, textos y estilo visual. Su almacenamiento y su login son de demostración y no deben copiarse.

## Objetivo y prioridades

1. Costo de operación mínimo (plan gratuito mientras el uso lo permita).
2. Uso desde el teléfono primero; sin registro obligatorio para los jugadores (cuentas opcionales preparadas, aún desactivadas).
3. Simple de mantener por una sola persona.

## Stack

- Cloudflare Workers (TypeScript) con Hono para las rutas.
- Cloudflare D1 (SQLite) como base de datos, con migraciones en `migrations/`.
- Frontend sin framework: HTML, CSS y JavaScript servidos como archivos estáticos por el mismo Worker.
- Sin dependencias que no sean necesarias. Antes de configurar `wrangler`, revisa la documentación vigente de Cloudflare: no asumas sintaxis de memoria.
- Idioma de la interfaz: español de Chile, con versión en inglés para el sitio público (ver Interfaz › Idiomas). El panel de configuración sigue solo en español. Zona horaria: `America/Santiago`.

## Estructura sugerida

```
src/            Worker: rutas, autenticación, lógica de negocio
src/lib/        disponibilidad, emparejamiento, notificaciones
public/         frontend público y de configuración
migrations/     SQL numerado (0001_init.sql, ...)
test/           pruebas de la lógica de negocio
referencia/     prototipo aprobado
```

## Modelo de datos

Todos los ID son texto corto único con prefijo (`L-`, `D-`, `C-`, `E-`), generados en el servidor. Fechas como `YYYY-MM-DD` y horas como `HH:MM`, siempre en hora local de Chile.

**venues** (lugares): `id`, `name`, `address`, `maps_url`, `created_at`.

**sports** (deporte dentro de un lugar): `id`, `venue_id`, `name`, `match_sizes` (cantidades de jugadores permitidas: `"2"`, `"4"` o `"2,4"`; tenis y pádel `"2,4"`: singles o dobles, migración `0008`), `visible` (1/0, migración `0010`: si se ofrece a los jugadores; por defecto sí), `created_at`. En la interfaz pública los deportes de distintos lugares se agrupan por nombre normalizado (sin tildes ni mayúsculas).

**categories**: `sport_id`, `level` (1 a 5), `label`, `label_en` (texto opcional en inglés, migración `0011`; si falta, se muestra `label`). Máximo 5 por deporte. El nivel 1 es avanzado y el 5 principiante. El texto es libre y puede ser amable o gracioso, por ejemplo "Estoy entrenando para Wimbledon" o "Apenas logro pasar la pelota".

**courts** (canchas): `id`, `sport_id`, `venue_id`, `name`, `surface` (arcilla, carpeta sintética, etc.), `status` (`operativa`, `mantencion`, `cerrada`), `notes`, `maps_url`, `lat`, `lng`, `open_time`, `close_time`, `slot_minutes` (60, 90 o 120), `days` (días de la semana en que opera, texto con números separados por coma donde 0 = domingo y 6 = sábado, por ejemplo `"1,2,3,4,5"`), `available_from`, `available_to` (opcionales). Cada cancha pertenece a un solo deporte; por ahora no se contemplan canchas compartidas entre deportes.

**games** (encuentros): `id`, `venue_id`, `sport_id`, `court_id` (nulo mientras no esté confirmado), `date`, `time`, `capacity` (una de las `match_sizes` del deporte), `accepted_levels` (niveles que acepta quien abrió el partido, texto como `"2,3,4"`), `status` (`abierto`, `sin_cancha`, `confirmado`, `cancelado`), `created_at`.
- Un encuentro `abierto` o `sin_cancha` nunca tiene cancha (CHECK en la base). Uno `confirmado` tiene cancha en modo reserva y no la tiene en modo coordinación (migración `0007`).
- Restricción única sobre (`court_id`, `date`, `time`) solo para encuentros `confirmado`: es la defensa contra la doble reserva.
- El estado `cancelado` lo asigna solo el administrador (ver Administrador).

**players** (cupos de un encuentro): `id`, `game_id`, `visitor_id`, `initials`, `level`, `email`, `whatsapp` (opcional), `whatsapp_opt_in`, `cancel_token`, `lang` (`es` o `en`, idioma de sus correos; migración `0011`), `created_at`. Un visitante no puede ocupar dos cupos del mismo encuentro.

**admins**: `id`, `username`, `password_hash`, `password_salt`, `totp_secret` (nulo), `totp_enabled` (falso), `totp_last_step` (último paso TOTP aceptado, migración `0005`), `must_change_password`.

**admin_recovery_codes** (códigos de respaldo del segundo factor, migración `0005`): `id` (prefijo `R-`), `admin_id`, `code_hash` (SHA-256 de `admin_id:código`, nunca el código), `used_at`, `created_at`.

**sessions**: `id`, `admin_id`, `expires_at`, `second_factor_passed`.

**Cuentas de jugadores (migración `0006`, preparadas y desactivadas):**
- **users**: `id` (prefijo `U-`), `email` (único, en minúsculas, verificado por el enlace), `initials`, `whatsapp`, `whatsapp_opt_in`, `created_at`, `last_login_at`.
- **user_levels**: `user_id`, `sport_key` (nombre normalizado del deporte, por ejemplo `tenis`), `level`.
- **login_links**: `id` (prefijo `K-`), `email`, `token_hash` (SHA-256), `visitor_id` (navegador que lo pidió), `expires_at`, `used_at`, `created_at`.
- **user_sessions**: `id` (SHA-256 del token), `user_id`, `expires_at`, `created_at`.
- **players.user_id** (nulo sin cuenta). Índice único (`game_id`, `user_id`) cuando no es nulo: una cuenta no ocupa dos cupos del mismo encuentro.

**settings** (ajustes del sitio, migración `0009`): `key`, `value` (texto; `"1"`/`"0"` para sí/no), `updated_at`. Hoy: `whatsapp_contact` (pedir el WhatsApp de los jugadores), apagado por defecto.

**login_attempts** (intentos fallidos de login del administrador): `id`, `username`, `ip`, `created_at`. Se usa para aplicar el límite de intentos.

**court_blocks** (bloqueos de canchas): `id` (prefijo `B-`), `court_id`, `date`, `start_time`, `end_time`, `reason` (opcional, por ejemplo "Reserva por teléfono"), `created_at`.

## Reglas de negocio

**Modo de canchas (decidido el 2026-11-14): `COURT_MODE = "coordinacion"`** en `wrangler.jsonc`. Mientras Peloteo no esté conectado al sistema de reservas de los clubes, no conoce la ocupación real de las canchas. El objetivo principal es poner de acuerdo a los jugadores:
- La interfaz no muestra canchas: solo deporte, lugar y hora ("Hora disponible" en vez de "N canchas libres"; sin cantidad de canchas en el desplegable ni en los lugares).
- Las horas ofrecidas salen del horario del club configurado en el admin (apertura, cierre, duración y días de las canchas del deporte en ese lugar) y sus bloqueos.
- A una misma hora se pueden confirmar como máximo tantos partidos como canchas operativas sin bloqueo tenga ese deporte en el lugar; los abiertos no ocupan. Se valida en SQL en la misma operación (`roomLeftSql` en `matching.ts`).
- Al completarse, el partido queda `confirmado` sin cancha (`court_id` nulo) y se comparten los contactos para que los jugadores reserven la cancha con el club. Si ya se alcanzó el máximo de esa hora, queda `sin_cancha`, como hoy.
- Los correos y pantallas lo dicen: "reserven la cancha con el club".
- El modo `"reserva"` (sin la variable, como en las pruebas antiguas) mantiene todo lo descrito abajo: cancha libre concreta, asignada al completarse. Las reglas siguientes describen ese modo; en coordinación se aplican salvo lo indicado arriba.

- **Turnos:** cada cancha genera turnos desde `open_time` mientras el turno completo termine antes de `close_time`. Solo canchas `operativa`, en sus días de operación y dentro de su rango de fechas.
- **Pasado:** un turno se muestra y se acepta (abrir, unirse) hasta 15 minutos después de su hora de inicio; pasado ese margen ya no se muestra ni se acepta.
- **Anticipación:** se puede agendar desde hoy hasta 15 días por adelantado (hoy + 15). Fechas fuera de ese rango no se muestran ni se aceptan.
- **Cancha libre:** una cancha está libre en un turno si genera ese turno y no tiene un encuentro `confirmado` a esa hora. Los encuentros abiertos no ocupan cancha.
- **Abrir partido:** el jugador elige deporte, lugar, día y hora; ingresa iniciales (2 a 4 letras), nivel y email; elige cuántos jugadores serán (una de las `match_sizes` del deporte; si hay una sola, se usa esa) y qué niveles acepta (al menos uno, entre las categorías del deporte, incluido el suyo). Solo se puede abrir si en ese momento queda al menos una cancha libre en el turno. El encuentro queda `abierto`, sin cancha asignada.
- **Unirse:** otro jugador puede sumarse a un encuentro `abierto` si su nivel está entre los `accepted_levels`. Al completarse `capacity` se asigna, en la misma operación, la primera cancha libre del turno (por nombre y luego ID) y el encuentro pasa a `confirmado`; se avisa a todos.
- **Sin cancha:** si al completarse ya no queda cancha libre, el encuentro no se confirma: pasa a `sin_cancha` (completo, sin cancha, no admite más jugadores), se avisa a los jugadores y se les ofrecen otros turnos.
- **Búsqueda:** por deporte, lugar, rango de fechas, rango de horas y el nivel del jugador. Devuelve solo encuentros a los que ese jugador puede unirse: `abierto`, con cupo, turno vigente, su nivel entre los aceptados y sin estar ya inscrito.
- **Cancelar:** un jugador puede liberar su cupo hasta 1 hora antes del inicio del encuentro; después, la opción no está disponible (ni en "Mis partidos" ni con el enlace del aviso). Si el encuentro queda sin jugadores se elimina; si estaba `confirmado` o `sin_cancha` vuelve a `abierto` sin cancha (la cancha se libera) y se avisa al resto.
- **Bloqueos:** el administrador puede bloquear una cancha en una fecha y un rango de horas, con un motivo opcional (por ejemplo, una reserva hecha por otro canal). Un turno de esa cancha que se cruce con el bloqueo, aunque sea en parte, no se ofrece ni se asigna: la cancha no cuenta como libre ni para abrir partido ni al confirmarse. Si al crear el bloqueo ya hay un encuentro confirmado en esa cancha cuyo turno se cruza, el sistema advierte y pide confirmación; si se confirma, el encuentro pasa a `cancelado` y se avisa a sus jugadores (el aviso real llega en la etapa 5). Los encuentros abiertos no tienen cancha y no se ven afectados al crear el bloqueo.
- **Cancelación por el administrador:** el administrador puede cancelar cualquier encuentro en cualquier momento. El encuentro no se borra: pasa a `cancelado`, la cancha queda libre y se avisa a sus jugadores.
- **Concurrencia:** crear y unirse deben validarse en el servidor dentro de una sola operación. Si el turno ya se ocupó, responder con un error claro para que la interfaz ofrezca otra hora.
- **Privacidad:** el contacto de un jugador solo se entrega a quienes comparten con él un encuentro confirmado. Las respuestas públicas solo incluyen iniciales y nivel.

## Jugadores sin registro

- Cookie `visitor_id` aleatoria (`V-` + 32 caracteres hex), de 400 días (el máximo que aceptan los navegadores), `HttpOnly`, `Secure`, `SameSite=Lax`, creada por el servidor en la primera llamada a `/api`. Una cookie con formato inválido se reemplaza.
- "Mis partidos" lista los encuentros de esa cookie de hoy en adelante, incluidos los cancelados por el administrador. Muestra el contacto de los compañeros solo si el encuentro está confirmado, y el botón de cancelar solo mientras falte al menos 1 hora.
- El navegador recuerda iniciales, email, WhatsApp y nivel por deporte en `localStorage`, solo como comodidad.
- **WhatsApp oculto (2026-11-14):**
  - El campo WhatsApp del formulario solo aparece si el administrador activa "Pedir el WhatsApp de los jugadores" en Configuración › Opciones (ajuste `whatsapp_contact`, que llega al sitio en `GET /api/today`). Apagado (por defecto), el servidor además descarta el número y el aviso aunque lleguen. Activado, el número se usa para el enlace `wa.me` entre compañeros confirmados.
  - La casilla "Avísenme también por WhatsApp" sigue oculta aunque el campo esté activo, porque la etapa 6 no está implementada; se muestra con `WHATSAPP_NOTICES = true` al inicio de `public/app.js` (y el campo activo). La base, el servidor y el perfil de cuentas ya la soportan.
- **Cuentas opcionales (preparadas, desactivadas; decidido el 2026-11-14):** el sitio sigue funcionando sin registro. Con `ACCOUNTS_ENABLED = "1"` (variable de `wrangler.jsonc`, hoy ausente) se activan:
  - Ingreso con un enlace de un solo uso enviado al correo (`https://peloteo.cl/#entrar=<token>`), sin contraseñas; vence en 15 minutos; máximo 3 enlaces por correo cada 15 minutos.
  - Al entrar se crea la cuenta si no existía y pasan a ella los cupos de ese navegador y los anotados con ese correo (uno por encuentro). Desde ahí se ven en todos los dispositivos.
  - Sesión en la cookie `peloteo_user` (`HttpOnly`, `Secure`, `SameSite=Lax`, 90 días); la base guarda el SHA-256 del token. La cookie `visitor_id` se mantiene para quien no tiene cuenta. Una cuenta igual necesita una cookie de sesión; lo que deja de depender del navegador es la información del jugador.
  - Perfil: iniciales, WhatsApp, aviso por WhatsApp y nivel por deporte (mismas reglas que al anotarse).
  - La lógica de partidos identifica a quien juega con `Who` (`src/lib/identity.ts`): un cupo es suyo si es de su navegador o de su cuenta. Sin cuentas, `userId` es nulo y todo funciona como antes.
  - Falta para activarlas: la interfaz (pedir el enlace, pantalla `#entrar=`, perfil, salir) y usar el perfil para completar el formulario. La lógica, las rutas y las pruebas están en `src/lib/accounts.ts`, `src/public.ts` y `test/accounts.test.ts`.
- Cada aviso incluye un enlace con `cancel_token`, para poder cancelar desde otro dispositivo: `https://peloteo.cl/#cancelar=<token>`. El token va en el fragmento (no llega al servidor ni queda en registros); la página lo quita de la barra de direcciones y lo envía en el cuerpo de un POST. La vista del enlace no muestra contactos.

## Administrador

- Login de un factor: usuario y contraseña. Contraseña con hash PBKDF2 (Web Crypto) y sal por usuario. Nunca en texto plano ni en el código.
- Usuario inicial `admin` / `admin`, creado por la migración con `must_change_password` activo: el sistema obliga a cambiarla en el primer ingreso.
- Sesión en cookie `HttpOnly`, `Secure`, `SameSite=Strict`, con expiración. Límite de 5 intentos fallidos; al llegar a 5 se bloquea el login de ese usuario e IP por 15 minutos, registrado en `login_attempts`.
- **Segundo factor (etapa 7, hecha):** opcional; el administrador lo activa o desactiva en Configuración › Seguridad. Login en dos pasos (`/login` y `/login/2fa`); mientras `totp_enabled` sea falso, el segundo paso se omite.
  - TOTP (RFC 6238): HMAC-SHA1, pasos de 30 segundos, 6 dígitos, tolerancia de ±1 paso, con Web Crypto (`src/lib/totp.ts`). Compatible con Google Authenticator, Microsoft Authenticator, Authy y 1Password.
  - Activar: `setup` genera una clave nueva (20 bytes, base32) sin activarla; la pantalla muestra un QR (generador propio sin dependencias en `public/admin/qr.js`), la clave en texto y un enlace `otpauth://`. `enable` la activa con el primer código válido, entrega 10 códigos de respaldo (se muestran una sola vez) y cierra las demás sesiones.
  - Cada código TOTP sirve una sola vez (`totp_last_step`, verificado con UPDATE condicionado). Los códigos de respaldo (`xxxx-xxxx-xxxx`) sirven una vez cada uno.
  - Al entrar con 2FA activo, la sesión nace sin segundo factor y dura 10 minutos; al pasar el código se extiende a 12 horas.
  - Los códigos incorrectos (y la contraseña incorrecta al desactivar) cuentan en `login_attempts` con el mismo límite de 5 en 15 minutos.
  - Desactivar pide contraseña y un código (de la app o de respaldo); borra la clave y los códigos y cierra las demás sesiones. Renovar los códigos de respaldo pide un código de la app.
  - La clave TOTP se guarda en D1 en texto (D1 cifra en reposo); quien lea la base podría generar códigos, pero igual necesitaría la contraseña.
  - Recuperación de último recurso (sin teléfono ni códigos): `npx wrangler d1 execute peloteo --remote --command "UPDATE admins SET totp_enabled = 0, totp_secret = NULL, totp_last_step = NULL WHERE username = 'admin'; DELETE FROM admin_recovery_codes; DELETE FROM sessions;"`
- **Deporte visible (2026-11-14):** casilla "Visible para los jugadores" en el formulario del deporte (marcada por defecto). El admin muestra el estado de cada deporte: "Visible", "Oculto" o "Sin canchas" (visible pero sin canchas operativas, así que aún no aparece). Un deporte oculto no aparece en el sitio ni admite partidos nuevos; los ya abiertos siguen su curso. Editar sin el campo no cambia la visibilidad.
- Módulo de configuración: crear, editar y eliminar lugares; dentro de cada lugar, deportes con sus categorías; dentro de cada deporte, canchas con sus características y horarios. Lista de encuentros con opción de cancelar (pasan a `cancelado`). Dentro de cada cancha, sus bloqueos: crear, ver (de hoy en adelante) y quitar.
- Eliminar un lugar, deporte o cancha con encuentros futuros debe pedir confirmación; esos encuentros pasan a `cancelado` y se avisa a los jugadores afectados.
- **Sin sobrescribir lo agendado:** se bloquea cualquier cambio a una cancha que afecte turnos con encuentros futuros confirmados en esa cancha (horario, duración del turno, días, rango de fechas, estado). Para hacerlo, el administrador primero cancela esos encuentros.
- **Eliminación lógica:** lugares, deportes y canchas eliminados se marcan con `deleted_at` (migración `0003`) y dejan de aparecer en todas partes; así los encuentros cancelados se conservan con sus referencias. Eliminar un lugar elimina sus deportes y canchas; eliminar un deporte, sus canchas.
- **Detalles del login (etapa 3):** sesión de 12 horas en la cookie `peloteo_admin` (`Path=/admin`); la base guarda el SHA-256 del token, no el token. Contraseña nueva de al menos 10 caracteres, distinta del usuario y de la actual; al cambiarla se cierran las demás sesiones. Las escrituras exigen mismo origen y, en POST, JSON (defensa CSRF además de `SameSite=Strict`). `POST /admin/login/2fa` recibe `{ code }` (TOTP o de respaldo).

## Rutas

Públicas:
- `GET /api/sports` deportes agrupados por nombre.
- `GET /api/venues?sport=` lugares que ofrecen el deporte.
- `GET /api/availability?sport_id=&month=` resumen por día del mes.
- `GET /api/availability?sport_id=&date=` turnos del día: canchas libres y encuentros abiertos.
- `POST /api/games` abrir partido.
- `POST /api/games/:id/join` unirse.
- `GET /api/search` búsqueda de jugadores.
- `GET /api/me/games` y `POST /api/games/:id/cancel`.
- Enlace de cancelación de los correos: `POST /api/token/game` (ver el encuentro) y `POST /api/token/cancel` (liberar el cupo), ambos con `{ token }` en el cuerpo.
- También: `GET /api/today` (fecha local y último día agendable, para el calendario) y `GET /api/sports/:id` (cantidades y categorías de un deporte).
- Inicio: `GET /api/open` (resumen de los próximos 8 días, hoy incluido: cuántos partidos buscan jugadores en AM y PM) y `GET /api/open/block?date=&half=am|pm` (esos partidos: deporte, lugar, hora, niveles aceptados, cupos y jugadores con iniciales y nivel; 400 fuera de los 8 días).
- `GET /api/search` recibe `sport_id`, `level` (nivel del jugador), `date_from`, `date_to`, `time_from` y `time_to`.
- Cuentas (responden 404 mientras `ACCOUNTS_ENABLED` no sea `"1"`): `POST /api/account/link` `{ email }` (envía el enlace; 429 si se pidieron demasiados), `POST /api/account/login` `{ token }`, `GET /api/account/me`, `PUT /api/account/profile` y `POST /api/account/logout`.
- Errores: JSON `{ error, code, field }` con 400 (datos), 404 (no existe) o 409 (turno ocupado, partido completo, ya inscrito, cancelado).

Administración (requieren sesión): `POST /admin/login`, `POST /admin/login/2fa`, `POST /admin/logout`, y CRUD bajo `/admin/api/venues`, `/sports`, `/courts`, `/games`.
- Opciones del sitio: `GET` y `PUT /admin/api/settings` (`{ whatsapp_contact }`); valores inválidos se ignoran.
- También: `GET /admin/session` (estado de la sesión para la interfaz), `POST /admin/password` (cambio de contraseña, permitido aunque `must_change_password` esté activo), `GET /admin/api/meta` (listas para los formularios) y `POST /admin/api/games/:id/cancel`.
- Segundo factor (sesión completa y contraseña ya cambiada): `GET /admin/2fa` (estado y códigos de respaldo restantes), `POST /admin/2fa/setup`, `POST /admin/2fa/enable` `{ code }`, `POST /admin/2fa/disable` `{ password, code }` y `POST /admin/2fa/recovery-codes` `{ code }`. Errores: 400 código o contraseña incorrectos, 409 estado inválido, 429 bloqueado.
- Bloqueos: `GET` y `POST /admin/api/courts/:id/blocks` (el POST responde 409 si hay encuentros confirmados afectados; se repite con `?confirm=1`) y `DELETE /admin/api/blocks/:id`.
- Eliminar (`DELETE`) con encuentros futuros afectados responde 409 con la lista; se repite con `?confirm=1` para cancelarlos y eliminar.
- Las pantallas de configuración están en `public/admin/` y se sirven en `/admin/`. Los estilos compartidos, tomados del prototipo, en `public/styles.css`.

Validar toda entrada en el servidor. Consultas siempre parametrizadas.

## Notificaciones

Una sola función `notify(evento, jugador, encuentro)` con canales intercambiables:

- **Etapa inicial (etapa 5, hecha):** correo con Resend y, en la pantalla de confirmación, enlace `wa.me` para que los jugadores emparejados se escriban entre ellos.
  - Envío con `fetch` a `POST https://api.resend.com/emails` (sin SDK), en `src/lib/email.ts`. Remitente `Peloteo <avisos@peloteo.cl>`; enlaces a `https://peloteo.cl` (`SITE_URL` y `MAIL_FROM` en `vars` de `wrangler.jsonc`).
  - La clave es el secret `RESEND_API_KEY` de Cloudflare (ya cargado). Nunca en archivos ni en `.dev.vars` del repositorio.
  - Canales según el entorno (`src/notices.ts`): con `EMAIL_MODE = "resend"` y la clave, correo real; en `localhost` (o con `EMAIL_MODE = "consola"`, o sin clave) el correo completo se muestra en la consola de `wrangler dev` y no se envía; sin `EMAIL_MODE` (pruebas), solo el registro.
  - Los avisos se envían después de responder (`waitUntil`). Un error de Resend se registra sin el email del jugador y no afecta la operación.
  - Contenido: el contacto de los compañeros (email, WhatsApp y enlace `wa.me`) solo va en "partido confirmado". "Sin cancha" sugiere hasta 6 turnos con cancha libre del mismo deporte y lugar, ese día y los dos siguientes. "Encuentro cancelado" distingue si fue el administrador o un bloqueo.
  - Al completarse un partido no se envía "jugador se sumó": basta "confirmado" o "sin cancha".
- **Etapa posterior:** WhatsApp Cloud API con plantillas de utilidad aprobadas, solo a quienes marcaron `whatsapp_opt_in`. Requiere cuenta de Meta verificada y número dedicado; cada mensaje tiene costo.

Eventos: partido publicado, jugador se sumó, partido confirmado, partido sin cancha (con otros turnos sugeridos), cupo cancelado, encuentro eliminado por el administrador.

Las claves de proveedores van como secrets de Cloudflare, nunca en el repositorio.

## Interfaz

- **Inicio (2026-11-14):** foto con "¿JUGAMOS?"; debajo, la tarjeta "¿Buscas con quién jugar?" con un calendario horizontal de 8 días (hoy incluido), cada día con un bloque AM (antes de las 12:00) y uno PM. El bloque es blanco si nadie busca jugadores y naranjo (`#EE8A24`) si hay partidos `abierto` con cupo en turno vigente (sin filtrar por nivel y sin contar los del propio visitante). Debajo, la tarjeta blanca "Crea un partido" con el desplegable de deportes.
  - **Deportes siempre en un menú desplegable** (portada, crear en un bloque y búsqueda). Al inicio el sitio será solo de tenis, pero queda listo para sumar otros: el desplegable muestra los deportes marcados "Visible para los jugadores" que tengan al menos una cancha operativa (de su horario salen las horas). Por defecto elige el último usado en ese navegador; si no, tenis.
  - AM y PM de cada día se ven como una sola pieza: esquinas redondeadas solo arriba de AM y abajo de PM, rectas al medio y separadas por 2 px.
  - Al tocar un bloque se abre la lista de sus partidos (hora, deporte y lugar, niveles, cupos, quiénes juegan) con "Unirme" (va al formulario; el servidor valida el nivel) y, debajo, la opción de crear un partido: se elige el deporte y el calendario abre en ese día. Desde AM se ofrece el día completo (mañana y tarde); desde PM, solo la tarde ("Ver todo el día" quita ese filtro). Si el día es hoy, solo se ofrecen horas que aún no comienzan.
  - **Guía de bienvenida (2026-11-14):** ventana (`<dialog>`) de 4 pasos que explica para qué sirve: encontrar con quién jugar, elegir día y hora, ponerse de acuerdo (contacto compartido; en coordinación, reservar con el club) y "¡Listo, a jugar!". Cada paso con una ilustración SVG propia sobre verde cancha. Aparece al entrar al inicio (no con el enlace de cancelar) hasta que se marca "No volver a mostrar esta guía" en el último paso, que se guarda en la cookie `peloteo_intro=1` (400 días, la escribe el navegador). Si se cierra sin marcarla, vuelve en la próxima visita, no en la misma (`sessionStorage`). El botón "¿Cómo funciona?" del héroe la abre de nuevo.
  - "Configuración" está en la barra superior (ícono de engranaje; el texto se oculta hasta 640 px), ya no al pie de la página.
- **Idiomas (2026-11-14):** español e inglés en todo el sitio público.
  - Selector en la barra superior, al lado de Buscar: bandera de España con "ESP" y del Reino Unido (Union Jack) con "ENG" (SVG propios en `public/app.js`). Hasta 600 px la barra queda solo con íconos y el código va bajo la bandera; hasta 800 px "Buscar" y "Configuración" van solo con su ícono.
  - El idioma elegido se guarda en la cookie `peloteo_lang` (`es`/`en`, 400 días, la escribe el navegador). Sin elección: inglés si el navegador está en inglés; si no, español.
  - Textos de la interfaz con `L('español', 'English')` en `public/app.js` (incluida la guía de bienvenida). Fechas en inglés: "Monday, November 16".
  - El servidor traduce los mensajes de error de `/api` según la cookie (`src/lib/i18n.ts`: `ERRORS_EN` y patrones). Toda frase de error nueva debe agregarse ahí; una prueba lo exige.
  - Nombres de deportes conocidos en inglés (`SPORTS_EN` en `src/lib/i18n.ts`, que llega en `GET /api/today` como `sport_names_en`); los lugares no se traducen. Las categorías usan `label_en` (se edita en el formulario del deporte del admin).
  - Correos: cada cupo guarda el idioma de quien se anotó (`player.lang` al abrir o unirse) y cada jugador recibe sus avisos en ese idioma, aunque sus compañeros usen el otro. El correo de ingreso a cuentas (desactivadas) sigue solo en español.
- Flujo público: deporte, lugar, calendario (solo días entre hoy y hoy + 15; si el rango cruza al mes siguiente, se puede avanzar a ese mes), horas del día, formulario, confirmación.
- El calendario marca los días con encuentros que buscan jugadores.
- El selector de nivel muestra el número y el texto de la categoría.
- Al abrir un partido: selector de cantidad de jugadores (solo si el deporte permite más de una) y selección de niveles aceptados.
- La búsqueda pide el nivel del jugador (no una lista de niveles).
- Archivos: `public/index.html` y `public/app.js` (flujo público), `public/styles.css` (compartido). Si un deporte se ofrece en un solo lugar, se salta la pantalla de lugares.
- En los grupos de deportes se muestra el nombre más usado; si empatan, el que lleva tilde y no está en mayúsculas ("Pádel" antes que "PADEL").
- El calendario solo deja avanzar a los meses que tocan el rango agendable (hoy a hoy + 15).
- Mantener paleta, tipografía y textos del prototipo. Funcionar en modo claro y oscuro.
- **Dirección visual elegida (2026-11-13): A · "Luz de cancha"**, evolución de la marca actual. Maquetas en https://claude.ai/artifact/4Z6QsbsZHRfGN7STZhyEPo (privado). Aplicada en `public/styles.css` (bloque "Dirección visual A" al final) y en el inicio de `public/app.js` (héroe con líneas de cancha, íconos por deporte, tarjeta de búsqueda). El título "¿JUGAMOS?" se ajusta al ancho disponible (probado desde 320 px).
  - Paleta (modo oscuro): fondo `#0B1611`, tarjetas `#16261E`, bordes `#2A3D33`, cancha `#2C8A66` (líneas y estados), pelota `#D7E845` (acento único: acción principal, cupos e insignias), arcilla `#E48E6C` (cancelar y errores), texto `#EEF3EF`, texto secundario `#9DB2A6`. El modo claro conserva la paleta actual (fondo `#EDF2EC`, cancha `#1E6B4F`) y se sigue la preferencia del sistema.
  - Tipografía: solo Archivo; títulos con `font-stretch: 125%`, peso 800–900 y en mayúsculas; cuerpo en ancho normal; horas y cupos con cifras tabulares.
  - Íconos: SVG en línea, trazo de 2,25 px con puntas redondas y sin relleno (pádel, tenis, día, hora, lugar, jugadores, buscar).
  - Imágenes: fotos reales de las canchas en duotono verde y negro, con las líneas de la cancha dibujadas encima; solo en el inicio y en la tarjeta de cada lugar. Mientras no haya fotos, se usan solo las líneas de la cancha en SVG.
  - Logotipo (2026-11-13): `public/img/logo.png` (pelota con calendario y "peloteo.cl"), en la esquina superior izquierda del sitio y del admin en vez de la palabra. Es una versión con fondo transparente, recortada y reducida a 648×120 a partir del PNG original con fondo verde. Alto de 1,9 rem (1,75 rem hasta 420 px y 1,45 rem hasta 360 px); en teléfonos "Buscar" queda solo con su ícono.
  - Favicon (2026-11-13): la pelota naranja del logotipo. `public/favicon.ico` (16, 32 y 48 px), `public/img/icon-192.png` (transparente) y `public/img/apple-touch-icon.png` (180 px sobre `#0B1611`, para el acceso directo en iPhone), enlazados en `public/index.html` y `public/admin/index.html`.
  - Inicio (2026-11-13): por decisión del dueño, el héroe usa la foto `public/img/inicio-tenis.webp` (pelota en cancha de arcilla, colores naturales, sin duotono) con un degradado oscuro abajo para que el título se lea. Es decorativa: va como fondo en CSS.
- Accesible: foco visible, etiquetas en todos los campos, objetivos táctiles amplios.

## Etapas de construcción

1. Estructura del proyecto, `wrangler`, D1 y migración inicial con datos de ejemplo.
2. Lógica de disponibilidad y emparejamiento con pruebas.
3. Login del administrador y módulo de configuración.
4. Flujo público completo y "Mis partidos".
5. Notificaciones por correo y enlaces de cancelación.
6. WhatsApp Cloud API.
7. Segundo factor para el administrador (hecha antes que la 6, por decisión del 2026-11-13).

Terminar y probar cada etapa antes de empezar la siguiente. Un commit por cambio coherente, con mensaje en español.

## Desarrollo local

```
npm install          # dependencias (wrangler, hono, typescript)
npm run db:migrate   # aplica migrations/ a la base D1 local (.wrangler/state)
npm run dev          # wrangler dev en http://localhost:8787
npm test             # pruebas de la lógica de negocio (node --test)
npm run check        # genera tipos (wrangler types) y revisa con tsc
```

- Las pruebas usan el runner de Node (`node --test`) y SQLite incorporado (`node:sqlite`), sin dependencias extra. `test/helpers/db.ts` imita la API de D1 (incluido `batch` transaccional) y aplica las migraciones reales.
- Los imports entre archivos TypeScript llevan extensión `.ts` para que Node los ejecute directamente. `tsc` revisa `src/`; las pruebas no se revisan con `tsc` (no hay tipos de Node instalados).

- La base remota `peloteo` ya existe (región ENAM) y su ID está en `wrangler.jsonc`. Migraciones remotas: `npx wrangler d1 migrations apply peloteo --remote`. La base remota tiene aplicadas hasta `0011`.
- La base local se identifica por el `database_id`: si cambia, queda una base local vacía y hay que volver a `npm run db:migrate`.
- Despliegue: automático con Workers Builds en cada push a `main` (aparece como check "Workers Builds: peloteo" en GitHub). Hacer push equivale a desplegar en producción. Despliegue manual: `npx wrangler deploy`. Dirección pública: https://peloteo.cl (también responde https://peloteo.peloteo.workers.dev).
- Las migraciones no se aplican solas: aplicar las nuevas a la base remota antes del push que trae el código que las necesita.
- Para empezar de cero en local, borrar `.wrangler/state` y volver a `npm run db:migrate`.
- `GET /api/health` devuelve el conteo de registros; sirve para comprobar que el Worker y D1 responden.
- La migración `0001_init.sql` incluye los datos de ejemplo del prototipo. Antes de producción, decidir si se eliminan con una migración posterior.

Convenciones fijadas en la etapa 1:

- Prefijos adicionales de ID: `J-` para cupos de jugadores (`players`), `A-` para administradores.
- `password_hash` guarda `pbkdf2-sha256$<iteraciones>$<hash hex>` (100.000 iteraciones, el máximo que admite Web Crypto en Workers); `password_salt` en hex.
- `created_at` en UTC (ISO 8601); `date` y `time` de los encuentros en hora local de Chile.

Lógica de la etapa 2 (`src/lib/`):

- `time.ts`: hora local de Chile, rango agendable (hoy + 15) y margen de 15 minutos.
- `availability.ts`: turnos por cancha, disponibilidad del día y resumen del mes.
- `matching.ts`: abrir partido, unirse, cancelar (por visitante o por token) y búsqueda. Cada escritura es un solo `db.batch()` con condiciones en SQL; los errores son `MatchError` con un `code` y un mensaje para la interfaz. Las funciones no llaman a `notify()`: devuelven `notices` (evento y jugadores) para que la ruta los envíe.
- La primera cancha libre se elige por nombre y luego por ID, al confirmarse el encuentro.
- Los jugadores de un encuentro se ordenan por orden de llegada (`rowid`).
- Cancelar un cupo solo se permite hasta 1 hora antes del inicio (`canStillCancel` en `time.ts`).
- Los bloqueos se respetan en la vista (`availability.ts`) y en la asignación de cancha, que lo verifica en SQL dentro de la misma transacción.
- "Cupo cancelado" se avisa al resto solo cuando un encuentro `confirmado` o `sin_cancha` vuelve a abierto.

## Forma de trabajo

- Probar en local con `wrangler dev` antes de desplegar.
- Toda regla de negocio nueva lleva su prueba.
- No agregar dependencias, servicios pagos ni funciones fuera de este documento sin preguntar.
- Si una instrucción contradice este archivo, preguntar antes de avanzar.

## Decisiones pendientes

Marcar aquí la respuesta cuando se defina:

- Encuentro `sin_cancha`: ¿cómo se "ofrecen otros turnos"? (Supuesto actual: el aviso sugiere turnos con canchas libres y los jugadores deciden; el encuentro queda `sin_cancha` hasta que cancelen.) ¿Se confirma solo si se libera una cancha en ese turno?
- ¿Se muestran encuentros abiertos de un turno que ya no tiene canchas libres? (Supuesto actual: sí, pero al completarse quedarán `sin_cancha`.)
- ¿Quien abre debe incluir su propio nivel entre los aceptados? (Supuesto actual: sí.)
- PBKDF2 con 100.000 iteraciones podría superar el límite de CPU del plan gratuito de Workers (10 ms por solicitud) en el login. Verificar al desplegar; si falla, bajar las iteraciones (el formato del hash las guarda, así que se puede migrar sin perder la contraseña).

Decididas (2026-11-12):

- Anticipación máxima: 15 días.
- `cancelado` es exclusivo del administrador; los encuentros cancelados se conservan.
- Login del administrador: 5 intentos fallidos por usuario e IP; luego, espera de 15 minutos (actualizado; antes eran 2). Registrados en `login_attempts`.
- `days`: 0 = domingo a 6 = sábado, texto separado por comas.
- Avisos antes de la etapa 5: `notify()` con un canal que solo registra.
- Cada cancha pertenece a un solo deporte.
- No se puede modificar una cancha si eso afecta encuentros futuros; el administrador siempre puede cancelar.
- Un turno sigue visible y aceptando jugadores hasta 15 minutos después de su inicio.
- La migración incluye el hash y la sal de la contraseña inicial `admin`; se acepta porque se obliga a cambiarla en el primer ingreso.
- Jugadores por partido: cada deporte define las cantidades permitidas (tenis y pádel: 2 o 4, singles o dobles; tenis desde el 2026-11-14, migración `0008`) y quien abre elige una; la API exige elegir cuando hay más de una.
- Cancha: no se retiene al abrir; se asigna la primera libre al completarse. Solo se abre si queda al menos una cancha libre. Si al completarse no hay cancha, el encuentro no se confirma (`sin_cancha`). La restricción única aplica solo a confirmados (migración `0002`).
- Niveles: quien abre define los niveles aceptados; solo se unen jugadores de esos niveles; la búsqueda muestra solo encuentros a los que el jugador puede unirse.
- Bloqueos: el administrador bloquea una cancha por fecha y rango de horas, con motivo opcional; el turno bloqueado no se ofrece ni se asigna; si hay un encuentro confirmado, se advierte y, al confirmar, se cancela (migración `0004`).
- Cancelación de un cupo: hasta 1 hora antes del inicio.
- Correo: Resend, remitente `avisos@peloteo.cl` ("Peloteo"); dominio definitivo https://peloteo.cl (2026-11-13).
- Segundo factor (2026-11-13): opcional, QR generado sin dependencias y 10 códigos de respaldo; se hizo antes de la etapa 6.
- Cuentas de jugadores (2026-11-14): opcionales, ingreso por enlace al correo, los partidos previos pasan a la cuenta. Preparadas (migración `0006`, lógica, rutas y pruebas) pero desactivadas hasta construir su interfaz.
- Deportes (2026-11-14): al inicio solo tenis; siempre se eligen en un menú desplegable.
- Canchas (2026-11-14): modo coordinación; solo se muestran deporte, lugar y hora; las horas salen del horario del club; a una misma hora, como máximo tantos confirmados como canchas; al completarse se confirma sin cancha y los jugadores la reservan con el club (migración `0007`). La lógica de reserva queda lista para cuando haya conexión con el club.
- Idiomas (2026-11-14): sitio público en español e inglés, con selector ESP/ENG en la barra; correos en el idioma de cada jugador; categorías con texto opcional en inglés (migración `0011`). El admin sigue en español.
- WhatsApp (2026-11-14): el campo del número se activa solo desde Configuración › Opciones (apagado por defecto, migración `0009`); el aviso por WhatsApp sigue oculto hasta implementar la etapa 6 (`WHATSAPP_NOTICES` en `public/app.js`).
