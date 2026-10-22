const assert = require('node:assert/strict');
const { test } = require('node:test');
const jwt = require('jsonwebtoken');
const { randomBytes } = require('node:crypto');
const { createAuthService, InvalidSessionError } = require('../src/services/auth.service');
const createTokenService = require('../src/services/token.service');
const createSessionRepository = require('../src/repositories/session.repository');
const createUserRepository = require('../src/repositories/user.repository');
const createAuthController = require('../src/controllers/auth.controller');
const loadAuthConfig = require('../src/config/auth');
const { testConfig, testEnvironment } = require('./helpers/auth-config');
const serve = require('./helpers/register-app');

const denied = { success: false, message: 'Sesión no válida.' };
const closed = { success: true, message: 'Sesión cerrada correctamente.' };
const publicUser = { id: 1, name: 'Juan', email: 'juan@example.invalid', created_at: new Date(0) };

function fixture(t, { failAt, rollbackFails = false, used = false, revoked = false, valid = true } = {}) {
  const config = testConfig();
  const tokens = createTokenService(config);
  const old = tokens.createRefreshToken();
  const calls = [];
  const failure = new Error('token hash cookie password SQL privado');
  const expiresAt = new Date(Date.now() + 60000);
  const client = {
    async query(sql, params) {
      const command = sql.trim().replace(/\s+/g, ' ');
      calls.push({ command, params });
      if (failAt && command.startsWith(failAt) || rollbackFails && command === 'ROLLBACK') throw failure;
      if (command.startsWith('SELECT id, user_id')) return { rows: [{ id: 2, user_id: 1 }] };
      if (command.startsWith('WITH instant')) return { rows: [{ used_at: used ? new Date() : null,
        revoked_at: revoked ? new Date() : null, valid,
        rotated_at: new Date().toISOString(), expires_at: expiresAt.toISOString() }] };
      return { rows: [{ expires_at: expiresAt }] };
    },
    release(error) { calls.push({ release: true, error }); },
  };
  const database = {
    async connect() {
      if (failAt === 'connect') throw failure;
      return client;
    },
    async query(sql, params) {
      calls.push({ command: sql.trim(), params });
      return { rows: [] };
    },
  };
  const issue = t.mock.method(tokens, 'createAccessToken');
  const service = createAuthService({}, createSessionRepository(database), tokens);
  return { config, tokens, old, calls, client, service, issue, expiresAt, failure };
}

function assertCleared(response) {
  const cookie = response.headers.get('set-cookie');
  assert.match(cookie, /^bitlearn_refresh=;/);
  for (const attribute of ['Path=/api/auth', 'HttpOnly', 'SameSite=Strict', 'Secure']) assert.ok(cookie.includes(attribute));
  assert.ok(Date.parse(cookie.match(/Expires=([^;]+)/)[1]) < Date.now());
  assert.doesNotMatch(cookie, /Domain=/);
}

