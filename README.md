# BitLearn

**BitLearn** es una plataforma web de microaprendizaje de programación que busca reforzar el conocimiento mediante lecciones breves, tarjetas de estudio y repetición espaciada con el algoritmo **SuperMemo-2 (SM-2)**.

El proyecto contempla seguimiento del progreso, repasos personalizados y una estimación de la retención de conceptos a lo largo del tiempo.

## Tecnologías

- **Frontend:** Vue.js 3
- **Backend:** Node.js y Express
- **Base de datos:** PostgreSQL

**Estado del proyecto:** En desarrollo.

El motor de dominio SM-2 del commit #23 está implementado y se prueba sin base
de datos con `cd backend && node --test tests/sm2.test.js`. Su contrato, fórmula,
precisión y variante están en [Algoritmo SM-2](docs/algoritmo-sm2.md).
El commit #25 integra el motor con el registro autenticado y transaccional de repasos.

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

Para probar las migraciones sin usar la base configurada:

```bash
cd backend
node --test tests/migrations.test.js
```

Las pruebas crean y eliminan su propio clúster PostgreSQL temporal mediante un
socket privado, sin cargar `.env`. Requieren `initdb` y `pg_ctl` (por defecto en
`/usr/lib/postgresql/16/bin`; ajustable con `POSTGRES_BIN`); si faltan, se omiten
explícitamente.

## Detalle público de cursos

`GET /api/courses` lista el catálogo. `GET /api/courses/:slug` consulta un curso
con sus unidades y lecciones, sin requerir login:

```bash
curl http://localhost:3000/api/courses/html
curl http://localhost:3000/api/courses/css
curl http://localhost:3000/api/courses/javascript
```

El detalle devuelve `{ success: true, data: { id, title, slug, description, units } }`.
Cada unidad contiene `id`, `title`, `position` y `lessons`; cada lección solo
`id`, `title` y `position`, sin `content`. Unidades y lecciones se ordenan por
`position` ascendente dentro de su padre; las colecciones sin registros son `[]`.

El slug debe tener entre 1 y 150 caracteres, solo minúsculas, números y guiones
interiores simples. Un slug inválido devuelve **400**; uno válido sin curso
asociado devuelve **404** (`Curso no encontrado.`). Los fallos internos devuelven
**500**, y la indisponibilidad identificable de PostgreSQL, **503**, sin detalles
privados. El contenido depende de los registros existentes en PostgreSQL: estas
consultas no modifican datos ni cargan seeds automáticamente.

Swagger documenta ambos endpoints en `/api-docs`. Para verificar el catálogo
con dobles y PostgreSQL temporal, sin usar la base principal:

```bash
cd backend
node --test tests/course.test.js tests/course.integration.test.js
npm test
```

La matriz de cobertura, resultados automatizados, corrección mínima y pendientes
manuales del commit 19 están en el [informe de cierre de semana 3](docs/verificacion-semana-3.md).

## Persistencia de aprendizaje (migración 004)

`004_create_learning_progress.sql` prepara RF-03 a RF-10; no implementa SM-2,
retención, endpoints ni carga preguntas o tarjetas. Agrega:

- `questions`: preguntas por lección, opciones JSONB (arreglo de 2–6), índice
  correcto desde cero y explicación opcional.
- `user_lesson_progress`: intentos, aciertos y finalización por usuario/lección.
- `flashcards`: frente y reverso compartidos, ordenados dentro de cada lección.
- `user_card_progress`: estado independiente por usuario/tarjeta; repeticiones e
  intervalo iniciales en cero, factor inicial 2.5000, último repaso nulo y próximo
  repaso inicialmente en la fecha de creación.
- `card_reviews`: calificación 0–5, factores e intervalos antes/después, fecha del
  repaso y próxima fecha resultante; FK compuesta al estado usuario/tarjeta.

Las PK compuestas impiden duplicar progreso. Las posiciones son positivas y únicas
por lección; los textos obligatorios no admiten solo espacios. CHECK limita
contadores, aciertos, factores (mínimo 1.3000, sin NaN) y fechas finitas TIMESTAMPTZ.
Todas las FK usan ON DELETE RESTRICT, evitando borrar padres con dependencias.
Los índices `(user_id, next_review_at)` y `(user_id, reviewed_at DESC)` preparan
pendientes e historial. `UNIQUE(user_id, request_id)` con UUID obligatorio evita
repetir una operación, incluso entre tarjetas del mismo usuario; el servicio futuro
seguirá siendo responsable de devolver la respuesta coherente de una repetición.

