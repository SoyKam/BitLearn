const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const bcrypt = require('bcryptjs');
const { createAuthService } = require('../src/services/auth.service');
const createUserRepository = require('../src/repositories/user.repository');
const serve = require('./helpers/register-app');

const valid = { name: 'Juan Pérez', email: 'juan@example.com', password: 'contraseña-de-prueba' };
const createdAt = new Date('2026-10-21T16:00:00.000Z');

test('registro: normaliza, usa SQL parametrizado, hash real y respuesta pública', async (t) => {
  const calls = [];
  const database = {
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ id: 1, name: params[0], email: params[1], created_at: createdAt,
        password: params[2], private_field: 'nunca publicar' }] };
    },
  };
  const post = await serve(t, createAuthService(createUserRepository(database)));
  const name = "O'Brien; DROP TABLE users;--";
  const response = await post({ ...valid, name: ` ${name} `, email: ' JUAN@Example.COM ' });
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('set-cookie'), null);
  assert.match(response.headers.get('x-correlation-id'), /^[0-9a-f-]{36}$/);
  assert.deepEqual(await response.json(), {
    success: true, data: { id: 1, name, email: 'juan@example.com', created_at: createdAt.toISOString() },
  });
  assert.equal(calls.length, 1);
  assert.match(calls[0].sql, /VALUES \(\$1, \$2, \$3\) RETURNING id, name, email, created_at$/);
  assert.ok(!calls[0].sql.includes(name));
  const [storedName, email, hash] = calls[0].params;
  assert.equal(storedName, name);
  assert.equal(email, 'juan@example.com');
  assert.notEqual(hash, valid.password);
  assert.equal(bcrypt.getRounds(hash), 10);
  assert.equal(await bcrypt.compare(valid.password, hash), true);
  assert.equal(await bcrypt.compare('otra-contraseña', hash), false);
});

const invalid = [
  ['nombre ausente', { email: valid.email, password: valid.password }],
  ...['', '   ', 123, null, {}, [], 'a'.repeat(101), 'Juan\u0000Pérez', 'Juan\nPérez']
    .map((name, i) => [`nombre inválido ${i}`, { ...valid, name }]),
  ...['', 'correo', 'a@', '@example.com', 'a b@example.com', 123, null, {}, [],
    `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(20)}.com`]
    .map((email, i) => [`correo inválido ${i}`, { ...valid, email }]),
  ...['', 'corta', 'a'.repeat(11), ' '.repeat(12), 123, null, {}, [], 'a'.repeat(73),
    'é'.repeat(37), 'abc\u0000defghijkl']
    .map((password, i) => [`contraseña inválida ${i}`, { ...valid, password }]),
  ['contraseña ausente', { name: valid.name, email: valid.email }],
  ['campo inesperado', { ...valid, role: 'admin' }],
  ['campo sensible inesperado', { ...valid, 'secreto-no-reflejar': true }],
  ['array', [valid]], ['null', null], ['string', 'secreto-no-reflejar'], ['número', 42],
];
for (const [name, body] of invalid) {
  test(`400: ${name}, sin acceder al servicio`, async (t) => {
    let calls = 0;
    const post = await serve(t, { async register() { calls++; throw new Error('No debe ejecutarse'); } });
    const response = await post(body);
    assert.equal(response.status, 400);
    const payload = await response.json();
    assert.equal(payload.success, false);
    assert.equal(typeof payload.message, 'string');
    assert.doesNotMatch(JSON.stringify(payload), /secreto-no-reflejar|stack|ZodError/);
    assert.equal(calls, 0);
  });
}

test('acepta límites exactos y conserva los espacios de la contraseña', async (t) => {
  const post = await serve(t, createAuthService({
    async create({ name, email, passwordHash }) {
      assert.equal(name.length, 100);
      assert.equal(email.length, 150);
      assert.equal(await bcrypt.compare(` ${'é'.repeat(35)} `, passwordHash), true);
      assert.equal(await bcrypt.compare('é'.repeat(35), passwordHash), false);
      return { id: 1, name, email, created_at: createdAt };
    },
  }));
  const response = await post({ name: 'a'.repeat(100),
    email: `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(21)}`, password: ` ${'é'.repeat(35)} ` });
  assert.equal(response.status, 201);
});

