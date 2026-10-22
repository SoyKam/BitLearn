const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomBytes, createHash } = require('node:crypto');
const { once } = require('node:events');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const loadAuthConfig = require('../src/config/auth');
const createTokenService = require('../src/services/token.service');
const { createAuthService } = require('../src/services/auth.service');
const createUserRepository = require('../src/repositories/user.repository');
const createSessionRepository = require('../src/repositories/session.repository');
const createAuthController = require('../src/controllers/auth.controller');
const serve = require('./helpers/register-app');
const { testConfig, testEnvironment } = require('./helpers/auth-config');

const valid = { email: 'juan@example.com', password: ' contraseña-de-prueba ' };
const publicUser = { id: 1, name: 'Juan Pérez', email: valid.email };
const passwordHash = bcrypt.hash(valid.password, 10);

async function fixture(t, { missing = false, failAt, rollbackFails = false, config = testConfig() } = {}) {
  const calls = [];
  const hash = await passwordHash;
  const failure = new Error('SELECT password secret token host=private');
  const client = {
    async query(sql, params) {
      calls.push({ sql, params });
      if (sql === failAt || (failAt && sql.startsWith(failAt))
        || (rollbackFails && sql === 'ROLLBACK')) throw failure;
      return { rows: [{ id: 42 }] };
    },
    release(error) { calls.push({ release: true, error }); },
  };
  const database = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: missing ? [] : [{ ...publicUser, password: hash, private_field: 'private' }] };
    },
    async connect() {
      calls.push({ connect: true });
      if (failAt === 'connect') throw failure;
      return client;
    },
  };
  const tokens = createTokenService(config);
  const issue = t.mock.method(tokens, 'createAccessToken');
  const service = createAuthService(createUserRepository(database), createSessionRepository(database), tokens);
  const post = await serve(t, service, { route: 'login', config });
  return { post, calls, issue, config, failure };
}

test('login: normaliza email, verifica bcrypt, confirma transacción y devuelve campos públicos', async (t) => {
  const { post, calls, issue, config } = await fixture(t);
  const response = await post({ ...valid, email: ' JUAN@Example.COM ' });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const body = await response.json();
  assert.deepEqual(Object.keys(body.data).sort(), ['accessToken', 'expiresIn', 'user']);
  assert.deepEqual(body.data.user, publicUser);
  assert.equal(body.data.expiresIn, 900);
  const claims = jwt.verify(body.data.accessToken, config.signingKey,
    { algorithms: ['HS256'], issuer: config.issuer, audience: config.audience });
  assert.equal(claims.sub, '1');
  assert.equal(claims.sid, '42');
  assert.equal(claims.exp - claims.iat, 900);
  assert.ok(Math.abs(claims.iat - Date.now() / 1000) < 5);
  assert.deepEqual(Object.keys(claims).sort(), ['aud', 'exp', 'iat', 'iss', 'sid', 'sub']);
  assert.equal(jwt.decode(body.data.accessToken, { complete: true }).header.alg, 'HS256');
  for (const options of [
    { clockTimestamp: claims.exp }, { issuer: 'incorrecto' }, { audience: 'incorrecto' }, { algorithms: ['HS512'] },
  ]) assert.throws(() => jwt.verify(body.data.accessToken, config.signingKey,
    { algorithms: ['HS256'], issuer: config.issuer, audience: config.audience, ...options }));
  assert.throws(() => jwt.verify(body.data.accessToken, randomBytes(32), { algorithms: ['HS256'] }));

  const cookie = response.headers.get('set-cookie');
  const refresh = cookie.match(/^bitlearn_refresh=([^;]+)/)[1];
  assert.match(refresh, /^[A-Za-z0-9_-]{43}$/);
  for (const attribute of ['HttpOnly', 'SameSite=Strict', 'Secure', 'Path=/api/auth']) {
    assert.ok(cookie.includes(attribute));
  }
  assert.doesNotMatch(cookie, /Domain=/i);
  assert.ok(!JSON.stringify(body).includes(refresh));
  assert.ok(!JSON.stringify(calls).includes(refresh));
  assert.deepEqual(calls[0], { sql: 'SELECT id, name, email, password FROM public.users WHERE email = $1',
    params: [valid.email] });
  assert.equal(calls[1].connect, true);
  assert.deepEqual(calls.slice(2, 6).map(({ sql }) => sql.split(' ')[0]), ['BEGIN', 'INSERT', 'INSERT', 'COMMIT']);
  assert.equal(calls[6].release, true);
  const [session, token] = calls.slice(3, 5);
  assert.deepEqual(session.params, [1, token.params[2], token.params[3]]);
  assert.equal(token.params[0], createHash('sha256').update(refresh).digest('hex'));
  assert.equal(token.params[1], 42);
  assert.equal(token.params[3] - token.params[2], 604800000);
  const maxAge = Number(cookie.match(/Max-Age=(\d+)/)[1]);
  assert.ok(maxAge <= 604800 && maxAge >= 604795);
  assert.ok(Math.abs(Date.now() + maxAge * 1000 - token.params[3]) < 2000);
  assert.equal(issue.mock.callCount(), 1);
});