Convención futura: aplicar el mínimo 1.3 y redondear el factor a cuatro decimales,
al más cercano y con empates alejándose de cero (para factores positivos, hacia
arriba), antes de persistir y reutilizarlo. NUMERIC(8,4) tiene máximo 9999.9999:
el servicio deberá validar resultados representables, sin truncarlos silenciosamente.
`pg` devuelve estos decimales como cadenas. El servicio actualizará estado e
historial en una transacción con bloqueo de fila y actualizará `updated_at`
explícitamente; no hay triggers ni cálculo algorítmico SQL.

El backend de lecciones valida las alternativas mediante Zod, obtiene el usuario
del JWT y comprueba la sesión activa. Las claves separan registros; no sustituyen
la autorización descrita a continuación.

Pruebas sin acceder a la base principal (requieren PostgreSQL local):

```bash
cd backend
node --test tests/learning-migrations.integration.test.js
npm test
```

Usan el helper de PostgreSQL temporal y no cargan la conexión real. Cubren rollback,
repetición, concurrencia e integridad; la suite completa incluye autenticación y
catálogo. **`npm run db:migrate` modifica el esquema de la base configurada**:
no ejecutarlo sobre `bitlearn` sin autorización explícita.


## Lecciones, preguntas y progreso (commit #21)

- `GET /api/lessons/:id` es público: devuelve contenido, curso, unidad y preguntas
  ordenadas por posición. No revela el índice correcto ni `explanation`. Sin
  preguntas devuelve `questions: []`; lección ausente devuelve 404.
- `POST /api/lessons/:id/answer` requiere Bearer JWT y sesión activa. Recibe solo
  `{ "questionId": 1, "optionIndex": 0 }` (IDs ilustrativos). Zod rechaza tipos
  incorrectos y campos adicionales; el parser admite hasta 4 KiB. El servidor
  comprueba pertenencia y rango real de la opción, compara la solución y devuelve
  `correct`, `completed`, `explanation` (puede ser null) y `progress`.
- `GET /api/progress` requiere la misma autenticación y devuelve `completedLessons`,
  `totalLessons` calculado desde PostgreSQL y `lessons` con el progreso registrado.
  Ordena por slug del curso, posición de unidad, posición e ID de lección.

La identidad procede exclusivamente de `req.auth.userId`; no se permite elegir
un usuario mediante el cuerpo de respuesta. Los IDs de URL deben ser enteros
positivos decimales sin signo, espacios ni exponentes, hasta 2147483647. Las
consultas SQL usan parámetros. Las respuestas privadas, incluidos errores, llevan
`Cache-Control: no-store`; las tres rutas incluyen `x-correlation-id`. Las respuestas
se limitan a 60 solicitudes por IP cada 15 minutos, en memoria por proceso (subred
/56 IPv6; tras un proxy no confiable se comparte la cuota). Los contratos y errores
400/401/404/429/500/503 aplicables se documentan en `/api-docs`.

Cada respuesta válida confirmada suma un intento, y cada acierto suma una respuesta
correcta. Un `INSERT ... ON CONFLICT DO UPDATE` incrementa sobre el valor existente
en PostgreSQL, de forma atómica incluso con solicitudes concurrentes. El primer
acierto completa la lección; `COALESCE` conserva esa primera fecha para siempre.
Esta regla del MVP corresponde a **una pregunta inicial por lección**: los
contadores agregados no comprueban dominio de todas las preguntas posibles.

**Las solicitudes repetidas cuentan como intentos independientes.** No hay clave
de idempotencia para respuestas: el frontend deberá bloquear envíos duplicados
accidentales y evitar reintentar este POST automáticamente. No se implementa SM-2.

### Carga manual de las nueve preguntas

Con las migraciones 001–004 y el catálogo ya disponibles, el operador puede
verificar la base de destino y ejecutar desde `backend/`:

