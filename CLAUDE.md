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

**sports** (deporte dentro de un lugar): `id`, `venue_id`, `name`, `players_per_match` (2 o 4), `created_at`. En la interfaz pública los deportes de distintos lugares se agrupan por nombre normalizado (sin tildes ni mayúsculas).

**categories**: `sport_id`, `level` (1 a 5), `label`. Máximo 5 por deporte. El nivel 1 es avanzado y el 5 principiante. El texto es libre y puede ser amable o gracioso, por ejemplo "Estoy entrenando para Wimbledon" o "Apenas logro pasar la pelota".

**courts** (canchas): `id`, `sport_id`, `venue_id`, `name`, `surface` (arcilla, carpeta sintética, etc.), `status` (`operativa`, `mantencion`, `cerrada`), `notes`, `maps_url`, `lat`, `lng`, `open_time`, `close_time`, `slot_minutes` (60, 90 o 120), `days` (días de la semana en que opera, texto con números separados por coma donde 0 = domingo y 6 = sábado, por ejemplo `"1,2,3,4,5"`), `available_from`, `available_to` (opcionales). Cada cancha pertenece a un solo deporte; por ahora no se contemplan canchas compartidas entre deportes.

**games** (encuentros): `id`, `venue_id`, `sport_id`, `court_id`, `date`, `time`, `capacity`, `status` (`abierto`, `confirmado`, `cancelado`), `created_at`. Restricción única sobre (`court_id`, `date`, `time`) para encuentros no cancelados: es la defensa contra la doble reserva. El estado `cancelado` lo asigna solo el administrador (ver Administrador).

**players** (cupos de un encuentro): `id`, `game_id`, `visitor_id`, `initials`, `level`, `email`, `whatsapp` (opcional), `whatsapp_opt_in`, `cancel_token`, `created_at`. Un visitante no puede ocupar dos cupos del mismo encuentro.

**admins**: `id`, `username`, `password_hash`, `password_salt`, `totp_secret` (nulo), `totp_enabled` (falso), `must_change_password`.

**sessions**: `id`, `admin_id`, `expires_at`, `second_factor_passed`.

**login_attempts** (intentos fallidos de login del administrador): `id`, `username`, `ip`, `created_at`. Se usa para aplicar el límite de intentos.

## Reglas de negocio

- **Turnos:** cada cancha genera turnos desde `open_time` mientras el turno completo termine antes de `close_time`. Solo canchas `operativa`, en sus días de operación y dentro de su rango de fechas.
- **Pasado:** un turno se muestra y se acepta (abrir, unirse) hasta 15 minutos después de su hora de inicio; pasado ese margen ya no se muestra ni se acepta.
- **Anticipación:** se puede agendar desde hoy hasta 15 días por adelantado (hoy + 15). Fechas fuera de ese rango no se muestran ni se aceptan.
- **Abrir partido:** el jugador elige deporte, lugar, día y hora; ingresa iniciales (2 a 4 letras), nivel y email. Se le asigna la primera cancha libre de ese turno y el encuentro queda `abierto`, reteniendo la cancha.
- **Unirse:** otro jugador puede sumarse a un encuentro abierto. Al completarse `capacity`, pasa a `confirmado` y se avisa a todos.
- **Búsqueda:** por deporte, lugar, rango de fechas, rango de horas y niveles aceptados. Devuelve encuentros abiertos donde algún jugador tiene uno de esos niveles.
- **Cancelar:** un jugador puede liberar su cupo. Si el encuentro queda sin jugadores se elimina y la cancha se libera; si estaba confirmado vuelve a `abierto` y se avisa al resto.
- **Cancelación por el administrador:** el administrador puede cancelar cualquier encuentro en cualquier momento. El encuentro no se borra: pasa a `cancelado`, la cancha queda libre y se avisa a sus jugadores.
- **Concurrencia:** crear y unirse deben validarse en el servidor dentro de una sola operación. Si el turno ya se ocupó, responder con un error claro para que la interfaz ofrezca otra hora.
- **Privacidad:** el contacto de un jugador solo se entrega a quienes comparten con él un encuentro confirmado. Las respuestas públicas solo incluyen iniciales y nivel.

## Jugadores sin registro

- Cookie `visitor_id` aleatoria, de larga duración, `HttpOnly`, `Secure`, `SameSite=Lax`, creada por el servidor en la primera visita.
- "Mis partidos" lista los encuentros de esa cookie.
- Cada aviso incluye un enlace con `cancel_token`, para poder cancelar desde otro dispositivo.

## Administrador

