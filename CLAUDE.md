# Peloteo: agenda de encuentros deportivos

Sistema web para que jugadores se pongan de acuerdo en un deporte, lugar, día y hora, y se les asigne una cancha. Este archivo es la fuente de verdad del proyecto: léelo antes de cada tarea y actualízalo cuando cambie una decisión.

El archivo `referencia/peloteo.html` es el prototipo aprobado. Úsalo como guía de flujo, textos y estilo visual. Su almacenamiento y su login son de demostración y no deben copiarse.

## Objetivo y prioridades

1. Costo de operación mínimo (plan gratuito mientras el uso lo permita).
2. Uso desde el teléfono primero; sin registro para los jugadores.
3. Simple de mantener por una sola persona.

## Stack

- Cloudflare Workers (TypeScript) con Hono para las rutas.
- Cloudflare D1 (SQLite) como base de datos, con migraciones en `migrations/`.
- Frontend sin framework: HTML, CSS y JavaScript servidos como archivos estáticos por el mismo Worker.
- Sin dependencias que no sean necesarias. Antes de configurar `wrangler`, revisa la documentación vigente de Cloudflare: no asumas sintaxis de memoria.
- Idioma de la interfaz: español de Chile. Zona horaria: `America/Santiago`.

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

**sports** (deporte dentro de un lugar): `id`, `venue_id`, `name`, `match_sizes` (cantidades de jugadores permitidas: `"2"`, `"4"` o `"2,4"`; por ejemplo tenis `"2"` y pádel `"2,4"`), `created_at`. En la interfaz pública los deportes de distintos lugares se agrupan por nombre normalizado (sin tildes ni mayúsculas).

**categories**: `sport_id`, `level` (1 a 5), `label`. Máximo 5 por deporte. El nivel 1 es avanzado y el 5 principiante. El texto es libre y puede ser amable o gracioso, por ejemplo "Estoy entrenando para Wimbledon" o "Apenas logro pasar la pelota".

**courts** (canchas): `id`, `sport_id`, `venue_id`, `name`, `surface` (arcilla, carpeta sintética, etc.), `status` (`operativa`, `mantencion`, `cerrada`), `notes`, `maps_url`, `lat`, `lng`, `open_time`, `close_time`, `slot_minutes` (60, 90 o 120), `days` (días de la semana en que opera, texto con números separados por coma donde 0 = domingo y 6 = sábado, por ejemplo `"1,2,3,4,5"`), `available_from`, `available_to` (opcionales). Cada cancha pertenece a un solo deporte; por ahora no se contemplan canchas compartidas entre deportes.

**games** (encuentros): `id`, `venue_id`, `sport_id`, `court_id` (nulo mientras no esté confirmado), `date`, `time`, `capacity` (una de las `match_sizes` del deporte), `accepted_levels` (niveles que acepta quien abrió el partido, texto como `"2,3,4"`), `status` (`abierto`, `sin_cancha`, `confirmado`, `cancelado`), `created_at`.
- Un encuentro `confirmado` siempre tiene cancha; uno `abierto` o `sin_cancha`, nunca (CHECK en la base).
- Restricción única sobre (`court_id`, `date`, `time`) solo para encuentros `confirmado`: es la defensa contra la doble reserva.
- El estado `cancelado` lo asigna solo el administrador (ver Administrador).

**players** (cupos de un encuentro): `id`, `game_id`, `visitor_id`, `initials`, `level`, `email`, `whatsapp` (opcional), `whatsapp_opt_in`, `cancel_token`, `created_at`. Un visitante no puede ocupar dos cupos del mismo encuentro.

**admins**: `id`, `username`, `password_hash`, `password_salt`, `totp_secret` (nulo), `totp_enabled` (falso), `must_change_password`.

**sessions**: `id`, `admin_id`, `expires_at`, `second_factor_passed`.

**login_attempts** (intentos fallidos de login del administrador): `id`, `username`, `ip`, `created_at`. Se usa para aplicar el límite de intentos.

**court_blocks** (bloqueos de canchas): `id` (prefijo `B-`), `court_id`, `date`, `start_time`, `end_time`, `reason` (opcional, por ejemplo "Reserva por teléfono"), `created_at`.

## Reglas de negocio

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
- Cada aviso incluye un enlace con `cancel_token`, para poder cancelar desde otro dispositivo: `https://peloteo.cl/#cancelar=<token>`. El token va en el fragmento (no llega al servidor ni queda en registros); la página lo quita de la barra de direcciones y lo envía en el cuerpo de un POST. La vista del enlace no muestra contactos.

## Administrador