```bash
npm run db:seed:questions
```

Este comando **escribe en la base configurada** mediante el pool y TLS existentes;
no se ejecuta al iniciar Express. Durante el desarrollo del commit solo se probó
contra PostgreSQL temporal, sin ejecutar este comando sobre la base principal.

`002_web_questions.json` contiene una pregunta por lección. El seed busca curso por
slug y verifica título/posición de unidad y lección; no supone IDs fijos ni crea
el catálogo. Una transacción con bloqueos comprueba e inserta el conjunto completo.
Repetirlo conserva preguntas idénticas; ante contenido o posición en conflicto,
revierte toda la carga sin sobrescribir registros. También valida opciones de 2–6
textos no vacíos e índice correcto desde cero.

Pruebas específicas con mocks y PostgreSQL temporal aislado, sin cargar `.env`:

```bash
cd backend
node --test tests/learning.test.js tests/learning.integration.test.js
npm test
```

Cubren validación, JWT y sesiones revocadas, aislamiento, concurrencia con bloqueo
real, errores seguros, límite de solicitudes, seed idempotente y rollback. Si falta
PostgreSQL local, las pruebas de integración se señalan como omitidas.

### Flashcards educativas (commit #24)

Las flashcards son preguntas breves con su respuesta para practicar recuperación
de memoria. El seed `backend/database/seeds/003_web_flashcards.json` incorpora
15 tarjetas: cinco de HTML, cinco de CSS y cinco de JavaScript, repartidas 2–2–1
entre las tres lecciones de cada curso. Se vinculan por slug, posición y título
de unidad y lección, sin IDs fijos.

Con las migraciones 001–004 y el catálogo ya cargados, la carga es manual:

```bash
cd backend
npm run db:seed:flashcards
```

**Este comando modifica la base PostgreSQL configurada.** No se ejecuta al iniciar
Express. Valida el contenido con Zod antes de conectar, usa una transacción y
bloqueos con espera máxima de 10 segundos. Conserva tarjetas idénticas; ante una
posición con contenido distinto, un frente desplazado o una lección incompatible,
revierte toda la carga sin sobrescribir ni eliminar contenido ajeno. Informa los
conteos únicamente después de COMMIT y permite repetir la carga sin duplicados.

`GET /api/flashcards?course=html` (también `css` o `javascript`) es público y devuelve
`{ success: true, data: [...] }` con `id`, `lessonId`, `lessonTitle`, `position`,
`front` y `back`, ordenados por unidad, lección y posición. `course` es obligatorio,
único y debe ser un slug de 1–150 caracteres en minúsculas, números y guiones
interiores; no se admiten otros parámetros. Devuelve 400 ante entradas inválidas,
404 si no existe el curso y 200 con arreglo vacío si existe sin tarjetas.
Swagger documenta el contrato y los errores 500/503 sin detalles internos.

Este avance implementa el contenido y la consulta de RF-05; la interfaz de estudio
queda pendiente. No crea progreso individual ni historial. El commit #25 integrará
el motor SM-2 con el registro autenticado y transaccional de repasos; RF-07, RF-08
y RF-10 no se implementan aquí. Se mantienen intactos el motor y el frontend.

Pruebas desde `backend/`: `node --test tests/flashcards.test.js tests/flashcards.integration.test.js`
y `npm test`. La integración usa exclusivamente PostgreSQL temporal por socket
privado; se omite explícitamente si no están disponibles sus binarios.


## Registro transaccional de repasos (commit #25)

`POST /api/reviews` requiere `Authorization: Bearer <accessToken>` y sesión activa.
Recibe exclusivamente este JSON (IDs ilustrativos):

```json
{
  "flashcardId": 5,
  "quality": 4,
  "requestId": "123e4567-e89b-42d3-a456-426614174000"
}
```

Zod exige un ID entero positivo hasta 2147483647, calidad entera 0–5 y UUID v4.
Las calificaciones significan: 0 nada, 1 muy poco, 2 insuficiente, 3 con dificultad,
4 correcto y 5 fácil. No admite cadenas numéricas ni propiedades adicionales;
`userId`, fechas y valores SM-2 proceden del servidor. El JSON está limitado a 4 KiB.

