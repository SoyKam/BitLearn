const assert = require('node:assert/strict');
const { test } = require('node:test');
const { Pool } = require('pg');
const { temporaryPostgres, postgresSkip } = require('./helpers/temporary-postgres');
const serve = require('./helpers/course-app');
const runMigrations = require('../src/config/migrate');
const { seedCatalog } = require('../src/config/seed-catalog');
const catalog = require('../database/seeds/001_web_catalog.json');

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
  // El endpoint usa un rol sin acceso a usuarios/sesiones/unidades/lecciones
  // ni permisos de escritura, además de transacciones de solo lectura.
  await pool.query('CREATE ROLE catalog_reader LOGIN');
  await pool.query('GRANT SELECT (id, title, slug, description) ON public.courses TO catalog_reader');
  const reader = new Pool({ ...connection, database: pool.options.database,
    user: 'catalog_reader', options: '-c default_transaction_read_only=on' });
  t.after(() => reader.end());
  const base = await serve(t, reader);

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

  await t.test('escrituras y detalle no disponibles, health y Swagger siguen funcionando', async () => {
    const before = await snapshot(pool);
    for (const [method, path] of [['POST', '/api/courses'], ['PUT', '/api/courses/70'],
      ['PATCH', '/api/courses/70'], ['DELETE', '/api/courses/70'],
      ['GET', '/api/courses/html'], ['GET', '/api/users']]) {
      const response = await fetch(`${base}${path}`, { method });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { success: false, message: 'Ruta no encontrada' });
    }
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
      const response = await fetch(`${base}/api/courses`);
      assert.equal(response.status, 500);
      assert.deepEqual(await response.json(), { success: false, message: 'No se pudo completar la solicitud.' });
      assert.equal(log.mock.callCount(), 1);
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
      const response = await fetch(`${unavailableBase}/api/courses`);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), {
        success: false, message: 'El catálogo no está disponible temporalmente.',
      });
    } finally {
      await pool.query('ALTER ROLE catalog_reader CONNECTION LIMIT -1');
    }
    const recovered = await fetch(`${unavailableBase}/api/courses`);
    assert.equal(recovered.status, 200);
    assert.equal((await recovered.json()).data.length, 5);
    assert.deepEqual(await snapshot(pool), before);
  });
});