- Login de un factor: usuario y contraseña. Contraseña con hash PBKDF2 (Web Crypto) y sal por usuario. Nunca en texto plano ni en el código.
- Usuario inicial `admin` / `admin`, creado por la migración con `must_change_password` activo: el sistema obliga a cambiarla en el primer ingreso.
- Sesión en cookie `HttpOnly`, `Secure`, `SameSite=Strict`, con expiración. Límite de 5 intentos fallidos; al llegar a 5 se bloquea el login de ese usuario e IP por 15 minutos, registrado en `login_attempts`.
- **Preparado para 2FA:** el login ya es un flujo de dos pasos (`/login` y `/login/2fa`). Mientras `totp_enabled` sea falso, el segundo paso se omite. No implementar TOTP todavía, pero no cerrar el diseño.
- Módulo de configuración: crear, editar y eliminar lugares; dentro de cada lugar, deportes con sus categorías; dentro de cada deporte, canchas con sus características y horarios. Lista de encuentros con opción de cancelar (pasan a `cancelado`). Dentro de cada cancha, sus bloqueos: crear, ver (de hoy en adelante) y quitar.
- Eliminar un lugar, deporte o cancha con encuentros futuros debe pedir confirmación; esos encuentros pasan a `cancelado` y se avisa a los jugadores afectados.
- **Sin sobrescribir lo agendado:** se bloquea cualquier cambio a una cancha que afecte turnos con encuentros futuros confirmados en esa cancha (horario, duración del turno, días, rango de fechas, estado). Para hacerlo, el administrador primero cancela esos encuentros.
- **Eliminación lógica:** lugares, deportes y canchas eliminados se marcan con `deleted_at` (migración `0003`) y dejan de aparecer en todas partes; así los encuentros cancelados se conservan con sus referencias. Eliminar un lugar elimina sus deportes y canchas; eliminar un deporte, sus canchas.
- **Detalles del login (etapa 3):** sesión de 12 horas en la cookie `peloteo_admin` (`Path=/admin`); la base guarda el SHA-256 del token, no el token. Contraseña nueva de al menos 10 caracteres, distinta del usuario y de la actual; al cambiarla se cierran las demás sesiones. Las escrituras exigen mismo origen y, en POST, JSON (defensa CSRF además de `SameSite=Strict`). `POST /admin/login/2fa` responde 501 mientras TOTP no esté implementado (etapa 7).

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
- `GET /api/search` recibe `sport_id`, `level` (nivel del jugador), `date_from`, `date_to`, `time_from` y `time_to`.
- Errores: JSON `{ error, code, field }` con 400 (datos), 404 (no existe) o 409 (turno ocupado, partido completo, ya inscrito, cancelado).

Administración (requieren sesión): `POST /admin/login`, `POST /admin/login/2fa`, `POST /admin/logout`, y CRUD bajo `/admin/api/venues`, `/sports`, `/courts`, `/games`.
- También: `GET /admin/session` (estado de la sesión para la interfaz), `POST /admin/password` (cambio de contraseña, permitido aunque `must_change_password` esté activo), `GET /admin/api/meta` (listas para los formularios) y `POST /admin/api/games/:id/cancel`.
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

- Flujo público: deporte, lugar, calendario (solo días entre hoy y hoy + 15; si el rango cruza al mes siguiente, se puede avanzar a ese mes), horas del día, formulario, confirmación.
- El calendario marca los días con encuentros que buscan jugadores.
- El selector de nivel muestra el número y el texto de la categoría.
- Al abrir un partido: selector de cantidad de jugadores (solo si el deporte permite más de una) y selección de niveles aceptados.
- La búsqueda pide el nivel del jugador (no una lista de niveles).
- Archivos: `public/index.html` y `public/app.js` (flujo público), `public/styles.css` (compartido). Si un deporte se ofrece en un solo lugar, se salta la pantalla de lugares.
- En los grupos de deportes se muestra el nombre más usado; si empatan, el que lleva tilde y no está en mayúsculas ("Pádel" antes que "PADEL").
- El calendario solo deja avanzar a los meses que tocan el rango agendable (hoy a hoy + 15).
- Mantener paleta, tipografía y textos del prototipo. Funcionar en modo claro y oscuro.
- Accesible: foco visible, etiquetas en todos los campos, objetivos táctiles amplios.

## Etapas de construcción

1. Estructura del proyecto, `wrangler`, D1 y migración inicial con datos de ejemplo.
2. Lógica de disponibilidad y emparejamiento con pruebas.
3. Login del administrador y módulo de configuración.
4. Flujo público completo y "Mis partidos".
5. Notificaciones por correo y enlaces de cancelación.
6. WhatsApp Cloud API.
7. Segundo factor para el administrador.

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

- La base remota `peloteo` ya existe (región ENAM) y su ID está en `wrangler.jsonc`. Migraciones remotas: `npx wrangler d1 migrations apply peloteo --remote`. La base remota tiene aplicadas hasta `0004`.
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
- Jugadores por partido: cada deporte define las cantidades permitidas (tenis 2; pádel 2 o 4) y quien abre elige una.
- Cancha: no se retiene al abrir; se asigna la primera libre al completarse. Solo se abre si queda al menos una cancha libre. Si al completarse no hay cancha, el encuentro no se confirma (`sin_cancha`). La restricción única aplica solo a confirmados (migración `0002`).
- Niveles: quien abre define los niveles aceptados; solo se unen jugadores de esos niveles; la búsqueda muestra solo encuentros a los que el jugador puede unirse.
- Bloqueos: el administrador bloquea una cancha por fecha y rango de horas, con motivo opcional; el turno bloqueado no se ofrece ni se asigna; si hay un encuentro confirmado, se advierte y, al confirmar, se cancela (migración `0004`).
- Cancelación de un cupo: hasta 1 hora antes del inicio.
- Correo: Resend, remitente `avisos@peloteo.cl` ("Peloteo"); dominio definitivo https://peloteo.cl (2026-11-13).
