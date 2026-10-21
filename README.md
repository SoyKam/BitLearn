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

El registro está implementado; la autenticación de sesiones **todavía no está implementada**. Quedan pendientes login,
Access Tokens JWT breves en memoria, Refresh Tokens aleatorios de alta entropía en
cookies `HttpOnly`, `SameSite=Strict` y `Secure`, logout y detección de reutilización.
La lógica futura deberá calcular los hashes, comprobar la expiración de ambos y
la revocación de la sesión, limitar la vigencia del token a la sesión y rotar en una
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
