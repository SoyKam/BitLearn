const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { test } = require('node:test');
const { Pool } = require('pg');
const { temporaryPostgres, postgresSkip } = require('./helpers/temporary-postgres');
const runMigrations = require('../src/config/migrate');
const { seedCatalog } = require('../src/config/seed-catalog');
const catalog = require('../database/seeds/001_web_catalog.json');

const expected = [
  ['html', 'HTML', 'Fundamentos de HTML', [
    'Estructura básica de HTML', 'Etiquetas y elementos HTML', 'Formularios HTML',
  ]],
  ['css', 'CSS', 'Fundamentos de CSS', ['Selectores CSS', 'Modelo de caja', 'Flexbox']],
  ['javascript', 'JavaScript', 'Fundamentos de JavaScript', [
    'Variables y tipos de datos', 'Condicionales', 'Funciones',
  ]],
];

async function snapshot(pool) {
  const state = {};
  for (const table of ['courses', 'units', 'lessons', 'users', 'auth_sessions', 'auth_refresh_tokens', 'schema_migrations']) {
    state[table] = (await pool.query(`SELECT * FROM public.${table} ORDER BY 1`)).rows;
  }
  return state;
}

async function insertCourse(pool, course) {
  return (await pool.query('INSERT INTO courses (slug, title, description) VALUES ($1, $2, $3) RETURNING id',
    [course.slug, course.title, course.description])).rows[0].id;
}

