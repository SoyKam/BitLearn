# BitLearn

**BitLearn** es una plataforma web de microaprendizaje de programación que busca reforzar el conocimiento mediante lecciones breves, tarjetas de estudio y repetición espaciada con el algoritmo **SuperMemo-2 (SM-2)**.

El proyecto contempla seguimiento del progreso, repasos personalizados y una estimación de la retención de conceptos a lo largo del tiempo.

## Tecnologías

- **Frontend:** Vue.js 3
- **Backend:** Node.js y Express
- **Base de datos:** PostgreSQL

**Estado del proyecto:** En desarrollo.

## Verificar PostgreSQL

Con las dependencias del backend instaladas, configura `DB_HOST`, `DB_PORT`,
`DB_NAME`, `DB_USER` y `DB_PASSWORD` en el entorno o en tu `backend/.env` privado,
tomando `backend/.env.example` como referencia. Usa los valores de conexión de tu
PC local o del túnel TCP desde Codespaces, según corresponda.

```bash
cd backend
npm run db:check
```

El comando reutiliza el pool y la validación TLS existentes (certificado
`backend/certs/bitlearn.crt` e identidad `bitlearn.internal`). Una sola consulta
de lectura identifica la base activa con `current_database()` y comprueba el
cifrado de la sesión en `pg_stat_ssl` mediante `pg_backend_pid()`, sin necesitar
permisos administrativos. Muestra la base de datos y el resultado TLS, cierra el
pool y termina con código `0` si la verificación es correcta o `1` ante errores.
No inicia Express ni ejecuta migraciones. No publiques tu `.env` ni credenciales.

## Migraciones y estructura de sesiones

Desde `backend/`, `npm run db:migrate` aplica las migraciones pendientes en orden,
una transacción por versión, y las registra en `schema_migrations`. Ejecútalo
solo después de verificar la base de destino; una segunda ejecución omite las
versiones ya aplicadas.

La migración `003_create_auth_sessions.sql` agrega dos tablas:

- `auth_sessions`: sesiones independientes vinculadas a `users.id`, con creación,
  expiración y revocación opcional.
- `auth_refresh_tokens`: hashes SHA-256 (64 caracteres hexadecimales minúsculos)
  únicos, vinculados a una sesión, con creación, expiración y uso opcional.
  Admite un solo token sin consumir por sesión y conserva los hashes consumidos.

Separar sesión e historial permite reconocer un hash utilizado anteriormente y
revocar su sesión completa sin afectar las otras sesiones del usuario. Los índices
permiten consultar sesiones por usuario e historial por sesión. Las claves foráneas
impiden borrar usuarios o sesiones con registros dependientes.

El registro y el login con creación inicial de sesiones están implementados.
El login entrega un Access Token JWT breve y un Refresh Token aleatorio en cookie
`HttpOnly`, `SameSite=Strict` y `Secure`; solo su hash se guarda en PostgreSQL.
Quedan pendientes renovación, rotación, logout y detección de reutilización.
La lógica futura deberá comprobar expiración y revocación, limitar la vigencia
de los nuevos tokens a la sesión y rotar en una
transacción con control de concurrencia, conservando el historial necesario.
No se almacenan Access Tokens ni Refresh Tokens originales en estas tablas;
la restricción de formato no sustituye el cálculo del hash en la aplicación.

Para probar las migraciones sin usar la base configurada:

```bash
cd backend
node --test tests/migrations.test.js
```

Las pruebas crean y eliminan su propio clúster PostgreSQL temporal mediante un
socket privado, sin cargar `.env`. Requieren `initdb` y `pg_ctl` (por defecto en
`/usr/lib/postgresql/16/bin`; ajustable con `POSTGRES_BIN`); si faltan, se omiten
explícitamente.

## Registro seguro — semana 2, commit 10

`POST /api/auth/register` recibe JSON con **solo** `name`, `email` y `password`.
Está documentado en `/api-docs`; `/api/users` continúa deshabilitado y excluido
de Swagger. El registro no inicia sesión, no devuelve tokens/cookies y no escribe
en `auth_sessions` ni `auth_refresh_tokens`.