La primera operación activa una tarjeta únicamente si el estudiante completó su
lección (`completed_at`). Usa `createInitialSm2State()` y crea estado solo para esa
pareja usuario/tarjeta. Una vez activada, conserva su estado individual y admite
nuevas operaciones únicamente cuando `next_review_at <= reviewedAt`. Los reenvíos
idempotentes se resuelven antes de comprobar el vencimiento. No se modifica la
lección ni el contenido compartido.

El repositorio lee el estado bajo bloqueo y valida y convierte NUMERIC a número sin
redondear datos corruptos. El servicio invoca `calculateSm2` sin cambiar su fórmula:
actualiza repeticiones, factor e intervalo y calcula la próxima fecha. Un único
instante de PostgreSQL, obtenido después de los bloqueos, sirve para comprobar
vencimiento, calcular y registrar el repaso. Las fechas HTTP son ISO 8601 UTC;
el reloj es inyectable en pruebas, nunca mediante el JSON de producción.

Un solo cliente ejecuta `BEGIN ISOLATION LEVEL READ COMMITTED`, toma
`pg_advisory_xact_lock(user_id, flashcard_id)` y lee la fila con `FOR UPDATE`.
El advisory protege también el primer estado, cuando no existe ninguna fila que
bloquear. Las consultas posteriores a la espera obtienen una nueva instantánea;
tarjetas diferentes no comparten este bloqueo. Estado e historial (calidad,
factores e intervalos antes/después y fechas) se escriben juntos y la respuesta
solo se devuelve después de `COMMIT`. Ante fallos se ejecuta `ROLLBACK`; si falla
o el resultado de COMMIT queda incierto, se descarta la conexión.

`UNIQUE(user_id, request_id)` garantiza la idempotencia incluso en carreras entre
tarjetas distintas. Un reenvío idéntico recupera los valores del historial original
con `replayed: true`, sin ejecutar SM-2 ni modificar estado. Otra calidad o tarjeta
con la misma clave devuelve 409. Ante esa restricción concreta se revierte la
transacción perdedora y se consulta la operación confirmada desde un cliente nuevo.
Otros errores de unicidad no se ocultan. Si se pierde la respuesta de COMMIT, el
cliente puede recuperar el resultado reenviando exactamente el mismo `requestId`.

La respuesta es `{ success: true, data: { reviewId, flashcardId, quality, easeFactor,
intervalDays, reviewedAt, nextReviewAt, replayed } }`. `reviewId` es cadena BIGSERIAL.
No incluye `repetitions`: se persiste, pero el historial no permite reconstruir ese
contador para una operación antigua. Todas las respuestas de esta ruta incluyen
`Cache-Control: no-store` y `x-correlation-id`, sin SQL, tokens ni detalles privados.

| HTTP | Significado |
| --- | --- |
| 200 | Repaso confirmado o resultado histórico reproducido |
| 400 | Entrada inválida, JSON malformado o mayor de 4 KiB |
| 401 | JWT ausente, inválido, expirado o sesión revocada/inactiva |
| 403 | Lección no completada antes de activar la tarjeta |
| 404 | Flashcard inexistente |
| 409 | Clave reutilizada con otros datos o tarjeta aún no pendiente |
| 429 | Límite de solicitudes alcanzado |
| 500 | Error interno, integridad o estado SM-2 inválido, sin detalles técnicos |
| 503 | Indisponibilidad identificable de PostgreSQL |

El límite es de 60 intentos por IP cada 15 minutos (IPv6 /56), en memoria por
proceso: se reinicia con el proceso y no se comparte entre réplicas. Se conserva
`trust proxy=false`; detrás de un proxy no confiable los clientes comparten cuota.
El contrato completo está en Swagger `/api-docs`.

Verificación desde `backend/`:

```bash
node --test tests/reviews.test.js
node --test tests/reviews.integration.test.js
npm test
```

Las integraciones usan exclusivamente clústeres PostgreSQL temporales por socket
privado, migraciones 001–004 y seeds aislados; nunca cargan la conexión real ni
`.env`. Si faltan los binarios locales, se indican explícitamente como omitidas.

