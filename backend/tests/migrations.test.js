const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const { Pool } = require('pg');
const runMigrations = require('../src/config/migrate');

// Nunca carga db.js ni .env: crea su propio clúster, accesible solo por un socket privado.
const postgresBin = process.env.POSTGRES_BIN || '/usr/lib/postgresql/16/bin';
const available = ['initdb', 'pg_ctl'].every((file) => fs.existsSync(path.join(postgresBin, file)));
const initialDirectory = path.join(__dirname, '../database/migrations');
const legacySchema = `CREATE TABLE public.users (
  id SERIAL PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
)`;
const silent = { log() {} };

test('migraciones en PostgreSQL temporal aislado', {
  skip: available ? false : 'Falta PostgreSQL local; define POSTGRES_BIN con la carpeta de initdb y pg_ctl.',
  timeout: 60000,
}, async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bitlearn-migrations-'));
  const data = path.join(temporary, 'data');
  const socket = path.join(temporary, 'socket');
  fs.mkdirSync(socket, { mode: 0o700 });
  let started = false;
  let admin;
  t.after(async () => {
    try {
      if (admin) await admin.end();
    } finally {
      if (started) {
        execFileSync(path.join(postgresBin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
      }
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  execFileSync(path.join(postgresBin, 'initdb'), [
    '-D', data, '-U', 'bitlearn_test', '--auth=trust', '--no-locale', '--encoding=UTF8',
  ], { stdio: 'pipe' });
  execFileSync(path.join(postgresBin, 'pg_ctl'), [
    '-D', data, '-l', path.join(temporary, 'postgres.log'),
    '-o', `-h '' -k ${socket} -p 55439`, '-w', 'start',
  ], { stdio: 'pipe' });
  started = true;
  const connection = { host: socket, port: 55439, user: 'bitlearn_test', ssl: false, max: 1 };
  admin = new Pool({ ...connection, database: 'postgres' });
  let number = 0;

  async function database(context) {
    // Identificador generado por la prueba; nunca procede de entradas externas.
    const name = `migration_test_${++number}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const pool = new Pool({ ...connection, database: name });
    context.after(() => pool.end());
    return pool;
  }

  function directory(files = {}) {
    const dir = fs.mkdtempSync(path.join(temporary, 'sql-'));
    fs.copyFileSync(path.join(initialDirectory, '001_create_users.sql'), path.join(dir, '001_create_users.sql'));
    for (const [name, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), sql);
    return dir;
  }

  await t.test('base vacía, orden numérico y segunda ejecución sin repetir SQL', async (context) => {
    const pool = await database(context);
    const dir = directory({
      '10_insert_probe.sql': 'INSERT INTO migration_probe VALUES (1)',
      '2_create_probe.sql': 'CREATE TABLE migration_probe (id INTEGER PRIMARY KEY)',
    });
    const messages = [];
    const options = { directory: dir, log: (message) => messages.push(message) };
    await runMigrations(pool, options);
    const first = (await pool.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
    assert.deepEqual(first.map((row) => row.version), ['1', '10', '2']);
    assert.ok(first.every((row) => row.applied_at instanceof Date));
    await runMigrations(pool, options);
    assert.deepEqual((await pool.query('SELECT * FROM schema_migrations ORDER BY version')).rows, first);
    assert.equal((await pool.query('SELECT count(*) FROM migration_probe')).rows[0].count, '1');
    assert.equal(messages.filter((message) => message.startsWith('Aplicada:')).length, 3);
    assert.equal(messages.filter((message) => message.startsWith('Omitida')).length, 3);
    assert.equal(pool.totalCount, pool.idleCount);
  });

  await t.test('adopta users y conserva tabla, usuarios, contraseñas y secuencia', async (context) => {
    const pool = await database(context);
    await pool.query(legacySchema);
    await pool.query("INSERT INTO users (name, email, password) VALUES ('Prueba', 'test@example.invalid', 'hash-ficticio')");
    const before = (await pool.query('SELECT * FROM users')).rows;
    const oid = (await pool.query("SELECT 'public.users'::regclass::oid AS oid")).rows;
    const sequence = (await pool.query('SELECT last_value, is_called FROM users_id_seq')).rows;
    await runMigrations(pool, silent);
    assert.deepEqual((await pool.query('SELECT * FROM users')).rows, before);
    assert.deepEqual((await pool.query("SELECT 'public.users'::regclass::oid AS oid")).rows, oid);
    assert.deepEqual((await pool.query('SELECT last_value, is_called FROM users_id_seq')).rows, sequence);
    const { rows } = await pool.query("INSERT INTO users (name, email, password) VALUES ('Nueva', 'next@example.invalid', 'otro-hash') RETURNING id, created_at");
    assert.equal(rows[0].id, 2);
    assert.ok(rows[0].created_at instanceof Date);
  });

  await t.test('revierte SQL y registro fallidos; conserva versiones anteriores y permite reintentar', async (context) => {
    const pool = await database(context);
    await runMigrations(pool, silent);
    await pool.query("INSERT INTO users (name, email, password) VALUES ('Original', 'keep@example.invalid', 'hash-ficticio')");
    const before = (await pool.query('SELECT * FROM users')).rows;
    const dir = directory({
      '002_failure.sql': "UPDATE users SET name = 'Cambio'; CREATE TABLE rollback_probe (id INTEGER); SELECT 1 / 0;",
      '003_never.sql': 'CREATE TABLE never_applied (id INTEGER)',
    });
    await assert.rejects(runMigrations(pool, { ...silent, directory: dir }), /No se pudo aplicar 002_failure.sql/);
    assert.deepEqual((await pool.query('SELECT * FROM users')).rows, before);
    assert.equal((await pool.query('SELECT count(*) FROM schema_migrations')).rows[0].count, '1');
    assert.deepEqual((await pool.query("SELECT to_regclass('rollback_probe') AS rollback, to_regclass('never_applied') AS later")).rows, [{ rollback: null, later: null }]);
    // Este archivo falló: todavía no forma parte del historial aplicado.
    fs.writeFileSync(path.join(dir, '002_failure.sql'), 'CREATE TABLE rollback_probe (id INTEGER)');
    await runMigrations(pool, { ...silent, directory: dir });
    assert.equal((await pool.query('SELECT count(*) FROM schema_migrations')).rows[0].count, '3');
  });

  const incompatible = {
    'tipo incorrecto': legacySchema.replace('VARCHAR(100)', 'TEXT'),
    'columna ausente': legacySchema.replace('password VARCHAR(255) NOT NULL,', ''),
    'email nullable': legacySchema.replace('VARCHAR(150) UNIQUE NOT NULL', 'VARCHAR(150) UNIQUE'),
    'sin unicidad': legacySchema.replace(' UNIQUE', ''),
    'unicidad compuesta': legacySchema.replace(' UNIQUE', '') + '; ALTER TABLE users ADD UNIQUE (email, name)',
    'índice único parcial': legacySchema.replace(' UNIQUE', '') + "; CREATE UNIQUE INDEX partial_email ON users (email) WHERE name <> ''",
    'sin PK': legacySchema.replace(' PRIMARY KEY', ''),
    'PK compuesta': legacySchema.replace(' PRIMARY KEY', '') + '; ALTER TABLE users ADD PRIMARY KEY (id, email)',
    'sin autoincremento': legacySchema.replace('SERIAL', 'INTEGER'),
    'default id incorrecto': legacySchema + '; ALTER TABLE users ALTER COLUMN id SET DEFAULT 1',
    'sin fecha predeterminada': legacySchema.replace(' DEFAULT CURRENT_TIMESTAMP', ''),
    'fecha constante': legacySchema.replace('CURRENT_TIMESTAMP', "'2020-01-01'"),
    'columna extra obligatoria': legacySchema + '; ALTER TABLE users ADD COLUMN required_extra TEXT NOT NULL',
  };
  for (const [name, sql] of Object.entries(incompatible)) {
    await t.test(`rechaza estructura incompatible: ${name}`, async (context) => {
      const pool = await database(context);
      await pool.query(sql);
      const columns = (await pool.query("SELECT * FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' ORDER BY ordinal_position")).rows;
      await assert.rejects(runMigrations(pool, silent), /users tiene una estructura incompatible/);
      assert.equal((await pool.query("SELECT to_regclass('schema_migrations') AS registry")).rows[0].registry, null);
      assert.deepEqual((await pool.query("SELECT * FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' ORDER BY ordinal_position")).rows, columns);
    });
  }

  await t.test('acepta identity, now() y columna adicional opcional', async (context) => {
    const pool = await database(context);
    await pool.query(legacySchema.replace('SERIAL', 'INTEGER GENERATED ALWAYS AS IDENTITY').replace('CURRENT_TIMESTAMP', 'now()'));
    await pool.query('ALTER TABLE users ADD COLUMN optional_extra TEXT');
    await runMigrations(pool, silent);
    assert.equal((await pool.query('SELECT count(*) FROM schema_migrations')).rows[0].count, '1');
  });

  await t.test('dos migradores concurrentes aplican cada versión una sola vez', async (context) => {
    const pool = await database(context);
    const secondPool = new Pool({ ...connection, database: pool.options.database });
    context.after(() => secondPool.end());
    const dir = directory({
      '002_concurrent.sql': 'SELECT pg_sleep(0.2); CREATE TABLE concurrent_probe (id INTEGER PRIMARY KEY); INSERT INTO concurrent_probe VALUES (1)',
    });
    const messages = [];
    const options = { directory: dir, log: (message) => messages.push(message) };
    await Promise.all([runMigrations(pool, options), runMigrations(secondPool, options)]);
    assert.equal((await pool.query('SELECT count(*) FROM schema_migrations')).rows[0].count, '2');
    assert.equal((await pool.query('SELECT count(*) FROM concurrent_probe')).rows[0].count, '1');
    assert.equal(messages.filter((message) => message.startsWith('Aplicada:')).length, 2);
    assert.equal(messages.filter((message) => message.startsWith('Omitida')).length, 2);
  });

  await t.test('rechaza versiones duplicadas antes de modificar el esquema', async (context) => {
    const pool = await database(context);
    const dir = directory({ '1_duplicate.sql': 'SELECT 1' });
    await assert.rejects(runMigrations(pool, { ...silent, directory: dir }), /Versión de migración duplicada/);
    assert.equal((await pool.query("SELECT to_regclass('users') AS users")).rows[0].users, null);
  });

  await t.test('rechaza renombrar una versión aplicada', async (context) => {
    const pool = await database(context);
    await runMigrations(pool, silent);
    const dir = directory();
    fs.renameSync(path.join(dir, '001_create_users.sql'), path.join(dir, '001_renamed.sql'));
    await assert.rejects(runMigrations(pool, { ...silent, directory: dir }), /nombre coincida/);
    assert.equal((await pool.query('SELECT name FROM schema_migrations')).rows[0].name, '001_create_users.sql');
  });
});