test('refresh HTTP confirma antes de emitir, solo hash y cookie nueva; vencimiento limitado', async (t) => {
  const f = fixture(t);
  const post = await serve(t, f.service, { route: 'refresh', config: f.config });
  const response = await post(undefined, { headers: { Cookie: `otra=ok; bitlearn_refresh=${f.old.token}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(Object.keys(body.data).sort(), ['accessToken', 'expiresIn']);
  assert.equal(body.data.expiresIn, 900);
  assert.deepEqual(f.tokens.verifyAccessToken(body.data.accessToken), { userId: 1, sessionId: 2 });
  const cookie = response.headers.get('set-cookie');
  const next = cookie.match(/^bitlearn_refresh=([^;]+)/)[1];
  assert.notEqual(next, f.old.token);
  assert.ok(!JSON.stringify(body).includes(next));
  assert.ok(!JSON.stringify(f.calls).includes(next));
  assert.ok(Date.parse(cookie.match(/Expires=([^;]+)/)[1]) <= f.expiresAt.getTime());
  assert.equal(f.calls[0].command, 'BEGIN ISOLATION LEVEL READ COMMITTED');
  assert.match(f.calls[1].command, /FOR UPDATE$/);
  assert.match(f.calls[2].command, /^WITH instant/);
  assert.deepEqual(f.calls[3].params.slice(1), [f.old.tokenHash]);
  assert.equal(f.calls[4].params[0], f.tokens.hashRefreshToken(next));
  assert.equal(f.calls[4].params[2], f.calls[3].params[0]);
  assert.equal(f.calls[4].params[3], f.expiresAt.toISOString());
  assert.equal(f.calls.at(-2).command, 'COMMIT');
  assert.equal(f.calls.at(-1).release, true);
});

for (const [label, options] of [
  ['utilizado', { used: true }], ['revocado', { revoked: true }], ['expirado', { valid: false }],
]) {
  test(`refresh ${label}: 401 genérico, sin JWT, limpia cookie`, async (t) => {
    const f = fixture(t, options);
    const post = await serve(t, f.service, { route: 'refresh', config: f.config });
    const response = await post(undefined, { headers: { Cookie: `bitlearn_refresh=${f.old.token}` } });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), denied);
    assertCleared(response);
    assert.equal(f.issue.mock.callCount(), 0);
    assert.equal(f.calls.at(-2).command, 'COMMIT');
    assert.equal(f.calls.some(({ command }) => command?.startsWith('INSERT')), false);
    assert.equal(f.calls.some(({ command }) => command?.startsWith('UPDATE public.auth_sessions')), !!options.used);
  });
}

test('cookies ausentes, duplicadas, inválidas o mal formadas no identifican sesiones; otras fuentes no autentican', async (t) => {
  const f = fixture(t);
  const post = await serve(t, f.service, { route: 'refresh', config: f.config });
  for (const cookie of [undefined, '', 'otra=ok', 'bitlearn_refresh', 'bitlearn_refresh=',
    'bitlearn_refresh=%ZZ', 'bitlearn_refresh=%00', 'bitlearn_refresh=abc',
    `bitlearn_refresh=${'a'.repeat(44)}`, `bitlearn_refresh=${'A'.repeat(42)}B`,
    `bitlearn_refresh=${f.old.token}; bitlearn_refresh=${f.old.token}`,
    `bitlearn_refresh="${f.old.token}"`, `bitlearn_refresh=${f.old.token}; roto`]) {
    const response = await post({ refreshToken: f.old.token }, { headers: {
      ...(cookie === undefined ? {} : { Cookie: cookie }), 'X-Refresh-Token': f.old.token,
      Authorization: `Bearer ${f.old.token}`,
    } });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), denied);
    assertCleared(response);
  }
  const query = await serve(t, f.service, { route: `refresh?refreshToken=${f.old.token}`, config: f.config });
  assert.equal((await query()).status, 401);
  assert.equal(f.calls.length, 0);
  assert.equal(f.issue.mock.callCount(), 0);
});

for (const failAt of ['connect', 'BEGIN', 'SELECT id, user_id', 'WITH instant',
  'UPDATE public.auth_refresh_tokens', 'INSERT', 'COMMIT']) {
  test(`refresh fallo ${failAt}: rollback, sin credenciales y error seguro`, async (t) => {
    const log = t.mock.method(console, 'error', () => {});
    const f = fixture(t, { failAt });
    const post = await serve(t, f.service, { route: 'refresh', config: f.config });
    const response = await post(undefined, { headers: { Cookie: `bitlearn_refresh=${f.old.token}` } });
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), { success: false, message: 'No se pudo completar la solicitud.' });
    assert.equal(f.issue.mock.callCount(), 0);
    if (failAt !== 'connect') {
      assert.equal(f.calls.at(-2).command, 'ROLLBACK');
      assert.equal(f.calls.at(-1).release, true);
    }
    if (failAt === 'COMMIT') assert.equal(f.calls.at(-1).error, f.failure);
    assert.deepEqual(JSON.parse(log.mock.calls[0].arguments[0]), {
      level: 'error', event: 'request_failed', correlation_id: response.headers.get('x-correlation-id'),
    });
  });
}

test('refresh descarta conexión si falla rollback', async (t) => {
  const f = fixture(t, { failAt: 'INSERT', rollbackFails: true });
  await assert.rejects(f.service.refresh(f.old.token), f.failure);
  assert.equal(f.calls.at(-1).error, f.failure);
});

test('refresh no emite JWT/cookie/respuesta antes de COMMIT', async (t) => {
  const f = fixture(t);
  let confirm;
  let entered;
  const committing = new Promise((resolve) => { entered = resolve; });
  const confirmation = new Promise((resolve) => { confirm = resolve; });
  const original = f.client.query;
  t.mock.method(f.client, 'query', async (sql, params) => {
    if (sql === 'COMMIT') { entered(); await confirmation; }
    return original(sql, params);
  });
  let cookie = false;
  let response = false;
  const pending = createAuthController(f.service, f.config).refresh({ get: () => `bitlearn_refresh=${f.old.token}` }, {
    cookie() { cookie = true; }, status() { return this; }, json() { response = true; },
  }, (error) => { throw error; });
  await committing;
  assert.equal(f.issue.mock.callCount(), 0);
  assert.equal(cookie, false);
  assert.equal(response, false);
  confirm();
  await pending;
  assert.equal(f.issue.mock.callCount(), 1);
  assert.equal(cookie, true);
  assert.equal(response, true);
});

test('logout idempotente y uniforme, sin usar tokens de JSON ni borrar historial', async (t) => {
  const f = fixture(t);
  const post = await serve(t, f.service, { route: 'logout', config: f.config });
  for (const cookie of [undefined, 'bitlearn_refresh=%ZZ', `bitlearn_refresh=${f.old.token}`, `bitlearn_refresh=${f.old.token}`]) {
    const response = await post({ refreshToken: f.old.token }, { headers: cookie ? { Cookie: cookie } : {} });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await response.json(), closed);
    assertCleared(response);
  }
  assert.equal(f.calls.length, 2);
  for (const call of f.calls) {
    assert.match(call.command, /^UPDATE public.auth_sessions/);
    assert.deepEqual(call.params, [f.old.tokenHash]);
    assert.doesNotMatch(call.command, /DELETE|DROP|TRUNCATE/);
  }
});

test('logout limpia cookie pero devuelve 500 si no puede confirmar revocación', async (t) => {
  t.mock.method(console, 'error', () => {});
  const post = await serve(t, { async logout() { throw new Error('privado'); } }, { route: 'logout', config: testConfig() });
  const response = await post();
  assert.equal(response.status, 500);
  assertCleared(response);
});

test('me devuelve exclusivamente el perfil de la identidad verificada, ignorando ID suministrado', async (t) => {
  const config = testConfig();
  const tokens = createTokenService(config);
  const queries = [];
  const database = { async query(sql, params) {
    queries.push({ sql, params });
    return { rows: sql.includes('auth_sessions') ? [{ id: 2 }] : [{ ...publicUser, password: 'secreto', token_hash: 'privado' }] };
  } };
  const service = createAuthService(createUserRepository(database), createSessionRepository(database), tokens);
  const get = await serve(t, service, { route: 'me?id=999&userId=999', config });
  const response = await get(undefined, { method: 'GET', headers: { Authorization: `Bearer ${tokens.createAccessToken(1, 2).accessToken}` } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { success: true, data: { ...publicUser, created_at: publicUser.created_at.toISOString() } });
  assert.deepEqual(queries.map(({ params }) => params), [[2, 1], [1]]);
  assert.match(queries[0].sql, /revoked_at IS NULL/);
  assert.match(queries[0].sql, /expires_at > clock_timestamp/);
  assert.equal(queries[1].sql, 'SELECT id, name, email, created_at FROM public.users WHERE id = $1');
});

test('me rechaza JWT inválidos antes de consultar PostgreSQL y headers mal formados', async (t) => {
  const config = testConfig();
  const tokens = createTokenService(config);
  const now = Math.floor(Date.now() / 1000);
  const claims = { sub: '1', sid: '2', iat: now, exp: now + 900, iss: config.issuer, aud: config.audience };
  const sign = (payload, key = config.signingKey, algorithm = 'HS256') => jwt.sign(payload, key, { algorithm });
  const service = createAuthService({}, { isActive() { assert.fail('JWT inválido llegó a DB'); } }, tokens);
  const get = await serve(t, service, { route: 'me', config });
  const invalid = [
    sign({ ...claims, iat: now - 1000, exp: now - 100 }), sign(claims, randomBytes(32)),
    sign(claims, config.signingKey, 'HS384'), sign(claims, null, 'none'),
    sign({ ...claims, iss: 'otro' }), sign({ ...claims, aud: 'otro' }),
    sign({ ...claims, aud: [config.audience, 'otro'] }), sign({ ...claims, iat: now + 100 }),
    sign({ ...claims, exp: now + 901 }), sign({ ...claims, exp: now }),
    ...['sub', 'sid'].flatMap((field) => [0, 1, '', '0', '-1', '1.0', '01', '2147483648', '1;SELECT', null]
      .map((value) => sign({ ...claims, [field]: value }))),
    ...Object.keys(claims).map((field) => {
      const missing = { ...claims }; delete missing[field];
      return jwt.sign(missing, config.signingKey, { algorithm: 'HS256', noTimestamp: field === 'iat' });
    }),
  ];
  const good = sign(claims);
  for (const header of [undefined, ...invalid.map((value) => `Bearer ${value}`),
    `Basic ${good}`, `Bearer  ${good}`, `Bearer ${good}, Bearer ${good}`, `Bearer ${good} extra`,
    'Bearer abc', `Bearer ${good.slice(0, -5)}xxxxx`]) {
    const response = await get(undefined, { method: 'GET', headers: header === undefined ? {} : { Authorization: header } });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), denied);
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
  const query = await serve(t, service, { route: `me?accessToken=${good}`, config });
  assert.equal((await query(undefined, { method: 'GET' })).status, 401);
});

test('me rechaza sesión inactiva o usuario inexistente; fallos de DB no se ocultan como 401', async (t) => {
  const config = testConfig();
  const tokens = createTokenService(config);
  for (const [active, user, status] of [[false, publicUser, 401], [true, null, 401], ['error', publicUser, 500]]) {
    t.mock.method(console, 'error', () => {});
    const service = createAuthService({ async findPublicById() { return user; } }, {
      async isActive() { if (active === 'error') throw new Error('privado'); return active; },
    }, tokens);
    const get = await serve(t, service, { route: 'me', config });
    const response = await get(undefined, { method: 'GET', headers: { Authorization: `Bearer ${tokens.createAccessToken(1, 2).accessToken}` } });
    assert.equal(response.status, status);
  }
});

test('CSRF: solo orígenes explícitos; no confía en Host/proxy ni acepta null', async (t) => {
  const config = { ...testConfig(), trustedOrigins: ['https://frontend.example.invalid'] };
  for (const route of ['login', 'refresh', 'logout']) {
    const post = await serve(t, {
      async login() { throw new InvalidSessionError(); },
      async refresh() { throw new InvalidSessionError(); }, async logout() {},
    }, { route, config });
    for (const headers of [
      { Origin: 'null' }, { Origin: 'https://evil.example.invalid' },
      { Origin: 'https://frontend.example.invalid.evil.invalid' },
      { Origin: 'https://frontend.example.invalid/' },
      { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' },
      { Origin: 'https://evil.example.invalid', 'X-Forwarded-Host': 'evil.example.invalid', 'X-Forwarded-Proto': 'https' },
    ]) {
      const response = await post(undefined, { headers });
      assert.equal(response.status, 400);
      assert.equal(response.headers.get('set-cookie'), null);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { success: false, message: 'Origen de solicitud no permitido.' });
    }
    for (const headers of [{}, { 'Sec-Fetch-Site': 'same-origin' }, { Origin: config.trustedOrigins[0] }]) {
      const response = await post({ email: 'a@example.invalid', password: 'prueba' }, { headers });
      assert.equal(response.status, route === 'logout' ? 200 : 401);
    }
  }
});

test('configuración de orígenes rechaza comodines, rutas, credenciales y HTTP fuera de local', () => {
  for (const origin of ['*', 'null', 'https://example.com/', 'https://user:pass@example.com',
    'https://example.com/path', 'http://example.com', 'http://localhost:5173', 'file:///tmp']) {
    assert.throws(() => loadAuthConfig(testEnvironment({ AUTH_TRUSTED_ORIGINS: origin })));
  }
  assert.deepEqual(loadAuthConfig(testEnvironment({ AUTH_TRUSTED_ORIGINS: 'https://a.invalid, https://b.invalid' })).trustedOrigins,
    ['https://a.invalid', 'https://b.invalid']);
  assert.deepEqual(loadAuthConfig(testEnvironment({ NODE_ENV: 'development', AUTH_ALLOW_INSECURE_COOKIE: 'true',
    AUTH_TRUSTED_ORIGINS: 'http://localhost:5173' })).trustedOrigins, ['http://localhost:5173']);
});

test('refresh limita a 60 intentos/15 minutos, sin confiar en X-Forwarded-For', async (t) => {
  const f = fixture(t);
  const post = await serve(t, f.service, { route: 'refresh', config: f.config });
  for (let i = 0; i < 61; i++) {
    const response = await post(undefined, { headers: { 'X-Forwarded-For': `203.0.113.${i + 1}` } });
    assert.equal(response.status, i < 60 ? 401 : 429);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (i === 60) {
      assert.ok(Number(response.headers.get('retry-after')) > 0);
      assert.equal(response.headers.get('set-cookie'), null);
    }
    await response.json();
  }
  assert.equal(f.calls.length, 0);
});

test('Swagger publica contratos de sesiones con cookie/Bearer, sin users heredado', () => {
  const spec = require('../src/config/swagger');
  assert.equal(spec.components.securitySchemes.refreshCookie.in, 'cookie');
  assert.equal(spec.components.securitySchemes.refreshCookie.name, 'bitlearn_refresh');
  assert.equal(spec.components.securitySchemes.bearerAuth.scheme, 'bearer');
  for (const [route, method, codes, scheme] of [
    ['refresh', 'post', ['200', '400', '401', '429', '500'], 'refreshCookie'],
    ['logout', 'post', ['200', '400', '500'], 'refreshCookie'],
    ['me', 'get', ['200', '401', '500'], 'bearerAuth'],
  ]) {
    const operation = spec.paths[`/api/auth/${route}`][method];
    assert.deepEqual(Object.keys(operation.responses), codes);
    assert.deepEqual(operation.security[0], { [scheme]: [] });
    assert.equal(operation.requestBody, undefined);
  }
  assert.equal(spec.paths['/api/users'], undefined);
  assert.doesNotMatch(spec.paths['/api/auth/login'].post.description, /Aún no/);
});