Este avance integra RF-06 y aporta programación a RF-07 y almacenamiento a RF-08,
además de autorización/validación (RNF-05), transacciones/concurrencia (RNF-06),
separación de capas (RNF-03) y contrato/pruebas (RNF-08). No completa todos esos
requisitos. El historial ya se almacena, pero todavía no tiene endpoint público.
Para el commit #26 quedan las consultas de pendientes e historial, con la misma
política de activación y vencimiento. No se implementan vistas Vue de calificación,
retención estimada ni dashboard.

## Consultas personales de repasos (commit #26)

- `GET /api/reviews/due?limit=50`: devuelve `{ success: true, data: [...] }`.
  Incluye tarjetas **new** de lecciones con `completed_at` y sin estado del usuario:
  repeticiones 0, factor 2.5, intervalo 0 y fechas null, sin crear filas.
  Incluye tarjetas **due** con estado y `next_review_at <= statement_timestamp()`
  de PostgreSQL, aunque ya no exista finalización de la lección. Devuelve su estado
  real, frente, reverso, lección y curso. Ordena vencidas por fecha más antigua,
  después nuevas; desempata por slug de curso, posición de unidad, lección,
  tarjeta e identificador. `limit` predeterminado 50, rango 1–100, aplicado en SQL.
- `GET /api/reviews/history?limit=20&offset=0`: devuelve
  `{ success: true, data: { items: [...], total, limit, offset } }`.
  Consulta resultados confirmados en `card_reviews`, por `reviewed_at DESC, id DESC`,
  con calidad, factores e intervalos anteriores/posteriores y fechas persistidas.
  `reviewId` es cadena para conservar BIGSERIAL; factores NUMERIC validados y
  normalizados a número, fechas ISO 8601 UTC. `limit` predeterminado 20 (1–100);
  `offset` predeterminado 0 (0–10000). Total y página comparten una sentencia y su
  instantánea; el total se conserva incluso si offset supera la cantidad de filas.
  Nuevos repasos pueden desplazar páginas entre solicitudes: no es una instantánea
  histórica inmutable.

Ambas rutas exigen Bearer JWT y sesión activa; filtran exclusivamente por
`req.auth.userId` mediante parámetros SQL. Zod admite solo enteros decimales sin
signos, espacios, fracciones ni exponentes. Rechaza valores fuera de rango,
parámetros repetidos/desconocidos y `userId` con 400. Colecciones vacías son 200:
`data: []` o `data: { items: [], total: 0, limit: 20, offset: 0 }`.
JWT/sesión inválidos producen 401; errores internos 500 e indisponibilidad
identificable de PostgreSQL 503, sin SQL ni secretos. Todas las respuestas conservan
`Cache-Control: no-store` y `x-correlation-id`. Swagger detalla los campos en `/api-docs`.

Los GET solo ejecutan SELECT, sin crear progreso, cambiar fechas ni ejecutar SM-2.
El POST existente conserva transacciones, bloqueos e idempotencia: tras confirmar
un repaso con fecha futura, la tarjeta desaparece de pendientes y el historial
incorpora el resultado sin alterar repasos anteriores. No hay cambios de frontend,
retención ni dashboard. Se atienden RF-07/RF-08 y RNF-05/RNF-06, reutilizando RF-06.
La interfaz que consuma este flujo queda pendiente de definir para el commit #27.

Pruebas aisladas desde `backend/`:

```bash
node --test tests/reviews-query.test.js tests/reviews-query.integration.test.js
npm test
```

La integración utiliza exclusivamente PostgreSQL temporal, incluyendo verificaciones
con transacciones de solo lectura y comparación de datos antes/después de los GET.

## Estadísticas personales (commit #28)

`GET /api/dashboard` requiere Bearer JWT válido y sesión activa. Devuelve
`{ success: true, data: { summary, courses } }` con datos reales de PostgreSQL.
No admite query (incluidos `userId`, filtros, límites y parámetros repetidos)
ni cuerpo. La identidad procede exclusivamente de `req.auth.userId`; encabezados
alternativos no permiten seleccionar otro usuario. Las respuestas privadas llevan
`Cache-Control: no-store` y `x-correlation-id`.

`summary` contiene:

- `totalLessons`: todas las lecciones actuales del catálogo.
- `completedLessons`: filas del usuario con `completed_at IS NOT NULL`; los
  intentos y aciertos repetidos no multiplican lecciones.
