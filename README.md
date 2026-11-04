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
La integración con servicios de repasos y persistencia queda pendiente.

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