test('401 idéntico para correo inexistente y contraseña incorrecta; bcrypt en ambos casos', async (t) => {
  const compare = t.mock.method(bcrypt, 'compare');
  const responses = [];
  for (const missing of [false, true]) {
    const { post, calls, issue } = await fixture(t, { missing });
    const response = await post({ ...valid, password: 'incorrecta' });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get('set-cookie'), null);
    responses.push(await response.json());
    assert.equal(calls.length, 1);
    assert.equal(issue.mock.callCount(), 0);
  }
  assert.deepEqual(responses, Array(2).fill({ success: false, message: 'Credenciales incorrectas.' }));
  assert.equal(compare.mock.callCount(), 2);
  for (const call of compare.mock.calls) {
    assert.equal(call.arguments[0], 'incorrecta');
    assert.equal(bcrypt.getRounds(call.arguments[1]), 10);
  }
});

test('no recorta ni normaliza la contraseña', async (t) => {
  const { post } = await fixture(t);
  for (const password of [valid.password.trim(), valid.password.normalize('NFD')]) {
    const response = await post({ ...valid, password });
    assert.equal(response.status, 401);
    await response.json();
  }
});

test('no emite JWT, cookie ni respuesta mientras COMMIT está pendiente', async (t) => {
  let confirm;
  let entered;
  const committing = new Promise((resolve) => { entered = resolve; });
  const confirmation = new Promise((resolve) => { confirm = resolve; });
  const config = testConfig();
  const tokens = createTokenService(config);
  const issue = t.mock.method(tokens, 'createAccessToken');
  const hash = await passwordHash;
  const service = createAuthService({ async findByEmail() { return { ...publicUser, password: hash }; } },
    createSessionRepository({ async connect() {
      return {
        async query(sql) {
          if (sql === 'COMMIT') { entered(); await confirmation; }
          return { rows: [{ id: 42 }] };
        }, release() {},
      };
    } }), tokens);
  let cookie = false;
  let response = false;
  const pending = createAuthController(service, config).login({ body: valid }, {
    cookie() { cookie = true; }, status() { return this; }, json() { response = true; },
  }, (error) => { throw error; });
  await committing;
  assert.equal(issue.mock.callCount(), 0);
  assert.equal(cookie, false);
  assert.equal(response, false);
  confirm();
  await pending;
  assert.equal(cookie, true);
  assert.equal(response, true);
  assert.equal(issue.mock.callCount(), 1);
});

test('valida claves heredadas breves y el límite de 72 bytes sin transformarlas', async (t) => {
  for (const password of ['x', ` ${'é'.repeat(35)} `]) {
    let received;
    const post = await serve(t, { async login(input) {
      received = input;
      return { user: publicUser, accessToken: 'solo-prueba', expiresIn: 900,
        refreshToken: 'solo-prueba', refreshExpiresAt: new Date(Date.now() + 60000) };
    } }, { route: 'login' });
    const response = await post({ ...valid, password });
    assert.equal(response.status, 200);
    await response.json();
    assert.equal(received.password, password);
  }
});