- Login de un factor: usuario y contraseña. Contraseña con hash PBKDF2 (Web Crypto) y sal por usuario. Nunca en texto plano ni en el código.
- Usuario inicial `admin` / `admin`, creado por la migración con `must_change_password` activo: el sistema obliga a cambiarla en el primer ingreso.
- Sesión en cookie `HttpOnly`, `Secure`, `SameSite=Strict`, con expiración. Límite de 2 intentos fallidos; al superarlo se bloquea el login de ese usuario e IP por 15 minutos (duración provisional), registrado en `login_attempts`.
- **Preparado para 2FA:** el login ya es un flujo de dos pasos (`/login` y `/login/2fa`). Mientras `totp_enabled` sea falso, el segundo paso se omite. No implementar TOTP todavía, pero no cerrar el diseño.
- Módulo de configuración: crear, editar y eliminar lugares; dentro de cada lugar, deportes con sus categorías; dentro de cada deporte, canchas con sus características y horarios. Lista de encuentros con opción de cancelar (pasan a `cancelado`).
- Eliminar un lugar, deporte o cancha con encuentros futuros debe pedir confirmación; esos encuentros pasan a `cancelado` y se avisa a los jugadores afectados.
- **Sin sobrescribir lo agendado:** se bloquea cualquier cambio a una cancha que afecte turnos con encuentros futuros no cancelados (horario, duración del turno, días, rango de fechas, estado). Para hacerlo, el administrador primero cancela esos encuentros.
- Mientras no exista el canal de correo (etapa 5), los avisos se envían por `notify()` con un canal que solo los registra; la etapa 5 le conecta el correo sin cambiar quien llama.

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

Administración (requieren sesión): `POST /admin/login`, `POST /admin/login/2fa`, `POST /admin/logout`, y CRUD bajo `/admin/api/venues`, `/sports`, `/courts`, `/games`.

Validar toda entrada en el servidor. Consultas siempre parametrizadas.

## Notificaciones

Una sola función `notify(evento, jugador, encuentro)` con canales intercambiables:

- **Etapa inicial:** correo transaccional (proveedor por definir) y, en la pantalla de confirmación, enlace `wa.me` para que los jugadores emparejados se escriban entre ellos.
- **Etapa posterior:** WhatsApp Cloud API con plantillas de utilidad aprobadas, solo a quienes marcaron `whatsapp_opt_in`. Requiere cuenta de Meta verificada y número dedicado; cada mensaje tiene costo.

Eventos: partido publicado, jugador se sumó, partido confirmado, cupo cancelado, encuentro eliminado por el administrador.

Las claves de proveedores van como secrets de Cloudflare, nunca en el repositorio.

## Interfaz

- Flujo público: deporte, lugar, calendario (solo días entre hoy y hoy + 15; si el rango cruza al mes siguiente, se puede avanzar a ese mes), horas del día, formulario, confirmación.
- El calendario marca los días con encuentros que buscan jugadores.
- El selector de nivel muestra el número y el texto de la categoría.
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

## Forma de trabajo

- Probar en local con `wrangler dev` antes de desplegar.
- Toda regla de negocio nueva lleva su prueba.
- No agregar dependencias, servicios pagos ni funciones fuera de este documento sin preguntar.
- Si una instrucción contradice este archivo, preguntar antes de avanzar.

## Decisiones pendientes

Marcar aquí la respuesta cuando se defina:

- ¿El pádel se completa siempre con 4 jugadores, o también se permite 2?
- ¿La cancha se retiene al abrir el partido (supuesto actual) o solo al confirmarse?
- ¿Se restringe unirse según diferencia de nivel?
- ¿Los clubes reservan canchas por otros canales? Si es así, definir cómo se bloquean esos horarios.
- ¿Cuánto tiempo antes puede cancelarse un cupo?
- Proveedor de correo y dominio definitivo.
- Duración del bloqueo tras 2 intentos fallidos de login (supuesto actual: 15 minutos).

Decididas (2026-11-12):

- Anticipación máxima: 15 días.
- `cancelado` es exclusivo del administrador; los encuentros cancelados se conservan.
- Login del administrador: máximo 2 intentos fallidos, registrados en `login_attempts`.
- `days`: 0 = domingo a 6 = sábado, texto separado por comas.
- Avisos antes de la etapa 5: `notify()` con un canal que solo registra.
- Cada cancha pertenece a un solo deporte.
- No se puede modificar una cancha si eso afecta encuentros futuros; el administrador siempre puede cancelar.
- Un turno sigue visible y aceptando jugadores hasta 15 minutos después de su inicio.
- La migración incluye el hash y la sal de la contraseña inicial `admin`; se acepta porque se obliga a cambiarla en el primer ingreso.