test('bcrypt genera sales distintas para una misma contraseña', async () => {
  const hashes = [];
  const service = createAuthService({ async create({ passwordHash }) {
    hashes.push(passwordHash);
    return { id: hashes.length, name: valid.name, email: valid.email, created_at: createdAt };
  } });
  await service.register(valid);
  await service.register(valid);
  assert.notEqual(hashes[0], hashes[1]);
  for (const hash of hashes) assert.equal(await bcrypt.compare(valid.password, hash), true);
});

for (const [label, error, status] of [
  ['correo duplicado', { code: '23505', constraint: 'users_email_key' }, 409],
  ['otra clave única', { code: '23505', constraint: 'users_pkey' }, 500],
  ['fallo PostgreSQL', { code: 'ECONNREFUSED' }, 500],
]) {
  test(`${status}: ${label}, sin filtrar errores ni datos a respuesta o logs`, async (t) => {
    const log = t.mock.method(console, 'error', () => {});
    const post = await serve(t, createAuthService(createUserRepository({ async query() {
      throw Object.assign(new Error('SELECT password FROM users host=privado password=secreto'), error);
    } })));
    const response = await post(valid);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { success: false,
      message: status === 409 ? 'El correo ya está registrado.' : 'No se pudo completar la solicitud.' });
    if (status === 500) {
      assert.equal(log.mock.callCount(), 1);
      assert.deepEqual(JSON.parse(log.mock.calls[0].arguments[0]), {
        level: 'error', event: 'request_failed', correlation_id: response.headers.get('x-correlation-id'),
      });
    } else assert.equal(log.mock.callCount(), 0);
  });
}

for (const [label, body, headers] of [
  ['JSON mal formado', '{"password":"secreto",', {}],
  ['JSON vacío', '', {}],
  ['cuerpo demasiado grande', JSON.stringify({ ...valid, name: 'a'.repeat(5000) }), {}],
  ['Content-Type incorrecto', JSON.stringify(valid), { 'Content-Type': 'text/plain' }],
  ['codificación no admitida', JSON.stringify(valid), { 'Content-Encoding': 'gzip' }],
]) {
  test(`400: ${label}`, async (t) => {
    let calls = 0;
    const post = await serve(t, { async register() { calls++; } });
    const response = await post(body, { raw: true, headers });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).success, false);
    assert.equal(calls, 0);
  });
}

test('429 tras 10 intentos: cuenta JSON inválido e ignora encabezados de proxy', async (t) => {
  let calls = 0;
  const post = await serve(t, { async register() { calls++; } });
  for (let i = 0; i < 10; i++) {
    const response = await post('{', { raw: true, headers: {
      'X-Forwarded-For': `203.0.113.${i + 1}`, Forwarded: `for=203.0.113.${i + 1}`,
    } });
    assert.equal(response.status, 400);
    await response.json();
  }
  const response = await post(valid, { headers: { 'X-Forwarded-For': '198.51.100.2' } });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get('retry-after')) > 0);
  assert.ok(response.headers.get('ratelimit'));
  assert.deepEqual(await response.json(), { success: false, message: 'Demasiados intentos de registro. Inténtalo más tarde.' });
  assert.equal(calls, 0);
});

test('la aplicación monta registro y lo publica en Swagger, conservando health y bloqueo de users', async (t) => {
  const pool = require('../src/config/db');
  const query = t.mock.method(pool, 'query', async (_sql, values) => {
    if (!values) return { rows: [{ '?column?': 1 }] };
    return { rows: [{ id: 1, name: values[0], email: values[1], created_at: createdAt }] };
  });
  t.mock.method(pool, 'connect', () => { throw new Error('Prohibido conectar a DB real'); });
  Object.assign(process.env, require('./helpers/auth-config').testEnvironment());
  const app = require('../src/index');
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  const base = `http://127.0.0.1:${server.address().port}`;
  const response = await fetch(`${base}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(valid),
  });
  assert.equal(response.status, 201);
  await response.json();
  assert.equal(query.mock.callCount(), 1);
  const spec = require('../src/config/swagger');
  assert.deepEqual(Object.keys(spec.paths).sort(), ['/api/auth/login', '/api/auth/register', '/api/health']);
  assert.deepEqual(Object.keys(spec.paths['/api/auth/register'].post.responses), ['201', '400', '409', '429', '500']);
  const swagger = await fetch(`${base}/api-docs/swagger-ui-init.js`);
  assert.match(await swagger.text(), /"\/api\/auth\/register"/);
  const health = await fetch(`${base}/api/health`);
  assert.equal(health.status, 200);
  await health.json();
  const users = await fetch(`${base}/api/users`);
  assert.equal(users.status, 404);
  await users.json();
});