const invalid = [
  {}, { email: valid.email }, { password: valid.password }, { ...valid, role: 'admin' },
  { ...valid, 'secreto-no-reflejar': true }, [], null, 'secreto-no-reflejar', 1,
  ...['', 'incorrecto', 42, null, {}, [], `${'a'.repeat(140)}@example.com`].map((email) => ({ ...valid, email })),
  ...['', 42, null, {}, [], 'a'.repeat(73), 'é'.repeat(37), 'abc\u0000def']
    .map((password) => ({ ...valid, password })),
];
for (const [index, body] of invalid.entries()) {
  test(`login 400: validación estricta ${index}`, async (t) => {
    let calls = 0;
    const post = await serve(t, { async login() { calls++; } }, { route: 'login' });
    const response = await post(body);
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.doesNotMatch(JSON.stringify(await response.json()), /secreto-no-reflejar|stack|ZodError/);
    assert.equal(calls, 0);
  });
}

for (const [label, body, headers] of [
  ['JSON inválido', '{"password":', {}], ['vacío', '', {}],
  ['grande', JSON.stringify({ ...valid, password: 'a'.repeat(5000) }), {}],
  ['tipo', JSON.stringify(valid), { 'Content-Type': 'text/plain' }],
  ['comprimido', JSON.stringify(valid), { 'Content-Encoding': 'gzip' }],
]) {
  test(`login 400 parser: ${label}`, async (t) => {
    const post = await serve(t, { login() { assert.fail('No ejecutar servicio'); } }, { route: 'login' });
    const response = await post(body, { raw: true, headers });
    assert.equal(response.status, 400);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal((await response.json()).success, false);
  });
}

for (const failAt of ['connect', 'BEGIN', 'INSERT INTO public.auth_sessions', 'INSERT INTO public.auth_refresh_tokens', 'COMMIT']) {
  test(`fallo en ${failAt}: sin tokens, rollback y liberación`, async (t) => {
    const log = t.mock.method(console, 'error', () => {});
    const { post, calls, issue } = await fixture(t, { failAt });
    const response = await post(valid);
    assert.equal(response.status, 500);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.deepEqual(await response.json(), { success: false, message: 'No se pudo completar la solicitud.' });
    assert.equal(issue.mock.callCount(), 0);
    if (failAt !== 'connect') {
      assert.equal(calls.at(-2).sql, 'ROLLBACK');
      assert.equal(calls.at(-1).release, true);
    }
    assert.deepEqual(JSON.parse(log.mock.calls[0].arguments[0]), {
      level: 'error', event: 'request_failed', correlation_id: response.headers.get('x-correlation-id'),
    });
  });
}

test('descarta el cliente si también falla ROLLBACK', async (t) => {
  t.mock.method(console, 'error', () => {});
  const { post, calls, failure } = await fixture(t, { failAt: 'COMMIT', rollbackFails: true });
  const response = await post(valid);
  assert.equal(response.status, 500);
  await response.json();
  assert.equal(calls.at(-1).error, failure);
});

test('429 tras 20 intentos, aun falsificando encabezados de proxy', async (t) => {
  const post = await serve(t, { login() { assert.fail('No ejecutar servicio'); } }, { route: 'login' });
  for (let i = 0; i < 21; i++) {
    const response = await post('{', { raw: true, headers: {
      'X-Forwarded-For': `203.0.113.${i + 1}`, Forwarded: `for=203.0.113.${i + 1}`,
      'X-Forwarded-Proto': 'https',
    } });
    assert.equal(response.status, i < 20 ? 400 : 429);
    const body = await response.json();
    if (i === 20) {
      assert.ok(Number(response.headers.get('retry-after')) > 0);
      assert.ok(response.headers.get('ratelimit'));
      assert.deepEqual(body, { success: false, message: 'Demasiados intentos de inicio de sesión. Inténtalo más tarde.' });
    }
  }
});