| Campo | Validación del backend |
| --- | --- |
| `name` | Texto, espacios exteriores recortados, 1–100 caracteres, sin caracteres de control ASCII. |
| `email` | Texto, espacios exteriores recortados, minúsculas, formato de correo válido, máximo 150 caracteres. |
| `password` | Texto de al menos 12 caracteres y máximo 72 bytes UTF-8; rechaza solo espacios y caracteres nulos. No se recorta ni normaliza. |

Zod rechaza tipos incorrectos, campos adicionales y cuerpos que no sean objetos.
El parser acepta hasta 4 KiB y rechaza cuerpos comprimidos. La API devuelve:

| HTTP | Respuesta |
| --- | --- |
| `201` | `{ success: true, data: { id, name, email, created_at } }` |
| `400` | `{ success: false, message }` ante validación, JSON o cuerpo inválidos. |
| `409` | `{ success: false, message: "El correo ya está registrado." }` |
| `429` | Error controlado y encabezado `Retry-After`. |
| `500` | `{ success: false, message: "No se pudo completar la solicitud." }` |

El flujo es router → middlewares → controlador → servicio → repositorio →
PostgreSQL. El servicio recibe datos validados y normalizados; el repositorio
ejecuta un único `INSERT` parametrizado, sin consulta previa de existencia. La
restricción `users_email_key` decide la unicidad incluso ante solicitudes
simultáneas; el repositorio traduce específicamente PostgreSQL `23505` para esa
restricción. Otras violaciones o fallos conservan una respuesta genérica `500`.
Una sola inserción es atómica y no requiere una transacción manual adicional.
`UserModel.create` queda como adaptador al mismo servicio; las demás operaciones
heredadas se conservan sin publicar su router.

