const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const serve = require('./helpers/course-app');
const loadAuthConfig = require('../src/config/auth');
const createTokens = require('../src/services/token.service');
const createSessions = require('../src/repositories/session.repository');
const { createEventQueue, eventQueue } = require('../src/queues/observability.queue');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

test('cabeceras globales, correlación propia y Swagger compatible', async t => {
  const base = await serve(t, { query: async () => ({ rows: [] }) });
  const ids = new Set();
  for (const path of ['/', '/api/health', '/missing', '/api/courses/%ZZ', '/api-docs/', '/api/auth/me']) {
    const response = await fetch(base + path, { headers: { 'x-correlation-id': 'cliente-no-confiable' } });
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('content-security-policy'), "frame-ancestors 'none'; base-uri 'none'; object-src 'none'");
    assert.equal(response.headers.get('strict-transport-security'), null);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.equal(response.headers.get('x-powered-by'), null);
    const id = response.headers.get('x-correlation-id');
    assert.match(id, /^[0-9a-f-]{36}$/); assert.ok(!ids.has(id)); ids.add(id);
    if (path === '/api-docs/') {
      assert.equal(response.status, 200); assert.match(await response.text(), /swagger-ui/);
    } else await response.arrayBuffer();
  }
});

test('auth: fallos PG identificables son 503, defectos e integridad siguen 500; logs seguros', async t => {
  const log = t.mock.method(console, 'error', () => {});
  let failure;
  const base = await serve(t, {
    async query() { if (failure) throw failure; return { rows: [] }; },
    async connect() { throw failure; },
  });
  const tokens = createTokens(loadAuthConfig());
  const bearer = tokens.createAccessToken(1, 1).accessToken;
  const refresh = tokens.createRefreshToken().token;
  for (const code of ['ECONNREFUSED', 'ECONNRESET', '57014', '55P03', '23503', '42P01', undefined]) {
    failure = Object.assign(new Error('SQL password cookie datos-privados'), { code });
    const expected = ['ECONNREFUSED', 'ECONNRESET', '57014', '55P03'].includes(code) ? 503 : 500;
    for (const route of ['register', 'login', 'refresh', 'logout', 'me']) {
      const response = await fetch(`${base}/api/auth/${route}`, {
        method: route === 'me' ? 'GET' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${bearer}`,
          Cookie: `bitlearn_refresh=${refresh}`, 'x-correlation-id': 'privado' },
        ...(route === 'me' ? {} : { body: JSON.stringify(route === 'register'
          ? { name: 'Test', email: 'test@example.invalid', password: 'Ficticio-password-123' }
          : { email: 'test@example.invalid', password: 'Ficticio-password-123' }) }),
      });
      assert.equal(response.status, expected, `${route}/${code}`);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      assert.deepEqual(await response.json(), { success: false, message: expected === 503
        ? 'El servicio no está disponible temporalmente.' : 'No se pudo completar la solicitud.' });
      assert.deepEqual(JSON.parse(log.mock.calls.at(-1).arguments[0]), {
        level: 'error', event: 'request_failed', correlation_id: response.headers.get('x-correlation-id'),
      });
      if (route !== 'logout') assert.equal(response.headers.get('set-cookie'), null);
    }
  }
  failure = null;
  const recovered = await fetch(base + '/api/auth/me', { headers: { Authorization: `Bearer ${bearer}` } });
  assert.equal(recovered.status, 401); // DB recuperada, sesión inexistente; nunca éxito ficticio.
});

test('sesión: descarta conexión incierta aunque ROLLBACK responda', async () => {
  const failure = Object.assign(new Error('transporte'), { code: 'ECONNRESET' });
  const calls = [];
  const sessions = createSessions({ async connect() { return {
    async query(sql) { calls.push(sql); if (sql.startsWith('INSERT')) throw failure; return { rows: [] }; },
    release(error) { calls.push(error); },
  }; } });
  await assert.rejects(sessions.create({ userId: 1 }), failure);
  assert.equal(calls.at(-2), 'ROLLBACK'); assert.equal(calls.at(-1), failure);
});

test('Authorization duplicado real, token largo y fuentes alternativas no llegan a PostgreSQL', async t => {
  const base = await serve(t, { query() { assert.fail('No debe consultar DB'); } });
  const token = createTokens(loadAuthConfig()).createAccessToken(1, 1).accessToken;
  const status = headers => new Promise((resolve, reject) => {
    const req = http.request(base + '/api/auth/me', { headers }, res => { res.resume(); res.on('end', () => resolve(res.statusCode)); });
    req.on('error', reject); req.end();
  });
  assert.equal(await status(['Host', new URL(base).host, 'Authorization', `Bearer ${token}`, 'authorization', `Bearer ${token}`]), 401);
  assert.equal(await status({ Authorization: `Bearer ${'a'.repeat(4096)}.b.c` }), 401);
  const response = await fetch(`${base}/api/auth/me?accessToken=${token}`, { headers: { 'X-Access-Token': token } });
  assert.equal(response.status, 401);
});

test('429 conserva correlación, no confía en proxy y encola solo metadatos seguros', async t => {
  const enqueue = t.mock.method(eventQueue, 'enqueue', () => false); // Cola llena no bloquea HTTP.
  const base = await serve(t, { query() { assert.fail('Entrada inválida no consulta DB'); } });
  for (let i = 0; i <= 10; i++) {
    const response = await fetch(base + '/api/auth/register', { method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': `203.0.113.${i}`,
        Authorization: 'secreto', Cookie: 'secreto', 'x-correlation-id': 'secreto' },
      body: '{"password":"secreto"}',
    });
    assert.equal(response.status, i < 10 ? 400 : 429);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    if (i === 10) {
      assert.ok(Number(response.headers.get('retry-after')) > 0);
      assert.equal(enqueue.mock.callCount(), 1);
      assert.deepEqual(enqueue.mock.calls[0].arguments, [{ correlationId: response.headers.get('x-correlation-id'), method: 'POST' }]);
    }
    await response.arrayBuffer();
  }
});

test('cola acotada incluye tarea activa, descarta nuevas, no bloquea ni guarda secretos', async () => {
  let complete;
  const gate = new Promise(resolve => { complete = resolve; });
  const lines = [];
  const queue = createEventQueue({ capacity: 2, delayMs: 1, async write(line) { lines.push(line); await gate; } });
  const event = { correlationId: randomUUID(), method: 'POST', password: 'secreto', token: 'secreto', body: 'secreto' };
  assert.equal(queue.enqueue(event), true);
  assert.equal(lines.length, 0); // El trabajo se difiere.
  await delay(20);
  assert.equal(lines.length, 1); assert.equal(queue.size, 1);
  assert.equal(queue.enqueue(event), true);
  assert.equal(queue.enqueue(event), false); assert.equal(queue.dropped, 1);
  event.correlationId = 'secreto'; // No conserva referencia al objeto original.
  complete(); await delay(20);
  assert.equal(lines.length, 2); assert.equal(queue.size, 0);
  assert.doesNotMatch(lines.join(''), /secreto|password|token|body/);
  assert.deepEqual(Object.keys(JSON.parse(lines[0])).sort(), ['correlation_id', 'event', 'level', 'method', 'status']);
  assert.equal(queue.enqueue(event), false);
});

test('cola continúa ante fallos síncronos/asíncronos, sin reintentos infinitos', async () => {
  let calls = 0;
  const queue = createEventQueue({ delayMs: 1, write() {
    calls++;
    if (calls === 1) throw new Error('secreto');
    if (calls === 2) return Promise.reject(new Error('secreto'));
  } });
  for (let i = 0; i < 3; i++) queue.enqueue({ correlationId: randomUUID(), method: 'método-no-permitido' });
  await delay(30);
  assert.equal(calls, 3); assert.equal(queue.size, 0); assert.equal(queue.dropped, 2);
});

test('pool limita consultas/bloqueos sin cambiar la verificación TLS ni leer .env', () => {
  const vm = require('node:vm');
  const fs = require('node:fs');
  const path = require('node:path');
  const tls = require('node:tls');
  let options;
  vm.runInNewContext(fs.readFileSync(require.resolve('../src/config/db'), 'utf8'), {
    __dirname: path.dirname(require.resolve('../src/config/db')), module: {}, process: { env: {} }, console,
    require(name) {
      if (name === 'pg') return { Pool: class { constructor(value) { options = value; } on() {} } };
      if (name === 'fs') return { readFileSync: () => 'certificado-ficticio' };
      if (name === 'dotenv') return { config() {} };
      if (name === 'tls') return { checkServerIdentity: (...args) => args };
      return require(name);
    },
  });
  assert.equal(options.connectionTimeoutMillis, 10000);
  assert.equal(options.statement_timeout, 5000); assert.equal(options.lock_timeout, 3000);
  assert.equal(options.ssl.rejectUnauthorized, true);
  assert.equal(options.ssl.checkServerIdentity('otro', 'cert')[0], 'bitlearn.internal');
  assert.ok(tls.checkServerIdentity);
});