test('seed del catálogo en PostgreSQL temporal aislado', {
  skip: postgresSkip, timeout: 60000,
}, async (t) => {
  const { temporary, connection, database } = await temporaryPostgres(t);
  async function migrated(context) {
    const pool = await database(context);
    await runMigrations(pool, { log() {} });
    return pool;
  }

  await t.test('crea 3 cursos, 3 unidades y 9 lecciones con relaciones, posiciones y textos correctos', async (context) => {
    const pool = await migrated(context);
    const registry = (await snapshot(pool)).schema_migrations;
    const results = await seedCatalog(pool);
    assert.equal(results.length, 15);
    assert.ok(results.every((result) => result.created));
    const state = await snapshot(pool);
    assert.equal(state.courses.length, 3);
    assert.equal(state.units.length, 3);
    assert.equal(state.lessons.length, 9);
    assert.deepEqual(state.courses.map((course) => course.slug).sort(), ['css', 'html', 'javascript']);
    for (const [index, [slug, title, unitTitle, titles]] of expected.entries()) {
      const course = state.courses.find((row) => row.slug === slug);
      assert.equal(course.title, title);
      assert.equal(course.description, catalog[index].description);
      assert.ok(course.description.length > 40);
      const units = state.units.filter((row) => row.course_id === course.id);
      assert.equal(units.length, 1);
      assert.equal(units[0].title, unitTitle);
      assert.equal(units[0].position, 1);
      const lessons = state.lessons.filter((row) => row.unit_id === units[0].id)
        .sort((a, b) => a.position - b.position);
      assert.deepEqual(lessons.map((lesson) => lesson.position), [1, 2, 3]);
      assert.deepEqual(lessons.map((lesson) => lesson.title), titles);
      assert.deepEqual(lessons.map((lesson) => lesson.content), catalog[index].unit.lessons.map((lesson) => lesson.content));
      assert.ok(lessons.every((lesson) => lesson.content.length > 100 && !lesson.content.includes('<script')));
    }
    assert.deepEqual(state.schema_migrations, registry);
    const second = await seedCatalog(pool);
    assert.equal(second.length, 15);
    assert.ok(second.every((result) => !result.created));
    assert.deepEqual(await snapshot(pool), state);
    assert.equal(pool.totalCount, pool.idleCount);
    // El seed no cambia el historial y las tres migraciones siguen siendo repetibles.
    await runMigrations(pool, { log() {} });
    assert.deepEqual(await snapshot(pool), state);
  });

  await t.test('completa un catálogo parcial, respeta IDs y conserva cursos, unidades y lecciones ajenos', async (context) => {
    const pool = await migrated(context);
    for (const table of ['courses', 'units', 'lessons']) {
      await pool.query('SELECT setval($1::regclass, 100, false)', [`public.${table}_id_seq`]);
    }
    const foreignId = await insertCourse(pool, { slug: 'otro', title: 'Otro curso', description: 'Conservar' });
    const htmlId = await insertCourse(pool, catalog[0]);
    const unitId = (await pool.query('INSERT INTO units (course_id, title, position) VALUES ($1, $2, 1) RETURNING id',
      [htmlId, catalog[0].unit.title])).rows[0].id;
    const first = catalog[0].unit.lessons[0];
    await pool.query('INSERT INTO lessons (unit_id, title, position, content) VALUES ($1, $2, 1, $3)',
      [unitId, first.title, first.content]);
    await pool.query("INSERT INTO lessons (unit_id, title, position, content) VALUES ($1, 'Lección ajena', 4, 'Conservar')", [unitId]);
    await pool.query("INSERT INTO units (course_id, title, position) VALUES ($1, 'Unidad ajena', 2), ($2, 'Otra unidad', 1)", [htmlId, foreignId]);
    await pool.query("INSERT INTO users (name, email, password) VALUES ('Prueba', 'seed@example.invalid', 'hash-ficticio')");
    const before = await snapshot(pool);
    const result = await seedCatalog(pool);
    assert.equal(result.filter((row) => row.created).length, 12);
    const after = await snapshot(pool);
    for (const [table, rows] of Object.entries(before)) {
      for (const row of rows) assert.ok(after[table].some((candidate) => JSON.stringify(candidate) === JSON.stringify(row)));
    }
    assert.equal(after.courses.find((row) => row.slug === 'html').id, htmlId);
    assert.equal(after.courses.length, 4);
    assert.equal(after.units.length, 5);
    assert.equal(after.lessons.length, 10);
    await seedCatalog(pool);
    assert.deepEqual(await snapshot(pool), after);
  });

  const conflicts = [
    ['título de curso', "UPDATE courses SET title = 'Ajeno'"],
    ['descripción de curso', "UPDATE courses SET description = 'Ajena'"],
    ['descripción nula', 'UPDATE courses SET description = NULL'],
    ['título en posición de unidad', "UPDATE units SET title = 'Ajena'"],
    ['unidad desplazada', 'UPDATE units SET position = 2'],
    ['título en posición de lección', "UPDATE lessons SET title = 'Ajena'"],
    ['contenido diferente', "UPDATE lessons SET content = 'Ajeno'"],
    ['contenido nulo', 'UPDATE lessons SET content = NULL'],
    ['lección desplazada', 'UPDATE lessons SET position = 4'],
  ];
  for (const [name, mutation] of conflicts) {
    await t.test(`conflicto de ${name}: rollback de toda la carga sin sobrescribir`, async (context) => {
      const pool = await migrated(context);
      // Solo el último curso: el conflicto ocurre después de insertar HTML y CSS.
      const course = catalog[2];
      const courseId = await insertCourse(pool, course);
      const unitId = (await pool.query('INSERT INTO units (course_id, title, position) VALUES ($1, $2, 1) RETURNING id',
        [courseId, course.unit.title])).rows[0].id;
      await pool.query('INSERT INTO lessons (unit_id, title, position, content) VALUES ($1, $2, 3, $3)',
        [unitId, course.unit.lessons[2].title, course.unit.lessons[2].content]);
      await pool.query(mutation);
      const before = await snapshot(pool);
      await assert.rejects(seedCatalog(pool), /Conflicto en .*javascript/);
      assert.deepEqual(await snapshot(pool), before);
      assert.equal(pool.totalCount, pool.idleCount);
    });
  }

  await t.test('error SQL al insertar la última lección revierte también cursos y unidades', async (context) => {
    const pool = await migrated(context);
    // Restricción adicional exclusiva de esta base temporal para provocar un error tardío.
    await pool.query("ALTER TABLE lessons ADD CONSTRAINT test_failure CHECK (title <> 'Funciones')");
    const before = await snapshot(pool);
    await assert.rejects(seedCatalog(pool), /No se pudo cargar el catálogo/);
    assert.deepEqual(await snapshot(pool), before);
    assert.equal(pool.totalCount, pool.idleCount);
  });

  await t.test('tablas ausentes: error controlado sin crear esquema', async (context) => {
    const pool = await database(context);
    await assert.rejects(seedCatalog(pool), /Faltan tablas del catálogo/);
    assert.deepEqual((await pool.query("SELECT tablename FROM pg_tables WHERE schemaname = 'public'")).rows, []);
    assert.equal(pool.totalCount, pool.idleCount);
  });

  await t.test('dos cargas concurrentes crean el catálogo una sola vez', async (context) => {
    const pool = await migrated(context);
    const second = new Pool({ ...connection, database: pool.options.database });
    context.after(() => second.end());
    const results = await Promise.all([seedCatalog(pool), seedCatalog(second)]);
    assert.deepEqual(results.map((rows) => rows.filter((row) => row.created).length).sort((a, b) => a - b), [0, 15]);
    const state = await snapshot(pool);
    assert.equal(state.courses.length, 3);
    assert.equal(state.units.length, 3);
    assert.equal(state.lessons.length, 9);
    assert.equal(pool.totalCount, pool.idleCount);
    assert.equal(second.totalCount, second.idleCount);
  });

  await t.test('CLI aislado: informa creaciones/existentes, códigos 0/1 y cierra el pool', async (context) => {
    const pool = await migrated(context);
    const preload = path.join(temporary, 'seed-cli-pool.cjs');
    const applicationName = 'bitlearn_seed_cli_test';
    fs.writeFileSync(preload, `
      const { Pool } = require(${JSON.stringify(require.resolve('pg'))});
      require.cache[${JSON.stringify(require.resolve('../src/config/db'))}] = {
        exports: new Pool(${JSON.stringify({ ...connection, database: pool.options.database, application_name: applicationName })})
      };
    `);
    function runCli() {
      return execFileSync('npm', ['run', 'db:seed:catalog'], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000,
        env: { ...process.env, NODE_OPTIONS: `--require=${preload}` }, stdio: 'pipe',
      });
    }
    assert.equal((runCli().match(/Creado:/g) || []).length, 15);
    assert.equal((runCli().match(/Ya existía:/g) || []).length, 15);
    await pool.query("UPDATE lessons SET content = 'dato-privado-ficticio' WHERE title = 'Funciones'");
    const before = await snapshot(pool);
    assert.throws(runCli, (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr, /Conflicto en lección javascript\/1\/3/);
      assert.doesNotMatch(error.stderr, /dato-privado|password|SELECT|postgresql:\/\//);
      assert.doesNotMatch(error.stdout, /Creado:|Ya existía:/);
      return true;
    });
    assert.deepEqual(await snapshot(pool), before);
    assert.equal((await pool.query('SELECT count(*) FROM pg_stat_activity WHERE application_name = $1', [applicationName])).rows[0].count, '0');
  });
});
