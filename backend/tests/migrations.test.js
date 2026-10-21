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
    // Fixture del commit 4: incluye solo 001; las demás versiones son sintéticas.
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

  await t.test('crea el esquema de aprendizaje vacío con claves e índices para las relaciones', async (context) => {
    const pool = await database(context);
    await runMigrations(pool, silent);
    const tables = ['courses', 'units', 'lessons'];
    for (const table of tables) {
      assert.deepEqual((await pool.query(`SELECT * FROM public.${table}`)).rows, []);
    }
    const primaryKeys = (await pool.query(`
      SELECT c.relname AS name, pg_get_constraintdef(k.oid) AS definition
      FROM pg_constraint k JOIN pg_class c ON c.oid = k.conrelid
      WHERE k.contype = 'p' AND k.connamespace = 'public'::regnamespace
        AND c.relname = ANY($1) ORDER BY c.relname
    `, [tables])).rows;
    assert.deepEqual(primaryKeys, [...tables].sort().map((name) => ({ name, definition: 'PRIMARY KEY (id)' })));
    const indexes = (await pool.query(`
      SELECT tablename, indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename IN ('units', 'lessons')
    `)).rows;
    for (const [table, parent] of [['units', 'course_id'], ['lessons', 'unit_id']]) {
      assert.ok(indexes.some((row) => row.tablename === table
        && row.indexdef.includes(`UNIQUE INDEX`) && row.indexdef.endsWith(`(${parent}, "position")`)));
    }
  });

  await t.test('actualiza desde 001 y repetir las migraciones conserva tablas, datos y secuencias', async (context) => {
    const pool = await database(context);
    await runMigrations(pool, { ...silent, directory: directory() });
    await pool.query("INSERT INTO users (name, email, password) VALUES ('Original', 'original@example.invalid', 'hash-ficticio')");
    const users = (await pool.query('SELECT * FROM users')).rows;
    const columns = (await pool.query("SELECT * FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' ORDER BY ordinal_position")).rows;
    const oid = (await pool.query("SELECT 'public.users'::regclass::oid AS oid")).rows;
    const sequence = (await pool.query('SELECT last_value, is_called FROM users_id_seq')).rows;
    const firstMigration = (await pool.query('SELECT * FROM schema_migrations')).rows;
    const messages = [];
    const through002 = directory({
      '002_create_learning_structure.sql': fs.readFileSync(path.join(initialDirectory, '002_create_learning_structure.sql'), 'utf8'),
    });
    await runMigrations(pool, { directory: through002, log: (message) => messages.push(message) });
    assert.deepEqual(messages, [
      'Omitida (ya aplicada): 001_create_users.sql',
      'Aplicada: 002_create_learning_structure.sql',
    ]);
    assert.deepEqual((await pool.query('SELECT * FROM users')).rows, users);
    assert.deepEqual((await pool.query("SELECT * FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'users' ORDER BY ordinal_position")).rows, columns);
    assert.deepEqual((await pool.query("SELECT 'public.users'::regclass::oid AS oid")).rows, oid);
    assert.deepEqual((await pool.query('SELECT last_value, is_called FROM users_id_seq')).rows, sequence);
    assert.deepEqual((await pool.query("SELECT * FROM schema_migrations WHERE version = '1'")).rows, firstMigration);

    const course = (await pool.query("INSERT INTO courses (title, slug, description) VALUES ('Curso de prueba', 'curso-prueba', 'Descripción') RETURNING id")).rows[0];
    const unit = (await pool.query('INSERT INTO units (course_id, title, position) VALUES ($1, $2, $3) RETURNING id', [course.id, 'Unidad', 1])).rows[0];
    const content = 'Contenido de prueba\nconst value = 1;';
    await pool.query('INSERT INTO lessons (unit_id, title, position, content) VALUES ($1, $2, $3, $4)', [unit.id, 'Lección', 1, content]);
    assert.deepEqual((await pool.query(`
      SELECT c.slug, u.position AS unit_position, l.position AS lesson_position, l.content
      FROM courses c JOIN units u ON u.course_id = c.id JOIN lessons l ON l.unit_id = u.id
    `)).rows, [{ slug: 'curso-prueba', unit_position: 1, lesson_position: 1, content }]);

    async function snapshot() {
      const result = {};
      for (const table of ['users', 'courses', 'units', 'lessons']) {
        result[table] = {
          rows: (await pool.query(`SELECT * FROM public.${table} ORDER BY id`)).rows,
          oid: (await pool.query('SELECT $1::regclass::oid AS oid', [`public.${table}`])).rows,
          sequence: (await pool.query(`SELECT last_value, is_called FROM public.${table}_id_seq`)).rows,
        };
      }
      result.migrations = (await pool.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
      return result;
    }
    const before = await snapshot();
    await runMigrations(pool, silent);
    const after003 = await snapshot();
    assert.deepEqual({ ...after003, migrations: before.migrations }, before);
    assert.deepEqual(after003.migrations.slice(0, 2), before.migrations);
    assert.equal(after003.migrations[2].version, '3');
    assert.equal(after003.migrations[2].name, '003_create_auth_sessions.sql');
    assert.ok(after003.migrations[2].applied_at instanceof Date);
    messages.length = 0;
    await runMigrations(pool, { log: (message) => messages.push(message) });
    assert.deepEqual(await snapshot(), after003);
    assert.deepEqual(messages, [
      'Omitida (ya aplicada): 001_create_users.sql',
      'Omitida (ya aplicada): 002_create_learning_structure.sql',
      'Omitida (ya aplicada): 003_create_auth_sessions.sql',
    ]);
  });

  await t.test('valida títulos, slugs, posiciones, unicidad y claves foráneas', async (context) => {
    const pool = await database(context);
    await runMigrations(pool, silent);
    const courses = (await pool.query("INSERT INTO courses (title, slug) VALUES ('Curso', 'curso-uno'), ('Curso', 'curso-dos') RETURNING *")).rows;
    assert.equal(courses[0].description, null);
    const units = (await pool.query('INSERT INTO units (course_id, title, position) VALUES ($1, $3, 1), ($2, $3, 1) RETURNING id', [courses[0].id, courses[1].id, 'Unidad'])).rows;
    const lessons = (await pool.query('INSERT INTO lessons (unit_id, title, position) VALUES ($1, $3, 1), ($2, $3, 1) RETURNING *', [units[0].id, units[1].id, 'Lección'])).rows;
    assert.equal(lessons[0].content, null);
    // La misma posición y el mismo título son válidos con padres diferentes.
    for (const [table, parent, parentId] of [
      ['units', 'course_id', courses[0].id], ['lessons', 'unit_id', units[0].id],
    ]) {
      const insert = `INSERT INTO ${table} (${parent}, title, position) VALUES ($1, $2, $3)`;
      await pool.query(insert, [parentId, 'Otro elemento', 2]);
      await assert.rejects(pool.query(insert, [parentId, 'Duplicado', 1]), { code: '23505' });
      await assert.rejects(pool.query(insert, [-1, 'Sin padre', 3]), { code: '23503' });
      await assert.rejects(pool.query(insert, [null, 'Sin padre', 3]), { code: '23502' });
      for (const position of [0, -1]) {
        await assert.rejects(pool.query(insert, [parentId, 'Posición inválida', position]), { code: '23514' });
      }
      await assert.rejects(pool.query(insert, [parentId, 'Sin posición', null]), { code: '23502' });
      await assert.rejects(pool.query(`UPDATE ${table} SET ${parent} = $1 WHERE ${parent} = $2`, [-1, parentId]), { code: '23503' });
      await assert.rejects(pool.query(`UPDATE ${table} SET position = 1 WHERE ${parent} = $1 AND position = 2`, [parentId]), { code: '23505' });
    }
    for (const table of ['courses', 'units', 'lessons']) {
      for (const title of ['', '   ', '\t\n']) {
        await assert.rejects(pool.query(`UPDATE ${table} SET title = $1`, [title]), { code: '23514' });
      }
      await assert.rejects(pool.query(`UPDATE ${table} SET title = NULL`), { code: '23502' });
    }
    await assert.rejects(pool.query("INSERT INTO courses (title, slug) VALUES ('Duplicado', 'curso-uno')"), { code: '23505' });
    for (const slug of ['', ' ', 'Curso', 'con espacio', '-curso', 'curso-', 'curso--uno']) {
      await assert.rejects(pool.query('INSERT INTO courses (title, slug) VALUES ($1, $2)', ['Curso', slug]), { code: '23514' });
    }
    await assert.rejects(pool.query("INSERT INTO courses (title) VALUES ('Sin slug')"), { code: '23502' });
    await assert.rejects(pool.query('DELETE FROM courses WHERE id = $1', [courses[0].id]), { code: '23503' });
    await assert.rejects(pool.query('DELETE FROM units WHERE id = $1', [units[0].id]), { code: '23503' });
    assert.equal((await pool.query('SELECT count(*) FROM lessons')).rows[0].count, '3');
  });

  // Hashes ficticios con el formato esperado; no se generan tokens ni credenciales.
  const firstHash = 'a'.repeat(64);
  const nextHash = 'b'.repeat(64);
  const createdAt = '2026-10-01T00:00:00Z';
  const expiresAt = '2026-10-08T00:00:00Z';
  const usedAt = '2026-10-02T00:00:00Z';

  async function authFixture(context) {
    const pool = await database(context);
    await runMigrations(pool, silent);
    const user = (await pool.query(
      'INSERT INTO users (name, email, password) VALUES ($1, $2, $3) RETURNING id',
      ['Prueba', 'auth@example.invalid', 'hash-ficticio']
    )).rows[0];
    const sessions = (await pool.query(`
      INSERT INTO auth_sessions (user_id, created_at, expires_at)
      VALUES ($1, $2, $3), ($1, $2, $3) RETURNING *
    `, [user.id, createdAt, expiresAt])).rows;
    await pool.query(`
      INSERT INTO auth_refresh_tokens (token_hash, session_id, created_at, expires_at)
      VALUES ($1, $2, $3, $4)
    `, [firstHash, sessions[0].id, createdAt, expiresAt]);
    return { pool, user, sessions };
  }

  await t.test('crea las tablas de autenticación vacías con PK, índices y fechas TIMESTAMPTZ', async (context) => {
    const pool = await database(context);
    await runMigrations(pool, silent);
    for (const [table, primaryKey, dates] of [
      ['auth_sessions', 'id', ['created_at', 'expires_at', 'revoked_at']],
      ['auth_refresh_tokens', 'token_hash', ['created_at', 'expires_at', 'used_at']],
    ]) {
      assert.deepEqual((await pool.query(`SELECT * FROM ${table}`)).rows, []);
      const columns = (await pool.query(`
        SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = $1 AND column_name = ANY($2)
        ORDER BY column_name
      `, [table, dates])).rows;
      assert.deepEqual(columns, [...dates].sort().map((column_name) => ({
        column_name, data_type: 'timestamp with time zone',
      })));
      assert.deepEqual((await pool.query(`
        SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint
        WHERE conrelid = $1::regclass AND contype = 'p'
      `, [table])).rows, [{ definition: `PRIMARY KEY (${primaryKey})` }]);
    }
    const indexes = (await pool.query(`
      SELECT indexdef FROM pg_indexes
      WHERE schemaname = 'public' AND tablename IN ('auth_sessions', 'auth_refresh_tokens')
    `)).rows.map((row) => row.indexdef);
    assert.ok(indexes.some((sql) => sql.endsWith('ON public.auth_sessions USING btree (user_id)')));
    assert.ok(indexes.some((sql) => sql.endsWith('ON public.auth_refresh_tokens USING btree (session_id)')));
    assert.ok(indexes.some((sql) => sql.includes('UNIQUE INDEX')
      && sql.endsWith('(session_id) WHERE (used_at IS NULL)')));
  });

  await t.test('admite varias sesiones por usuario y exige relaciones válidas sin borrado de historial', async (context) => {
    const { pool, user, sessions } = await authFixture(context);
    assert.notEqual(sessions[0].id, sessions[1].id);
    assert.ok(sessions.every((session) => session.user_id === user.id && session.revoked_at === null));
    await pool.query(`
      INSERT INTO auth_refresh_tokens (token_hash, session_id, created_at, expires_at)
      VALUES ($1, $2, $3, $4)
    `, [nextHash, sessions[1].id, createdAt, expiresAt]);
    const defaultSession = (await pool.query(`
      INSERT INTO auth_sessions (user_id, expires_at)
      VALUES ($1, CURRENT_TIMESTAMP + INTERVAL '2 days') RETURNING id, created_at
    `, [user.id])).rows[0];
    assert.ok(defaultSession.created_at instanceof Date);
    const defaultToken = (await pool.query(`
      INSERT INTO auth_refresh_tokens (token_hash, session_id, expires_at)
      VALUES ($1, $2, CURRENT_TIMESTAMP + INTERVAL '1 day') RETURNING created_at, used_at
    `, ['c'.repeat(64), defaultSession.id])).rows[0];
    assert.ok(defaultToken.created_at instanceof Date);
    assert.equal(defaultToken.used_at, null);
    await assert.rejects(pool.query(`
      INSERT INTO auth_sessions (user_id, created_at, expires_at) VALUES (-1, $1, $2)
    `, [createdAt, expiresAt]), { code: '23503' });
    await assert.rejects(pool.query(`
      INSERT INTO auth_refresh_tokens (token_hash, session_id, created_at, expires_at)
      VALUES ($1, -1, $2, $3)
    `, ['d'.repeat(64), createdAt, expiresAt]), { code: '23503' });
    await assert.rejects(pool.query('UPDATE auth_sessions SET user_id = -1'), { code: '23503' });
    await assert.rejects(pool.query('UPDATE auth_refresh_tokens SET session_id = -1 WHERE token_hash = $1', [firstHash]), { code: '23503' });
    await assert.rejects(pool.query('DELETE FROM users WHERE id = $1', [user.id]), { code: '23503' });
    await assert.rejects(pool.query('DELETE FROM auth_sessions WHERE id = $1', [sessions[0].id]), { code: '23503' });
  });

  await t.test('rechaza hashes duplicados o mal formados y datos obligatorios ausentes', async (context) => {
    const { pool, sessions } = await authFixture(context);
    const insert = `INSERT INTO auth_refresh_tokens (token_hash, session_id, created_at, expires_at)
      VALUES ($1, $2, $3, $4)`;
    // La unicidad del hash es global, incluso entre sesiones diferentes.
    await assert.rejects(pool.query(insert, [firstHash, sessions[1].id, createdAt, expiresAt]), { code: '23505' });
    for (const hash of ['', ' ', 'token-original-ficticio', 'a'.repeat(63), 'a'.repeat(65), 'g'.repeat(64), 'A'.repeat(64)]) {
      await assert.rejects(pool.query(insert, [hash, sessions[1].id, createdAt, expiresAt]), { code: '23514' });
    }
    for (const [table, columns] of [
      ['auth_sessions', ['id', 'user_id', 'created_at', 'expires_at']],
      ['auth_refresh_tokens', ['token_hash', 'session_id', 'created_at', 'expires_at']],
    ]) {
      for (const column of columns) {
        await assert.rejects(pool.query(`UPDATE ${table} SET ${column} = NULL`), { code: '23502' });
      }
    }
    await assert.rejects(pool.query('INSERT INTO auth_sessions DEFAULT VALUES'), { code: '23502' });
    await assert.rejects(pool.query('INSERT INTO auth_refresh_tokens DEFAULT VALUES'), { code: '23502' });
  });

  await t.test('rechaza fechas incoherentes o infinitas y representa revocación después de expirar', async (context) => {
    const { pool, sessions } = await authFixture(context);
    for (const table of ['auth_sessions', 'auth_refresh_tokens']) {
      for (const date of [createdAt, '2026-09-30T00:00:00Z', 'infinity', '-infinity']) {
        await assert.rejects(pool.query(`UPDATE ${table} SET expires_at = $1`, [date]), { code: '23514' });
      }
      for (const date of [expiresAt, 'infinity', '-infinity']) {
        await assert.rejects(pool.query(`UPDATE ${table} SET created_at = $1`, [date]), { code: '23514' });
      }
    }
    for (const [table, column] of [['auth_sessions', 'revoked_at'], ['auth_refresh_tokens', 'used_at']]) {
      for (const date of ['2026-09-30T00:00:00Z', 'infinity', '-infinity']) {
        await assert.rejects(pool.query(`UPDATE ${table} SET ${column} = $1`, [date]), { code: '23514' });
      }
    }
    for (const date of [expiresAt, '2026-10-09T00:00:00Z']) {
      await assert.rejects(pool.query('UPDATE auth_refresh_tokens SET used_at = $1', [date]), { code: '23514' });
    }
    const revokedAt = '2026-10-09T00:00:00Z';
    await pool.query('UPDATE auth_sessions SET revoked_at = $1 WHERE id = $2', [revokedAt, sessions[0].id]);
    assert.deepEqual((await pool.query('SELECT id, revoked_at FROM auth_sessions ORDER BY id')).rows, [
      { id: sessions[0].id, revoked_at: new Date(revokedAt) },
      { id: sessions[1].id, revoked_at: null },
    ]);
  });

  await t.test('representa rotación, conserva hashes usados y repetir migraciones mantiene las sesiones', async (context) => {
    const { pool, sessions } = await authFixture(context);
    const insert = `INSERT INTO auth_refresh_tokens (token_hash, session_id, created_at, expires_at)
      VALUES ($1, $2, $3, $4)`;
    await assert.rejects(pool.query(insert, [nextHash, sessions[0].id, usedAt, expiresAt]), { code: '23505' });
    // Fixture SQL del estado persistido; no implementa un servicio de rotación.
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('UPDATE auth_refresh_tokens SET used_at = $1 WHERE token_hash = $2', [usedAt, firstHash]);
      await client.query(insert, [nextHash, sessions[0].id, usedAt, expiresAt]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    assert.deepEqual((await pool.query(`
      SELECT token_hash, session_id, used_at FROM auth_refresh_tokens ORDER BY token_hash
    `)).rows, [
      { token_hash: firstHash, session_id: sessions[0].id, used_at: new Date(usedAt) },
      { token_hash: nextHash, session_id: sessions[0].id, used_at: null },
    ]);
    // El hash anterior aún permite encontrar su sesión, incluso revocada.
    await pool.query('UPDATE auth_sessions SET revoked_at = $1 WHERE id = $2', [usedAt, sessions[0].id]);
    assert.deepEqual((await pool.query(`
      SELECT s.id, s.revoked_at, r.used_at FROM auth_refresh_tokens r
      JOIN auth_sessions s ON s.id = r.session_id WHERE r.token_hash = $1
    `, [firstHash])).rows, [{ id: sessions[0].id, revoked_at: new Date(usedAt), used_at: new Date(usedAt) }]);
    await assert.rejects(pool.query(insert, [firstHash, sessions[1].id, usedAt, expiresAt]), { code: '23505' });
    await assert.rejects(pool.query('UPDATE auth_refresh_tokens SET used_at = NULL WHERE token_hash = $1', [firstHash]), { code: '23505' });
    const before = (await pool.query('SELECT * FROM auth_refresh_tokens ORDER BY token_hash')).rows;
    const beforeSessions = (await pool.query('SELECT * FROM auth_sessions ORDER BY id')).rows;
    await runMigrations(pool, silent);
    assert.deepEqual((await pool.query('SELECT * FROM auth_refresh_tokens ORDER BY token_hash')).rows, before);
    assert.deepEqual((await pool.query('SELECT * FROM auth_sessions ORDER BY id')).rows, beforeSessions);
  });

  await t.test('un error al final de 003 revierte tablas, índices y registro y permite reintentar', async (context) => {
    const pool = await database(context);
    const dir = directory({
      '002_create_learning_structure.sql': fs.readFileSync(path.join(initialDirectory, '002_create_learning_structure.sql'), 'utf8'),
    });
    await runMigrations(pool, { ...silent, directory: dir });
    const before = (await pool.query('SELECT * FROM schema_migrations ORDER BY version')).rows;
    const name = '003_create_auth_sessions.sql';
    const sql = fs.readFileSync(path.join(initialDirectory, name), 'utf8');
    fs.writeFileSync(path.join(dir, name), `${sql}\nSELECT 1 / 0;`);
    await assert.rejects(runMigrations(pool, { ...silent, directory: dir }), /No se pudo aplicar 003_create_auth_sessions.sql/);
    assert.deepEqual((await pool.query('SELECT * FROM schema_migrations ORDER BY version')).rows, before);
    assert.deepEqual((await pool.query(`
      SELECT relname FROM pg_class WHERE relnamespace = 'public'::regnamespace
      AND relname LIKE 'auth_%'
    `)).rows, []);
    // Solo se corrige la copia temporal que falló; no se edita una versión aplicada.
    fs.writeFileSync(path.join(dir, name), sql);
    await runMigrations(pool, { ...silent, directory: dir });
    assert.deepEqual((await pool.query("SELECT version, name FROM schema_migrations WHERE version = '3'")).rows,
      [{ version: '3', name }]);
    assert.deepEqual((await pool.query('SELECT * FROM auth_sessions')).rows, []);
    assert.deepEqual((await pool.query('SELECT * FROM auth_refresh_tokens')).rows, []);
  });

  await t.test('un conflicto en 002 revierte la migración completa y conserva la tabla existente', async (context) => {
    const pool = await database(context);
    await runMigrations(pool, { ...silent, directory: directory() });
    await pool.query('CREATE TABLE units (marker TEXT)');
    await pool.query('INSERT INTO units VALUES ($1)', ['conservar']);
    const before = (await pool.query('SELECT * FROM schema_migrations')).rows;
    const oid = (await pool.query("SELECT 'public.units'::regclass::oid AS oid")).rows;
    await assert.rejects(runMigrations(pool, silent), /No se pudo aplicar 002_create_learning_structure.sql/);
    assert.deepEqual((await pool.query('SELECT * FROM schema_migrations')).rows, before);
    assert.deepEqual((await pool.query('SELECT * FROM units')).rows, [{ marker: 'conservar' }]);
    assert.deepEqual((await pool.query("SELECT 'public.units'::regclass::oid AS oid")).rows, oid);
    assert.deepEqual((await pool.query("SELECT to_regclass('courses') AS courses, to_regclass('lessons') AS lessons")).rows, [{ courses: null, lessons: null }]);
  });

  await t.test('revierte SQL y registro fallidos; conserva versiones anteriores y permite reintentar', async (context) => {
    const pool = await database(context);
    await runMigrations(pool, { ...silent, directory: directory() });
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
    assert.deepEqual((await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows,
      [{ version: '1' }, { version: '2' }, { version: '3' }]);
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
    assert.equal((await pool.query("SELECT name FROM schema_migrations WHERE version = '1'")).rows[0].name, '001_create_users.sql');
  });

  await t.test('db:migrate termina con 0 al aplicar/omitir y con 1 ante esquema incompatible', async (context) => {
    const pool = await database(context);
    const incompatiblePool = await database(context);
    await incompatiblePool.query(legacySchema.replace(' UNIQUE', ''));
    const preload = path.join(temporary, 'cli-pool.cjs');
    // Sustituye únicamente el pool del CLI por uno del clúster temporal.
    // db.js no se evalúa, por lo que no lee .env, certificados ni credenciales reales.
    function runCli(databaseName) {
      fs.writeFileSync(preload, `
        const { Pool } = require(${JSON.stringify(require.resolve('pg'))});
        require.cache[${JSON.stringify(require.resolve('../src/config/db'))}] = {
          exports: new Pool(${JSON.stringify({ ...connection, database: databaseName })})
        };
      `);
      return execFileSync('npm', ['run', 'db:migrate'], {
        cwd: path.join(__dirname, '..'), encoding: 'utf8', timeout: 10000,
        env: { ...process.env, NODE_OPTIONS: `--require=${preload}` }, stdio: 'pipe',
      });
    }
    const applied = runCli(pool.options.database);
    const skipped = runCli(pool.options.database);
    for (const name of ['001_create_users.sql', '002_create_learning_structure.sql', '003_create_auth_sessions.sql']) {
      assert.ok(applied.includes(`Aplicada: ${name}`));
      assert.ok(skipped.includes(`Omitida (ya aplicada): ${name}`));
    }
    assert.throws(() => runCli(incompatiblePool.options.database), (error) => {
      assert.equal(error.status, 1);
      assert.match(error.stderr, /users tiene una estructura incompatible/);
      assert.doesNotMatch(error.stderr, /password|hash-ficticio|SELECT|postgresql:\/\//);
      return true;
    });
  });
});
