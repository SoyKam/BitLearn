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

El commit #21 deberá validar cada alternativa mediante Zod, obtener el usuario
del JWT validado, comprobar propiedad y ocultar la respuesta correcta hasta que
el estudiante responda. Las claves separan registros; no sustituyen autorización.

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