test('configuración rechaza claves ausentes/débiles y opciones inseguras sin reflejar secretos', () => {
  for (const value of [undefined, '', 'password', 'ab'.repeat(32), '0123456789abcdef'.repeat(4), 'z'.repeat(64), randomBytes(31).toString('hex')]) {
    assert.throws(() => loadAuthConfig(testEnvironment({ AUTH_JWT_SECRET_HEX: value })), /AUTH_JWT_SECRET_HEX/);
  }
  for (const env of [
    { AUTH_JWT_ISSUER: '' }, { AUTH_JWT_AUDIENCE: 'aud\nience' },
    { AUTH_ALLOW_INSECURE_COOKIE: '0' },
    { NODE_ENV: 'production', AUTH_ALLOW_INSECURE_COOKIE: 'true' },
    { NODE_ENV: undefined, AUTH_ALLOW_INSECURE_COOKIE: 'true' },
    { NODE_ENV: 'development', CODESPACES: 'true', AUTH_ALLOW_INSECURE_COOKIE: 'true' },
  ]) assert.throws(() => loadAuthConfig(testEnvironment(env)));
  assert.equal(loadAuthConfig(testEnvironment({ NODE_ENV: 'production' })).cookieSecure, true);
});

test('cookie Secure por defecto, producción y Codespaces; excepción solo HTTP local', async (t) => {
  for (const env of [
    {}, { NODE_ENV: 'production' }, { NODE_ENV: 'development', CODESPACES: 'true' },
    { NODE_ENV: 'development', AUTH_ALLOW_INSECURE_COOKIE: 'true' },
  ]) {
    const config = loadAuthConfig(testEnvironment(env));
    const { post } = await fixture(t, { config });
    const response = await post(valid, { headers: { 'X-Forwarded-Proto': 'http' } });
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('set-cookie').includes('; Secure'), config.cookieSecure);
    await response.json();
  }
});

test('HTTPS directo conserva Secure incluso con excepción HTTP local', async () => {
  let options;
  const controller = createAuthController({ async login() {
    return { user: publicUser, accessToken: 'solo-prueba', expiresIn: 900,
      refreshToken: 'solo-prueba', refreshExpiresAt: new Date(Date.now() + 60000) };
  } }, { cookieSecure: false });
  await controller.login({ secure: true, body: valid }, {
    cookie(_name, _value, value) { options = value; },
    status() { return this; }, json() {},
  }, (error) => { throw error; });
  assert.equal(options.secure, true);
});

test('tokens opacos independientes con hashes SHA-256 y expiración común', () => {
  const tokens = createTokenService(testConfig());
  const first = tokens.createRefreshToken();
  const second = tokens.createRefreshToken();
  assert.notEqual(first.token, second.token);
  assert.notEqual(first.tokenHash, second.tokenHash);
  assert.equal(first.tokenHash, createHash('sha256').update(first.token).digest('hex'));
  assert.equal(first.expiresAt - first.createdAt, 604800000);
});

test('aplicación real monta login y Swagger conserva contratos anteriores', async (t) => {
  Object.assign(process.env, testEnvironment());
  const pool = require('../src/config/db');
  t.mock.method(pool, 'query', async () => ({ rows: [] }));
  t.mock.method(pool, 'connect', () => { assert.fail('No conectar a DB real'); });
  const app = require('../src/index');
  assert.equal(app.get('trust proxy'), false);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  const response = await fetch(`http://127.0.0.1:${server.address().port}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(valid),
  });
  assert.equal(response.status, 401);
  await response.json();
  const spec = require('../src/config/swagger');
  assert.deepEqual(Object.keys(spec.paths).sort(), ['/api/auth/login', '/api/auth/logout', '/api/auth/me', '/api/auth/refresh', '/api/auth/register', '/api/health']);
  assert.deepEqual(Object.keys(spec.paths['/api/auth/login'].post.responses), ['200', '400', '401', '429', '500']);
  assert.equal(spec.components.schemas.LoginInput.additionalProperties, false);
});