El servicio reutiliza bcryptjs con sal aleatoria por hash y costo **10**, el valor
de la base del profesor. Usa `bcrypt.hash` asíncrono y devuelve una lista explícita
de campos públicos. El costo conserva un esfuerzo acotado para desarrollo en
Linux/Codespaces, complementado por el límite de intentos; debe medirse bajo carga
antes de producción. La API asíncrona reparte el trabajo, pero sigue consumiendo
CPU de Node.js. El límite de bytes evita el truncamiento silencioso de
[bcryptjs](https://github.com/dcodeIO/bcrypt.js#security-considerations).

El limitador admite **10 intentos en 15 minutos** por IP (subred `/56` para IPv6),
incluidos intentos exitosos e inválidos. Se ejecuta antes del parser y del hash.
Usa memoria local: los contadores se pierden al reiniciar y no se comparten entre
instancias; no protege por sí solo frente a ataques distribuidos. Express mantiene
`trust proxy=false`, por lo que `X-Forwarded-For` y `Forwarded` enviados por el
cliente no permiten eludir el límite. Tras un proxy de Codespaces o de producción,
los usuarios pueden compartir la IP y cuota del proxy. Una futura configuración
debe identificar proxies confiables explícitamente; no activar confianza global.
Estas opciones siguen la [documentación de express-rate-limit](https://express-rate-limit.mintlify.app/reference/configuration).

Los errores inesperados se manejan en un middleware central. Cada intento obtiene
un `x-correlation-id` generado en el servidor; los logs de errores HTTP contienen
solo nivel, evento e identificador. Los errores del pool registran solo el evento,
sin el mensaje original de PostgreSQL. No se registran cuerpos, contraseñas,
hashes, consultas ni trazas.

**Compatibilidad y límites del esquema existente:** `UNIQUE(email)` distingue
mayúsculas y no recorta espacios. Los registros nuevos se normalizan, pero una
cuenta heredada como `Juan@Example.com` o con espacios puede coexistir con
`juan@example.com`. No se modifican registros ni esquema automáticamente; auditar
y resolver esos casos requiere un trabajo separado. La migración 001 también
puede adoptar un índice único con otro nombre: si ese fuera el esquema heredado,
su violación devuelve `500` seguro hasta adaptar explícitamente la identificación
de esa restricción. `created_at` conserva el `TIMESTAMP` sin zona de la base;
PostgreSQL y Node deben usar una zona coherente, preferiblemente UTC.

### Comprobaciones aisladas

Desde `backend/`:

```bash
npm test
```

Las pruebas unitarias/HTTP sustituyen el acceso a PostgreSQL antes de hacer
peticiones. Las de integración de registro crean un clúster PostgreSQL 16 propio,
sin cargar `.env` ni `db.js`, accesible solo por un socket privado, y lo eliminan
al finalizar. Usan el esquema de 001 y 003 únicamente dentro de ese clúster.
Las pruebas existentes de migraciones también usan su propio clúster temporal.
Nunca insertan usuarios en la base real `bitlearn`. Si faltan `initdb`/`pg_ctl`,
las pruebas de PostgreSQL se omiten explícitamente; puede ajustarse `POSTGRES_BIN`.

Se cubren registro, hash verificable y sales distintas, campos públicos,
normalización, validaciones, límites UTF-8, SQL parametrizado, duplicados y
concurrencia reales, errores seguros, rate limiting con encabezados de proxy
falsificados, Swagger, health y bloqueo del CRUD heredado. Quedan pendientes las
pruebas de carga y del despliegue real con TLS/proxy; no se altera su configuración.

Al instalar las dos dependencias necesarias y ejecutar `npm audit --json`, la
auditoría informó **10 vulnerabilidades** en dependencias preexistentes (1 baja,
1 moderada, 7 altas y 1 crítica), ninguna atribuida a Zod o express-rate-limit.
Incluye `proxy-addr`, `path-to-regexp`, `body-parser`, `qs` y herramientas de
Swagger/desarrollo. Su actualización y validación se dejan como tarea separada;
este commit no aplica `npm audit fix` ni cambios masivos de versiones.

### Requisitos atendidos parcialmente

| Requisito | Evidencia de este commit y alcance pendiente |
| --- | --- |
| RF-01 | Registro backend; pendientes interfaz, login, logout y perfil. |
| RNF-03 | Separación de capas e inyección del repositorio en registro, manejo central de errores; otros módulos conservan su base. |
| RNF-04 | Hash bcrypt; pendientes doble token, cookies, rotación, revocación y sesiones activas. |
| RNF-05 | Esquema estricto, SQL parametrizado y limitador; pendientes RBAC/ABAC, ownership y protección integral del frontend. |
| RNF-06 | UNIQUE y escritura atómica con prueba concurrente; no añade operaciones relacionadas ni cambia migraciones. |
| RNF-07 | Logs seguros de errores y correlación en registro; pendientes observabilidad general y cola cuando haya un caso de uso. |
| RNF-08 | OpenAPI y pruebas críticas del registro; pendientes autenticación completa, SM-2 y otros contratos. |
| RNF-09 | Conserva configuración TLS y secretos privados; verifica PostgreSQL temporal, no el despliegue real. |

## Inicio de sesión seguro — semana 2, commit 11

`POST /api/auth/login` recibe exclusivamente `{ email, password }`. Comparte la
normalización de correo del registro. Zod exige contraseña textual no vacía de
hasta 72 bytes UTF-8 y sin nulos; no la recorta ni normaliza. No exige el mínimo
de 12 caracteres del alta para permitir verificar cuentas heredadas. El parser
admite hasta 4 KiB y rechaza JSON inválido y cuerpos comprimidos.

El servicio busca el correo con SQL parametrizado y llama a `bcrypt.compare`.
Si el usuario no existe, compara contra un hash auxiliar aleatorio de costo 10,
generado una vez por proceso; ambos caminos esperan su preparación. Esto reduce
la diferencia de tiempo asociada a omitir bcrypt, sin prometer tiempos idénticos
de red/base de datos ni igualar costos de posibles hashes heredados. Ambos errores
devuelven `401` con `{ success: false, message: "Credenciales incorrectas." }`.

Después de verificar credenciales, genera 32 bytes aleatorios con
`crypto.randomBytes`, los codifica como token opaco base64url y calcula SHA-256.
El repositorio crea `auth_sessions` y `auth_refresh_tokens` en una transacción
con el mismo cliente `pg`. Ambas filas comparten creación y expiración a 7 días;
el token original nunca llega al repositorio. `used_at` y `revoked_at` quedan
nulos, preparados para el trabajo del commit 12. Ante errores se ejecuta rollback
y siempre se libera el cliente; se descarta si el rollback también falla.

Solo después de `COMMIT` se firma el Access Token mediante
[jsonwebtoken](https://github.com/auth0/node-jsonwebtoken) con algoritmo explícito
HS256 y duración de **900 segundos**. Contiene únicamente `sub` (usuario), `sid`
(sesión), `iat`, `exp`, `iss` y `aud`. La respuesta `200` es
`{ success: true, data: { user: { id, name, email }, accessToken, expiresIn: 900 } }`.
El cliente futuro deberá mantenerlo exclusivamente en memoria. Las respuestas
de login incluyen `Cache-Control: no-store`. Validación devuelve `400`, exceso
de intentos `429` y errores internos `500` sin detalles sensibles.

### Configuración privada antes de arrancar

Define estas variables en el entorno o en tu `.env` privado (no versionado):

| Variable | Valor / regla |
| --- | --- |
| `AUTH_JWT_SECRET_HEX` | 32 bytes generados con CSPRNG, codificados como 64 caracteres hexadecimales. No usar frases, ejemplos ni claves compartidas entre entornos. |
| `AUTH_JWT_ISSUER` | Identificador del emisor, por ejemplo `bitlearn-api`. |
| `AUTH_JWT_AUDIENCE` | Identificador del consumidor, por ejemplo `bitlearn-web`. |
| `AUTH_ALLOW_INSECURE_COOKIE` | `false` por defecto. Solo `true` en HTTP local con `NODE_ENV=development`, fuera de Codespaces. |
| `NODE_ENV` | `development` local; `production` en producción. |

La aplicación falla antes de escuchar HTTP si falta configuración o se solicita
una cookie insegura fuera de desarrollo local. La clave se decodifica a 32 bytes;
se valida longitud/formato y se rechazan valores con menos de 16 bytes distintos.
Esta comprobación detecta valores obviamente débiles, pero **no demuestra
entropía**: su origen debe ser un generador criptográfico seguro.

Para crear una clave de desarrollo sin imprimirla ni guardarla en el repositorio,
desde una terminal Bash privada puedes cargarla directamente en el entorno:

```bash
export AUTH_JWT_SECRET_HEX="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"
export AUTH_JWT_ISSUER=bitlearn-api
export AUTH_JWT_AUDIENCE=bitlearn-web
```

No ejecutes ese comando con trazado de shell (`set -x`) ni vuelques el entorno
a logs. Para conservar la clave, usa tu gestor de secretos o configura el `.env`
privado de manera segura; el comando anterior solo dura esa terminal. En
producción, provisiona la clave mediante el gestor de secretos del despliegue.
Cambiarla invalida las firmas anteriores. Este trabajo no modifica tu `.env`.

### Cookie y proxy de Vite/Codespaces

La cookie `bitlearn_refresh` usa `HttpOnly`, `SameSite=Strict`, `Path=/api/auth`,
sin `Domain`. Su `Max-Age` descuenta el tiempo de la transacción, redondeando
hacia abajo para no superar la expiración de PostgreSQL (máximo 604800 segundos).
`Secure` está activado por defecto, independientemente de encabezados del cliente.
Si Express recibe HTTPS directo, se conserva `Secure` incluso bajo la excepción
de desarrollo. Producción debe ofrecer HTTPS al navegador.

En Codespaces, abre la URL **HTTPS de Vite** y usa rutas relativas `/api/auth/login`.
El proxy existente de Vite reenvía `/api` a `http://127.0.0.1:3000`, conserva
`Set-Cookie` y el navegador recibe la cookie bajo el mismo origen HTTPS. Usa
`AUTH_ALLOW_INSECURE_COOKIE=false`; no es necesario confiar en
`X-Forwarded-Proto`. Para HTTP local únicamente, configura
`NODE_ENV=development` y `AUTH_ALLOW_INSECURE_COOKIE=true`, con los puertos
limitados a tu entorno local. Vuelve a `false` antes de usar cualquier proxy HTTPS.
No se agrega CORS ni se modifica el frontend.

Express conserva `trust proxy=false`, siguiendo las precauciones de la
[documentación de Express](https://expressjs.com/en/guide/behind-proxies/).
El limitador reutilizado admite **20 intentos por IP en 15 minutos** (IPv6 /56),
incluidos éxitos e inválidos, antes de parser/bcrypt. Tiene contador independiente
del registro. Encabezados de IP falsificados no cambian la cuota. Tras Vite o
Codespaces varios usuarios pueden compartir la IP y cuota del proxy: es una
limitación explícita de este desarrollo, no protección distribuida. Antes de un
despliegue multiusuario hay que identificar los proxies concretos que sanitizan
encabezados y diseñar límites compartidos entre instancias; no activar confianza
global ni por un número arbitrario de saltos. Los contadores actuales son locales
al proceso y se reinician con él.

### Verificación y alcance

Ejecuta `npm test` desde `backend/`. Las pruebas de login cubren credenciales,
normalización sin alterar la clave, entradas estrictas, JWT firmado, rechazo por
expiración/emisor/audiencia/algoritmo/clave incorrectos, cookie segura y excepción
local, cuota con proxy falsificado, ausencia de emisión antes de `COMMIT`, errores
de conexión/insert/commit/rollback y logs seguros. La integración crea y elimina
otro clúster PostgreSQL temporal por socket privado; verifica hashes, fechas,
sesiones independientes y rollback real de ambas inserciones. No conecta a la
base configurada. Si faltan `initdb`/`pg_ctl`, se omite explícitamente; ajusta
`POSTGRES_BIN` si están en otra ubicación. También se conservan las pruebas de
registro, migraciones, health y bloqueo del CRUD heredado.

Verificación del commit 11: `node --test tests/*.test.js` (el comando de `npm test`)
terminó con **155 pruebas aprobadas, 0 fallos y 0 omisiones**, incluidos los
clústeres temporales. El sandbox bloqueó inicialmente `initdb` con `EPERM`; la
ejecución autorizada fuera del sandbox pasó. `git diff --check` no encontró
errores. `npm audit --json` mantiene 10 vulnerabilidades (1 baja, 1 moderada,
7 altas y 1 crítica) en dependencias preexistentes; no reporta `jsonwebtoken`.
No se aplicaron actualizaciones masivas ni `npm audit fix`.

Las pruebas de `Secure` verifican configuración, encabezados HTTP y `req.secure`
simulado; queda pendiente la comprobación con navegador real sobre HTTPS de
Codespaces/producción, así como carga y mediciones de tiempo. No se ejecutan
migraciones en la instancia real. No se implementan refresh, rotación, logout,
revocación operativa, guards ni autorización de endpoints en este commit.

Se atiende **RF-01** (login backend) y parcialmente **RNF-03** (capas y errores),
**RNF-04** (emisión de doble token y sesiones iniciales), **RNF-05** (validación,
SQL parametrizado y límites), **RNF-06** (transacción ACID), **RNF-07** (correlación
y logs seguros), **RNF-08** (Swagger y pruebas) y **RNF-09** (configuración para
local/Codespaces sin alterar TLS de PostgreSQL). No se declara completo el Core:
rotación, revocación, autorización, interfaz y restantes funciones siguen pendientes.