- `completionPercent`: completadas / total × 100, redondeado a dos decimales,
  entre 0 y 100; cero cuando no existen lecciones.
- `studiedFlashcards`: parejas usuario-tarjeta existentes en `user_card_progress`,
  contadas una sola vez aunque tengan varios repasos.
- `dueReviews`: total sin límite de tarjetas nuevas de lecciones completadas
  sin estado SM-2, más tarjetas con estado vencido. Comparte la condición SQL
  con `/api/reviews/due` y usa `statement_timestamp()` de PostgreSQL. Un estado
  ya activado y vencido sigue siendo elegible aunque se retire la finalización
  de su lección, igual que en el endpoint existente.
- `totalReviews`: registros confirmados del usuario en `card_reviews`; reproducir
  una solicitud idempotente no añade registros.

`courses` contiene `courseId`, `courseSlug`, `courseTitle`, `totalLessons`,
`completedLessons` y `completionPercent` para cada curso existente, ordenados por
slug e ID. Cada porcentaje usa únicamente las lecciones de ese curso. Conserva
cursos sin progreso y sin lecciones. Un usuario nuevo recibe ceros personales y
el catálogo real; un catálogo vacío devuelve `courses: []` y contadores cero.

Una sentencia SELECT con CTE obtiene una única instantánea. Agregaciones separadas
para progreso, estados e historial evitan multiplicaciones por joins uno-a-muchos.
No hay N+1, descarga de historiales ni límites artificiales en los conteos. Los
contadores BIGINT se normalizan a enteros seguros de JavaScript: datos negativos,
fraccionarios o fuera de rango se rechazan, sin truncarlos ni inventar valores.

Swagger (`/api-docs`) incluye esquemas, ejemplo ilustrativo y respuestas 200,
400 (solicitud inválida), 401 (sesión inválida), 500 (error interno) y 503
(PostgreSQL no disponible), sin detalles sensibles. El GET solo lee: no activa
flashcards, no crea estados, no altera fechas/historial y no ejecuta SM-2.

Pruebas desde `backend/`:

```bash
node --test tests/dashboard.test.js
node --test tests/dashboard.integration.test.js
npm test
```

Las integraciones usan exclusivamente PostgreSQL temporal aislado, migraciones
001–004 y seeds existentes. Comprueban el flujo HTTP real, usuarios independientes,
reenvíos idempotentes, más de 100 pendientes, catálogo vacío y cursos vacíos.
Los GET se ejecutan en modo PostgreSQL de solo lectura y se compara el contenido
de las tablas antes/después. Si faltan binarios PostgreSQL, se omiten explícitamente.
No es necesario ejecutar migraciones ni seeds sobre la base principal para este cambio.

Este avance aporta el backend de RF-09 y reutiliza RF-04, RF-05, RF-07 y RF-08.
**RF-09 todavía no está integrado visualmente en Vue.** El commit #29 queda dedicado
a RF-10, la proyección estimada de retención, que este endpoint no calcula.

## Dashboard y retención estimada (commit #29)

Con una sesión activa, abre `/dashboard`, también enlazado desde perfil, progreso
y repasos. Muestra estadísticas reales de `GET /api/dashboard` y una curva con
tabla accesible de `GET /api/dashboard/retention`. El botón Actualizar consulta
nuevamente ambos endpoints. Sin repasos registrados no se inventa una estimación.

El [modelo de retención estimada](docs/retencion-estimada.md) utiliza los intervalos
SM-2 persistidos, sin modificarlos. Es una proyección matemática sin nuevos repasos,
no una medición real ni calibrada individualmente. RF-09 queda integrado en Vue
y RF-10 agrega la estimación explícita. Para la siguiente etapa queda la auditoría
de integración y requisitos transversales del Core prevista para la semana 8;
este cambio no define funcionalidades adicionales para el commit #30.

Pruebas nuevas: `backend/tests/retention*.test.js` (dominio sin DB e integración
con PostgreSQL temporal) y `frontend/tests/dashboard*.test.js` (contratos, sesión,
estado y navegador con mocks). No requieren migraciones ni seeds en la base real.
