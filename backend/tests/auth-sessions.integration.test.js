const assert = require('node:assert/strict');
const { test } = require('node:test');
const { execFileSync } = require('node:child_process');
const { setTimeout: delay } = require('node:timers/promises');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');
const createUserRepository = require('../src/repositories/user.repository');
const createSessionRepository = require('../src/repositories/session.repository');
const createTokenService = require('../src/services/token.service');
const { createAuthService } = require('../src/services/auth.service');
const { testConfig } = require('./helpers/auth-config');
const serve = require('./helpers/register-app');

// Nunca importa db.js/dotenv: crea exclusivamente un clúster propio por socket privado.
const postgresBin = process.env.POSTGRES_BIN || '/usr/lib/postgresql/16/bin';
const available = ['initdb', 'pg_ctl'].every((file) => fs.existsSync(path.join(postgresBin, file)));

test('sesiones HTTP con PostgreSQL temporal: rotación, concurrencia y revocación real', {
  skip: available ? false : 'Falta PostgreSQL local; configura POSTGRES_BIN con initdb y pg_ctl.',
  timeout: 60000,
}, async (t) => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bitlearn-sessions-'));
  const data = path.join(temporary, 'data');
  const socket = path.join(temporary, 'socket');
  fs.mkdirSync(socket, { mode: 0o700 });
  let started = false;
  let pool;
  t.after(async () => {
    try { if (pool) await pool.end(); } finally {
      if (started) execFileSync(path.join(postgresBin, 'pg_ctl'),
        ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });
  execFileSync(path.join(postgresBin, 'initdb'), [
    '-D', data, '-U', 'sessions_test', '--auth=trust', '--no-locale', '--encoding=UTF8',
  ], { stdio: 'pipe' });
  execFileSync(path.join(postgresBin, 'pg_ctl'), [
    '-D', data, '-l', path.join(temporary, 'postgres.log'),
    '-o', `-h '' -k ${socket} -p 55442`, '-w', 'start',
  ], { stdio: 'pipe' });
  started = true;
  pool = new Pool({ host: socket, port: 55442, user: 'sessions_test', password: '',
    database: 'postgres', ssl: false, max: 8, application_name: 'bitlearn-sessions-test' });
  for (const file of ['001_create_users.sql', '003_create_auth_sessions.sql']) {
    await pool.query(fs.readFileSync(path.join(__dirname, '../database/migrations', file), 'utf8'));
  }
  const config = testConfig();
  const tokens = createTokenService(config);
  const sessions = createSessionRepository(pool);
  const service = createAuthService(createUserRepository(pool), sessions, tokens);
  const user = await service.register({ name: 'Sesiones', email: 'session@example.invalid', password: 'contraseña-temporal' });
  const other = await service.register({ name: 'Otro', email: 'other@example.invalid', password: 'contraseña-temporal' });
  const cookie = (token) => ({ Cookie: `bitlearn_refresh=${token}` });
  const bearer = (token) => ({ method: 'GET', headers: { Authorization: `Bearer ${token}` } });
  const readCookie = (response) => response.headers.get('set-cookie').match(/^bitlearn_refresh=([^;]+)/)[1];
  const state = async (id) => ({
    session: (await pool.query('SELECT * FROM auth_sessions WHERE id = $1', [id])).rows[0],
    tokens: (await pool.query('SELECT * FROM auth_refresh_tokens WHERE session_id = $1 ORDER BY created_at, token_hash', [id])).rows,
  });
  async function seed({ userId = user.id, age = 1000, remaining = 60000 } = {}) {
    const token = tokens.createRefreshToken();
    const createdAt = new Date(Date.now() - age);
    const expiresAt = new Date(Date.now() + remaining);
    const id = await sessions.create({ userId, tokenHash: token.tokenHash, createdAt, expiresAt });
    return { id, token: token.token, tokenHash: token.tokenHash, expiresAt,
      access: tokens.createAccessToken(userId, id).accessToken };
  }

  await t.test('renueva y consume exactamente un hash; identidad pública, expiración fija y reutilización revoca', async (context) => {
    const first = await seed();
    const post = await serve(context, service, { route: 'refresh', config });
    const get = await serve(context, service, { route: 'me?id=999', config });
    const before = await state(first.id);
    const response = await post(undefined, { headers: cookie(first.token) });
    assert.equal(response.status, 200);
    const next = readCookie(response);
    assert.notEqual(next, first.token);
    const body = await response.json();
    assert.deepEqual(Object.keys(body.data).sort(), ['accessToken', 'expiresIn']);
    assert.deepEqual(tokens.verifyAccessToken(body.data.accessToken), { userId: user.id, sessionId: first.id });
    const after = await state(first.id);
    assert.deepEqual(after.session, before.session);
    assert.equal(after.tokens.length, 2);
    const used = after.tokens.find((row) => row.token_hash === first.tokenHash);
    const active = after.tokens.find((row) => row.token_hash === tokens.hashRefreshToken(next));
    assert.ok(used.used_at instanceof Date);
    assert.equal(active.used_at, null);
    assert.equal(active.created_at.getTime(), used.used_at.getTime());
    assert.equal(active.expires_at.getTime(), first.expiresAt.getTime());
    assert.ok(!JSON.stringify(after).includes(next));
    assert.ok(!JSON.stringify(body).includes(next));
    const me = await get(undefined, bearer(body.data.accessToken));
    assert.equal(me.status, 200);
    assert.deepEqual((await me.json()).data, JSON.parse(JSON.stringify(user)));
    const replay = await post(undefined, { headers: cookie(first.token) });
    assert.equal(replay.status, 401);
    assert.match(replay.headers.get('set-cookie'), /^bitlearn_refresh=;/);
    // Lectura fuera de la transacción prueba que el 401 no revirtió la revocación.
    const revoked = await state(first.id);
    assert.ok(revoked.session.revoked_at instanceof Date);
    assert.deepEqual(revoked.tokens, after.tokens);
    assert.equal((await post(undefined, { headers: cookie(next) })).status, 401);
    assert.equal((await get(undefined, bearer(body.data.accessToken))).status, 401);
    assert.equal((await get(undefined, bearer(first.access))).status, 401);
  });

  for (const kind of ['sesión expirada', 'token expirado', 'sesión revocada', 'desconocido']) {
    await t.test(`rechaza ${kind} sin crear credenciales ni cambiar otras sesiones`, async (context) => {
      const first = await seed(kind === 'sesión expirada' ? { age: 10000, remaining: -1000 } : { age: 10000 });
      if (kind === 'token expirado') await pool.query(
        "UPDATE auth_refresh_tokens SET expires_at = clock_timestamp() - interval '1 second' WHERE token_hash = $1", [first.tokenHash]);
      if (kind === 'sesión revocada') await sessions.revokeByTokenHash(first.tokenHash);
      const before = await state(first.id);
      const post = await serve(context, service, { route: 'refresh', config });
      const received = kind === 'desconocido' ? tokens.createRefreshToken().token : first.token;
      const response = await post(undefined, { headers: cookie(received) });
      assert.equal(response.status, 401);
      assert.match(response.headers.get('set-cookie'), /^bitlearn_refresh=;/);
      assert.deepEqual(await response.json(), { success: false, message: 'Sesión no válida.' });
      assert.deepEqual(await state(first.id), before);
      if (kind === 'sesión expirada' || kind === 'sesión revocada') {
        const get = await serve(context, service, { route: 'me', config });
        assert.equal((await get(undefined, bearer(first.access))).status, 401);
      }
    });
  }

  await t.test('logout revoca solo una sesión, conserva historial y es idempotente', async (context) => {
    const first = await seed();
    const second = await seed();
    const before = await state(first.id);
    const independent = await state(second.id);
    const logout = await serve(context, service, { route: 'logout', config });
    const refresh = await serve(context, service, { route: 'refresh', config });
    const get = await serve(context, service, { route: 'me', config });
    for (const received of [first.token, first.token, undefined, 'invalido', tokens.createRefreshToken().token]) {
      const response = await logout(undefined, { headers: received ? cookie(received) : {} });
      assert.equal(response.status, 200);
      assert.match(response.headers.get('set-cookie'), /^bitlearn_refresh=;/);
      assert.deepEqual(await response.json(), { success: true, message: 'Sesión cerrada correctamente.' });
    }
    const after = await state(first.id);
    assert.ok(after.session.revoked_at instanceof Date);
    assert.deepEqual(after.tokens, before.tokens);
    assert.deepEqual(await state(second.id), independent);
    assert.equal((await refresh(undefined, { headers: cookie(first.token) })).status, 401);
    assert.equal((await get(undefined, bearer(first.access))).status, 401);
    assert.equal((await get(undefined, bearer(second.access))).status, 200);
    assert.equal((await refresh(undefined, { headers: cookie(second.token) })).status, 200);
  });

  await t.test('logout con hash consumido identifica y revoca la misma sesión', async (context) => {
    const first = await seed();
    const rotated = await service.refresh(first.token);
    const logout = await serve(context, service, { route: 'logout', config });
    assert.equal((await logout(undefined, { headers: cookie(first.token) })).status, 200);
    assert.ok((await state(first.id)).session.revoked_at);
    await assert.rejects(service.refresh(rotated.refreshToken));
  });

  await t.test('me verifica que sid pertenece a sub; no acepta identidad del cliente', async (context) => {
    const first = await seed();
    const get = await serve(context, service, { route: `me?userId=${other.id}`, config });
    for (const access of [tokens.createAccessToken(other.id, first.id).accessToken,
      tokens.createAccessToken(user.id, 2147483647).accessToken]) {
      const response = await get(undefined, bearer(access));
      assert.equal(response.status, 401);
      assert.deepEqual(await response.json(), { success: false, message: 'Sesión no válida.' });
    }
    const response = await get(undefined, bearer(first.access));
    assert.equal(response.status, 200);
    assert.equal((await response.json()).data.id, user.id);
  });

  for (const phase of ['UPDATE', 'INSERT', 'COMMIT']) {
    await t.test(`rollback real al fallar ${phase}: token anterior intacto, sin JWT ni cookie`, async (context) => {
      context.mock.method(console, 'error', () => {});
      const first = await seed();
      const before = await state(first.id);
      const issue = context.mock.method(tokens, 'createAccessToken');
      if (phase === 'COMMIT') {
        // Trigger diferido: permite UPDATE e INSERT; falla al confirmar la transacción.
        await pool.query(`CREATE FUNCTION fail_rotation_commit() RETURNS trigger LANGUAGE plpgsql AS $$
          BEGIN RAISE EXCEPTION 'fallo temporal'; END $$`);
        await pool.query(`CREATE CONSTRAINT TRIGGER fail_rotation_commit
          AFTER INSERT ON auth_refresh_tokens DEFERRABLE INITIALLY DEFERRED
          FOR EACH ROW EXECUTE FUNCTION fail_rotation_commit()`);
      } else if (phase === 'INSERT') {
        // Solo la nueva fila falla; consumir el token anterior sí alcanza PostgreSQL.
        await pool.query('ALTER TABLE auth_refresh_tokens ADD CONSTRAINT fail_insert CHECK (used_at IS NOT NULL) NOT VALID');
      } else {
        await pool.query('ALTER TABLE auth_refresh_tokens ADD CONSTRAINT fail_update CHECK (used_at IS NULL) NOT VALID');
      }
      try {
        const post = await serve(context, service, { route: 'refresh', config });
        const response = await post(undefined, { headers: cookie(first.token) });
        assert.equal(response.status, 500);
        assert.equal(response.headers.get('set-cookie'), null);
        assert.deepEqual(await response.json(), { success: false, message: 'No se pudo completar la solicitud.' });
        assert.equal(issue.mock.callCount(), 0);
        assert.deepEqual(await state(first.id), before);
      } finally {
        if (phase === 'COMMIT') {
          await pool.query('DROP TRIGGER fail_rotation_commit ON auth_refresh_tokens');
          await pool.query('DROP FUNCTION fail_rotation_commit()');
        } else await pool.query(`ALTER TABLE auth_refresh_tokens DROP CONSTRAINT fail_${phase.toLowerCase()}`);
      }
      const success = await service.refresh(first.token);
      assert.ok(success.accessToken);
    });
  }

  async function waitForBlocked(count, blockerPid) {
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      // pg_blocking_pids incluye esperas detrás de otro solicitante del mismo bloqueo.
      const { rows } = await pool.query(`SELECT pid FROM pg_stat_activity
        WHERE application_name = 'bitlearn-sessions-test'
          AND wait_event_type = 'Lock' AND pid <> $1`, [blockerPid]);
      if (rows.length >= count) return;
      await delay(10);
    }
    assert.fail('Las solicitudes no llegaron al bloqueo PostgreSQL esperado');
  }

  await t.test('dos refresh concurrentes esperan bloqueo real; solo uno rota y el segundo revoca', async (context) => {
    const first = await seed();
    const post = await serve(context, service, { route: 'refresh', config });
    const blocker = await pool.connect();
    let pending = [];
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM auth_sessions WHERE id = $1 FOR UPDATE', [first.id]);
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = [post(undefined, { headers: cookie(first.token) }), post(undefined, { headers: cookie(first.token) })];
      await waitForBlocked(2, pid);
      await blocker.query('COMMIT');
      const responses = await Promise.all(pending);
      assert.deepEqual(responses.map((r) => r.status).sort(), [200, 401]);
      const success = responses.find((r) => r.status === 200);
      const next = readCookie(success);
      const access = (await success.json()).data.accessToken;
      const after = await state(first.id);
      assert.equal(after.tokens.length, 2);
      assert.equal(after.tokens.filter((row) => row.used_at === null).length, 1);
      assert.ok(after.session.revoked_at);
      // Queda un hash no consumido, pero cero tokens autorizados por la sesión revocada.
      assert.equal((await post(undefined, { headers: cookie(next) })).status, 401);
      await assert.rejects(service.authenticate(access));
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await Promise.allSettled(pending);
    }
  });

  await t.test('refresh esperando bloqueo reevalúa expiración con hora posterior a la espera', async (context) => {
    const first = await seed();
    const post = await serve(context, service, { route: 'refresh', config });
    const blocker = await pool.connect();
    let pending;
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM auth_sessions WHERE id = $1 FOR UPDATE', [first.id]);
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = post(undefined, { headers: cookie(first.token) });
      await waitForBlocked(1, pid);
      // Expira DESPUÉS del inicio de la transacción que espera: now() sería obsoleto.
      await blocker.query('UPDATE auth_sessions SET expires_at = clock_timestamp() WHERE id = $1', [first.id]);
      await blocker.query('COMMIT');
      const response = await pending;
      assert.equal(response.status, 401);
      const after = await state(first.id);
      assert.equal(after.tokens.length, 1);
      assert.equal(after.tokens[0].used_at, null);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      if (pending) await pending;
    }
  });

  await t.test('refresh y logout concurrentes no pueden dejar la sesión activa', async (context) => {
    const first = await seed();
    const refresh = await serve(context, service, { route: 'refresh', config });
    const logout = await serve(context, service, { route: 'logout', config });
    const blocker = await pool.connect();
    let pending = [];
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM auth_sessions WHERE id = $1 FOR UPDATE', [first.id]);
      const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
      pending = [refresh(undefined, { headers: cookie(first.token) }), logout(undefined, { headers: cookie(first.token) })];
      await waitForBlocked(2, pid);
      await blocker.query('COMMIT');
      const [renewed, closed] = await Promise.all(pending);
      assert.ok([200, 401].includes(renewed.status));
      assert.equal(closed.status, 200);
      assert.ok((await state(first.id)).session.revoked_at);
      await assert.rejects(service.authenticate(first.access));
      if (renewed.status === 200) {
        await assert.rejects(service.refresh(readCookie(renewed)));
        await assert.rejects(service.authenticate((await renewed.json()).data.accessToken));
      }
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await Promise.allSettled(pending);
    }
  });

  assert.equal(pool.idleCount, pool.totalCount);
});
