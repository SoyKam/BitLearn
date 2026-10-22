const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const createUserRepository = require('../src/repositories/user.repository');
const createSessionRepository = require('../src/repositories/session.repository');
const createTokenService = require('../src/services/token.service');
const { createAuthService } = require('../src/services/auth.service');
const { testConfig } = require('./helpers/auth-config');
const serve = require('./helpers/register-app');

// Sin db.js ni dotenv: solo un clúster propio, sin escucha TCP, en socket privado.
const postgresBin = process.env.POSTGRES_BIN || '/usr/lib/postgresql/16/bin';
const available = ['initdb', 'pg_ctl'].every((file) => fs.existsSync(path.join(postgresBin, file)));
const valid = { name: 'Login temporal', email: 'login@example.invalid', password: 'contraseña-temporal' };

test('login HTTP con PostgreSQL temporal aislado', {
  skip: available ? false : 'Falta PostgreSQL local; configura POSTGRES_BIN con initdb y pg_ctl.',
  timeout: 60000,
}, async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bitlearn-login-'));
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
    '-D', data, '-U', 'login_test', '--auth=trust', '--no-locale', '--encoding=UTF8',
  ], { stdio: 'pipe' });
  execFileSync(path.join(postgresBin, 'pg_ctl'), [
    '-D', data, '-l', path.join(temporary, 'postgres.log'),
    '-o', `-h '' -k ${socket} -p 55441`, '-w', 'start',
  ], { stdio: 'pipe' });
  started = true;
  pool = new Pool({ host: socket, port: 55441, user: 'login_test', password: '',
    database: 'postgres', ssl: false, max: 4 });
  for (const file of ['001_create_users.sql', '003_create_auth_sessions.sql']) {
    await pool.query(fs.readFileSync(path.join(__dirname, '../database/migrations', file), 'utf8'));
  }
  const config = testConfig();
  const service = createAuthService(createUserRepository(pool), createSessionRepository(pool), createTokenService(config));
  let user;
  await t.test('registro sigue sin crear sesión ni cookie', async (context) => {
    const post = await serve(context, service, { config });
    const response = await post(valid);
    assert.equal(response.status, 201);
    assert.equal(response.headers.get('set-cookie'), null);
    user = (await response.json()).data;
    assert.equal((await pool.query('SELECT count(*) FROM auth_sessions')).rows[0].count, '0');
  });

  await t.test('persiste sesión y solo hash, comparte expiración, admite sesiones independientes', async (context) => {
    const post = await serve(context, service, { route: 'login', config });
    const sessionIds = [];
    const refreshTokens = [];
    for (let i = 0; i < 2; i++) {
      const response = await post({ email: ' LOGIN@Example.INVALID ', password: valid.password });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.deepEqual(body.data.user, { id: user.id, name: user.name, email: user.email });
      const claims = jwt.verify(body.data.accessToken, config.signingKey,
        { algorithms: ['HS256'], issuer: config.issuer, audience: config.audience });
      sessionIds.push(claims.sid);
      const cookie = response.headers.get('set-cookie');
      const refresh = cookie.match(/^bitlearn_refresh=([^;]+)/)[1];
      refreshTokens.push(refresh);
      const session = (await pool.query('SELECT * FROM auth_sessions WHERE id = $1', [claims.sid])).rows[0];
      const token = (await pool.query('SELECT * FROM auth_refresh_tokens WHERE session_id = $1', [claims.sid])).rows[0];
      assert.equal(session.user_id, user.id);
      assert.equal(session.revoked_at, null);
      assert.equal(token.used_at, null);
      assert.equal(token.token_hash, createHash('sha256').update(refresh).digest('hex'));
      assert.equal(session.expires_at.getTime(), token.expires_at.getTime());
      assert.equal(session.created_at.getTime(), token.created_at.getTime());
      assert.equal(session.expires_at - session.created_at, 604800000);
      assert.ok(!JSON.stringify({ session, token, body }).includes(refresh));
      const cookieExpiry = Date.parse(cookie.match(/Expires=([^;]+)/)[1]);
      assert.ok(cookieExpiry <= token.expires_at.getTime());
      assert.ok(token.expires_at - cookieExpiry < 2000);
    }
    assert.notEqual(sessionIds[0], sessionIds[1]);
    assert.notEqual(refreshTokens[0], refreshTokens[1]);
    assert.equal((await pool.query('SELECT count(*) FROM auth_sessions')).rows[0].count, '2');
    assert.equal((await pool.query('SELECT count(*) FROM auth_refresh_tokens')).rows[0].count, '2');
    assert.equal(pool.idleCount, pool.totalCount);
  });

  for (const table of ['auth_sessions', 'auth_refresh_tokens']) {
    await t.test(`rollback real al fallar INSERT en ${table}; sin tokens ni filas parciales`, async (context) => {
      context.mock.method(console, 'error', () => {});
      // Solo en este clúster desechable: permite filas anteriores y rechaza nuevas.
      await pool.query(`ALTER TABLE ${table} ADD CONSTRAINT test_failure CHECK (false) NOT VALID`);
      try {
        const post = await serve(context, service, { route: 'login', config });
        const response = await post({ email: valid.email, password: valid.password });
        assert.equal(response.status, 500);
        assert.equal(response.headers.get('set-cookie'), null);
        assert.deepEqual(await response.json(), { success: false, message: 'No se pudo completar la solicitud.' });
        assert.equal((await pool.query('SELECT count(*) FROM auth_sessions')).rows[0].count, '2');
        assert.equal((await pool.query('SELECT count(*) FROM auth_refresh_tokens')).rows[0].count, '2');
        assert.equal(pool.idleCount, pool.totalCount);
      } finally {
        await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT test_failure`);
      }
    });
  }

  await t.test('credenciales incorrectas no crean sesiones', async (context) => {
    const post = await serve(context, service, { route: 'login', config });
    for (const credentials of [
      { email: valid.email, password: 'incorrecta' },
      { email: 'inexistente@example.invalid', password: valid.password },
    ]) {
      const response = await post(credentials);
      assert.equal(response.status, 401);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.deepEqual(await response.json(), { success: false, message: 'Credenciales incorrectas.' });
    }
    assert.equal((await pool.query('SELECT count(*) FROM auth_sessions')).rows[0].count, '2');
  });
});
