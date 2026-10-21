const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const createUserRepository = require('../src/repositories/user.repository');
const { createAuthService } = require('../src/services/auth.service');
const serve = require('./helpers/register-app');

// No importa index.js, db.js ni dotenv. Solo conecta a su propio socket privado.
const postgresBin = process.env.POSTGRES_BIN || '/usr/lib/postgresql/16/bin';
const available = ['initdb', 'pg_ctl'].every((file) => fs.existsSync(path.join(postgresBin, file)));
const valid = { name: 'Registro temporal', email: 'registro@example.invalid', password: 'contraseña-temporal' };

test('registro HTTP con PostgreSQL temporal aislado', {
  skip: available ? false : 'Falta PostgreSQL local; configura POSTGRES_BIN con initdb y pg_ctl.',
  timeout: 60000,
}, async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bitlearn-register-'));
  const data = path.join(temporary, 'data');
  const socket = path.join(temporary, 'socket');
  fs.mkdirSync(socket, { mode: 0o700 });
  let started = false;
  let pool;
  t.after(async () => {
    try {
      if (pool) await pool.end();
    } finally {
      if (started) execFileSync(path.join(postgresBin, 'pg_ctl'),
        ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
  execFileSync(path.join(postgresBin, 'initdb'), [
    '-D', data, '-U', 'register_test', '--auth=trust', '--no-locale', '--encoding=UTF8',
  ], { stdio: 'pipe' });
  execFileSync(path.join(postgresBin, 'pg_ctl'), [
    '-D', data, '-l', path.join(temporary, 'postgres.log'),
    '-o', `-h '' -k ${socket} -p 55440`, '-w', 'start',
  ], { stdio: 'pipe' });
  started = true;
  pool = new Pool({ host: socket, port: 55440, user: 'register_test', password: '',
    database: 'postgres', ssl: false, max: 4 });
  for (const file of ['001_create_users.sql', '003_create_auth_sessions.sql']) {
    await pool.query(fs.readFileSync(path.join(__dirname, '../database/migrations', file), 'utf8'));
  }
  const service = createAuthService(createUserRepository(pool));

  await t.test('persiste hash verificable y no crea sesiones, tokens ni cookies', async (context) => {
    const post = await serve(context, service);
    const response = await post({ ...valid, email: ' REGISTRO@Example.INVALID ' });
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('set-cookie'), null);
    const payload = await response.json();
    const { rows } = await pool.query('SELECT * FROM users WHERE id = $1', [payload.data.id]);
    assert.equal(rows.length, 1);
    const stored = rows[0];
    assert.equal(stored.email, valid.email);
    assert.notEqual(stored.password, valid.password);
    assert.equal(await bcrypt.compare(valid.password, stored.password), true);
    assert.equal(bcrypt.getRounds(stored.password), 10);
    assert.deepEqual(payload, { success: true, data: { id: stored.id, name: stored.name,
      email: stored.email, created_at: stored.created_at.toISOString() } });
    assert.deepEqual((await pool.query('SELECT * FROM auth_sessions')).rows, []);
    assert.deepEqual((await pool.query('SELECT * FROM auth_refresh_tokens')).rows, []);
  });

  await t.test('409 por la restricción UNIQUE real después de normalizar', async (context) => {
    const post = await serve(context, service);
    const response = await post({ ...valid, email: ' Registro@EXAMPLE.invalid ' });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { success: false, message: 'El correo ya está registrado.' });
    assert.equal((await pool.query('SELECT count(*) FROM users')).rows[0].count, '1');
  });

  await t.test('dos INSERT concurrentes del mismo correo producen un 201 y un 409', async (context) => {
    let inserts = 0;
    let release;
    const ready = new Promise((resolve) => { release = resolve; });
    const concurrent = createAuthService(createUserRepository({ async query(sql, params) {
      inserts++;
      if (inserts === 2) release();
      // Ambos hashes están listos antes de enviar INSERT a dos conexiones reales.
      await ready;
      return pool.query(sql, params);
    } }));
    const post = await serve(context, concurrent);
    const responses = await Promise.all([
      post({ ...valid, email: ' Concurrente@EXAMPLE.invalid ' }),
      post({ ...valid, email: 'concurrente@example.invalid' }),
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
    for (const response of responses) {
      const payload = await response.json();
      assert.equal(payload.success, response.status === 201);
      assert.ok(!JSON.stringify(payload).includes('password'));
    }
    const rows = (await pool.query('SELECT * FROM users WHERE email = $1', ['concurrente@example.invalid'])).rows;
    assert.equal(rows.length, 1);
    assert.equal(await bcrypt.compare(valid.password, rows[0].password), true);
    assert.equal(inserts, 2);
  });

  await t.test('500 seguro ante un error PostgreSQL real que no es duplicado', async (context) => {
    const log = context.mock.method(console, 'error', () => {});
    // Restricción solo del fixture: fuerza un error con valores en error.detail.
    await pool.query("ALTER TABLE users ADD CONSTRAINT test_failure CHECK (name <> 'Fallo')");
    const post = await serve(context, service);
    const response = await post({ ...valid, name: 'Fallo', email: 'fallo@example.invalid' });
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { success: false, message: 'No se pudo completar la solicitud.' });
    assert.equal(log.mock.callCount(), 1);
    assert.doesNotMatch(log.mock.calls[0].arguments[0], /Fallo|password|test_failure|INSERT|\$2a\$/);
    assert.equal((await pool.query('SELECT count(*) FROM users')).rows[0].count, '2');
  });
});
