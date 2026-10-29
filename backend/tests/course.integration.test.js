const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Pool } = require('pg');
const { temporaryPostgres, postgresSkip } = require('./helpers/temporary-postgres');
const serve = require('./helpers/course-app');
const runMigrations = require('../src/config/migrate');
const { seedCatalog } = require('../src/config/seed-catalog');
const catalog = require('../database/seeds/001_web_catalog.json');
const createCourseRepository = require('../src/repositories/course.repository');

async function snapshot(pool) {
  const state = {};
  for (const table of ['courses', 'units', 'lessons', 'users',
    'auth_sessions', 'auth_refresh_tokens', 'schema_migrations']) {
    state[table] = (await pool.query(`SELECT * FROM public.${table} ORDER BY 1`)).rows;
  }
  state.sequences = (await pool.query(`
    SELECT sequencename, last_value FROM pg_sequences
    WHERE schemaname = 'public' ORDER BY sequencename
  `)).rows;
  return state;
}

test('catálogo HTTP con PostgreSQL temporal aislado', {
  skip: postgresSkip, timeout: 60000,
}, async (t) => {
  const { connection, database } = await temporaryPostgres(t);
  const pool = await database(t);
  await runMigrations(pool, { log() {} });
  // Fixtures ficticios: hacen significativa la conservación de usuarios y sesiones
  // en TODOS los snapshots siguientes. Nunca se usan credenciales reales.
  const user = (await pool.query(`INSERT INTO public.users (name, email, password)
    VALUES ($1, $2, $3) RETURNING id`,
  ['Usuario ficticio del catálogo', 'catalog-security@example.invalid', 'hash-ficticio-no-autenticable'])).rows[0];
  const session = (await pool.query(`INSERT INTO public.auth_sessions (user_id, created_at, expires_at)
    VALUES ($1, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z') RETURNING id`, [user.id])).rows[0];
  await pool.query(`INSERT INTO public.auth_refresh_tokens
    (token_hash, session_id, created_at, expires_at, used_at) VALUES
    ($1, $3, '2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z', '2026-01-02T00:00:00Z'),
    ($2, $3, '2026-01-02T00:00:00Z', '2027-01-01T00:00:00Z', NULL)`,
  ['a'.repeat(64), 'b'.repeat(64), session.id]);
  const initial = await snapshot(pool);
  assert.equal(initial.users.length, 1);
  assert.equal(initial.auth_sessions.length, 1);
  assert.equal(initial.auth_refresh_tokens.length, 2);
  // El endpoint usa un rol sin acceso a usuarios/sesiones/content
  // ni permisos de escritura, además de transacciones de solo lectura.
  await pool.query('CREATE ROLE catalog_reader LOGIN');
  await pool.query('GRANT SELECT (id, title, slug, description) ON public.courses TO catalog_reader');
  await pool.query('GRANT SELECT (id, course_id, title, position) ON public.units TO catalog_reader');
  await pool.query('GRANT SELECT (id, unit_id, title, position) ON public.lessons TO catalog_reader');
  const reader = new Pool({ ...connection, database: pool.options.database,
    user: 'catalog_reader', options: '-c default_transaction_read_only=on' });
  t.after(() => reader.end());
  const queries = [];
  const base = await serve(t, { async query(...args) {
    queries.push(args);
    return reader.query(...args);
  } });

  async function getCourses() {
    const response = await fetch(`${base}/api/courses`);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    return response.json();
  }

  await t.test('tabla vacía: 200 y arreglo vacío sin carga automática', async () => {
    const before = await snapshot(pool);
    assert.deepEqual(await getCourses(), { success: true, data: [] });
    assert.deepEqual(await snapshot(pool), before);
  });

  await t.test('seed existente: contenido real ordenado, IDs mayores que 1 y sin escrituras', async () => {
    await pool.query("SELECT setval('public.courses_id_seq', 70, false)");
    await seedCatalog(pool);
    const before = await snapshot(pool);
    const body = await getCourses();
    const expected = (await pool.query(
      'SELECT id, title, slug, description FROM public.courses ORDER BY title ASC, id ASC'
    )).rows;
    assert.deepEqual(body, { success: true, data: expected });
    assert.deepEqual(body.data.map((course) => course.title), ['CSS', 'HTML', 'JavaScript']);
    for (const course of body.data) {
      assert.ok(course.id >= 70);
      assert.deepEqual(Object.keys(course).sort(), ['description', 'id', 'slug', 'title']);
      const source = catalog.find((item) => item.slug === course.slug);
      assert.equal(course.description, source.description);
      assert.equal(course.title, source.title);
    }
    assert.deepEqual(await snapshot(pool), before);
    assert.equal(reader.totalCount, reader.idleCount);
  });

  await t.test('refleja registros ajenos al seed, desempata por ID y conserva description null', async () => {
    // Fixtures solo en la base temporal; no se modifica el archivo del seed.
    await pool.query(`INSERT INTO public.courses (id, title, slug, description)
      VALUES (900, 'CSS', 'css-extra', 'Curso temporal'), (500, 'CSS', 'css-null', NULL)`);
    const before = await snapshot(pool);
    const body = await getCourses();
    assert.deepEqual(body.data.map((course) => course.id), [71, 500, 900, 70, 72]);
    assert.deepEqual(body.data[1], { id: 500, title: 'CSS', slug: 'css-null', description: null });
    assert.equal(body.data[2].description, 'Curso temporal');
    assert.deepEqual(await getCourses(), body);
    assert.deepEqual(await snapshot(pool), before);
  });

  await t.test('detalle real de HTML, CSS y JavaScript: relaciones, contrato y dos consultas por curso', async () => {
    const before = await snapshot(pool);
    for (const source of catalog) {
      const course = before.courses.find((item) => item.slug === source.slug);
      const units = before.units.filter((unit) => unit.course_id === course.id)
        .sort((a, b) => a.position - b.position).map(({ id, title, position }) => ({
          id, title, position,
          lessons: before.lessons.filter((lesson) => lesson.unit_id === id)
            .sort((a, b) => a.position - b.position)
            .map(({ id, title, position }) => ({ id, title, position })),
        }));
      const count = queries.length;
      const response = await fetch(`${base}/api/courses/${source.slug}`);
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body, { success: true, data: { ...course, units } });
      assert.equal(body.data.units[0].title, source.unit.title);
      assert.deepEqual(body.data.units[0].lessons.map((lesson) => lesson.title),
        source.unit.lessons.map((lesson) => lesson.title));
      assert.equal(queries.length - count, 2);
      assert.deepEqual(queries[count][1], [source.slug]);
      assert.deepEqual(queries[count + 1][1], [course.id]);
    }
    assert.deepEqual(await snapshot(pool), before);
    assert.equal(reader.totalCount, reader.idleCount);
  });

  await t.test('fixtures fuera del seed: sin unidades, unidades vacías, orden por posición y sin N+1', async () => {
    // IDs e inserción en orden distinto a position; escrituras solo para preparar esta base temporal.
    await pool.query(`INSERT INTO public.units (id, course_id, title, position)
      VALUES (900, 900, 'Tercera vacía', 9), (901, 900, 'Segunda', 5), (902, 900, 'Primera', 1)`);
    await pool.query(`INSERT INTO public.lessons (id, unit_id, title, position, content)
      VALUES (900, 901, 'Lección final', 8, 'Contenido excluido'),
        (901, 901, 'Lección inicial', 2, 'Contenido excluido'),
        (902, 902, 'Lección única', 1, 'Contenido excluido')`);
    const before = await snapshot(pool);
    const count = queries.length;
    const empty = await fetch(`${base}/api/courses/css-null`);
    assert.equal(empty.status, 200);
    assert.deepEqual(await empty.json(), { success: true, data: {
      id: 500, title: 'CSS', slug: 'css-null', description: null, units: [],
    } });
    const response = await fetch(`${base}/api/courses/css-extra`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, data: {
      id: 900, title: 'CSS', slug: 'css-extra', description: 'Curso temporal', units: [
        { id: 902, title: 'Primera', position: 1, lessons: [{ id: 902, title: 'Lección única', position: 1 }] },
        { id: 901, title: 'Segunda', position: 5, lessons: [
          { id: 901, title: 'Lección inicial', position: 2 }, { id: 900, title: 'Lección final', position: 8 },
        ] },
        { id: 900, title: 'Tercera vacía', position: 9, lessons: [] },
      ],
    } });
    assert.equal(queries.length - count, 4);
    assert.deepEqual(await snapshot(pool), before);
  });

  await t.test('404 e inyección inválida: sin consultas innecesarias ni cambios de registros', async () => {
    const before = await snapshot(pool);
    const count = queries.length;
    const missing = await fetch(`${base}/api/courses/curso-inexistente`);
    assert.equal(missing.status, 404);
    assert.deepEqual(await missing.json(), { success: false, message: 'Curso no encontrado.' });
    assert.equal(queries.length - count, 1);
    for (const slug of ['HTML', "html'; DROP TABLE public.courses; --", 'html/../../users']) {
      const response = await fetch(`${base}/api/courses/${encodeURIComponent(slug)}`);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { success: false, message: 'Slug de curso inválido.' });
    }
    assert.equal(queries.length - count, 1);
    assert.deepEqual(await snapshot(pool), before);
  });

  await t.test('SQL directo parametrizado: una tautología es un dato y no recupera otros cursos', async () => {
    const before = await snapshot(pool);
    const calls = [];
    const repository = createCourseRepository({ async query(...args) {
      calls.push(args);
      return reader.query(...args);
    } });
    for (const slug of ["' OR 1=1 --", "html' OR '1'='1' --"]) {
      assert.equal(await repository.findBySlug(slug), null);
      assert.deepEqual(calls.at(-1), [
        'SELECT id, title, slug, description FROM public.courses WHERE slug = $1', [slug],
      ]);
    }
    assert.equal(calls.length, 2);
    assert.deepEqual(await snapshot(pool), before);
  });

  await t.test('escrituras no disponibles, health y Swagger siguen funcionando', async () => {
    const before = await snapshot(pool);
    const count = queries.length;
    for (const [method, path] of [
      ...['POST', 'PUT', 'PATCH', 'DELETE'].flatMap(method =>
        ['/api/courses', '/api/courses/html'].map(path => [method, path])),
      ['PUT', '/api/courses/70'], ['PATCH', '/api/courses/70'], ['DELETE', '/api/courses/70'],
      ['GET', '/api/users']]) {
      const response = await fetch(`${base}${path}`, { method });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { success: false, message: 'Ruta no encontrada' });
    }
    assert.equal(queries.length, count);
    const health = await fetch(`${base}/api/health`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok', database: 'connected' });
    const docs = await fetch(`${base}/api-docs/swagger-ui-init.js`);
    assert.equal(docs.status, 200);
    assert.match(await docs.text(), /"\/api\/courses"/);
    assert.deepEqual(await snapshot(pool), before);
  });

  await t.test('error real de permisos PostgreSQL: 500 seguro y recuperación', async (context) => {
    const log = context.mock.method(console, 'error', () => {});
    const before = await snapshot(pool);
    await pool.query('REVOKE SELECT (id, title, slug, description) ON public.courses FROM catalog_reader');
    try {
      for (const path of ['/api/courses', '/api/courses/html']) {
        const response = await fetch(`${base}${path}`);
        assert.equal(response.status, 500);
        assert.deepEqual(await response.json(), { success: false, message: 'No se pudo completar la solicitud.' });
      }
      assert.equal(log.mock.callCount(), 2);
      assert.doesNotMatch(log.mock.calls[0].arguments[0], /SELECT|permission|catalog_reader|courses|password/);
    } finally {
      await pool.query('GRANT SELECT (id, title, slug, description) ON public.courses TO catalog_reader');
    }
    assert.equal((await getCourses()).data.length, 5);
    assert.deepEqual(await snapshot(pool), before);
  });

  await t.test('conexión PostgreSQL rechazada: 503 seguro y recuperación', async (context) => {
    context.mock.method(console, 'error', () => {});
    const before = await snapshot(pool);
    // Impide conexiones nuevas de este rol temporal sin detener el clúster.
    const unavailable = new Pool({ ...connection, database: pool.options.database,
      user: 'catalog_reader', options: '-c default_transaction_read_only=on' });
    context.after(() => unavailable.end());
    await pool.query('ALTER ROLE catalog_reader CONNECTION LIMIT 0');
    const unavailableBase = await serve(context, unavailable);
    try {
      for (const path of ['/api/courses', '/api/courses/html']) {
        const response = await fetch(`${unavailableBase}${path}`);
        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), {
          success: false, message: 'El catálogo no está disponible temporalmente.',
        });
      }
    } finally {
      await pool.query('ALTER ROLE catalog_reader CONNECTION LIMIT -1');
    }
    const recovered = await fetch(`${unavailableBase}/api/courses`);
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).data.length, 5);
    const detail = await fetch(`${unavailableBase}/api/courses/html`);
    assert.equal(detail.status, 200);
    assert.equal((await detail.json()).data.units[0].lessons.length, 3);
    assert.deepEqual(await snapshot(pool), before);
  });
});
