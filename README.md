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
