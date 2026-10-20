const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const pool = require('../src/config/db');

test('la API pública mantiene deshabilitadas las rutas heredadas de usuarios', async (t) => {
  // Interceptar ambos accesos antes de cargar la aplicación: ninguna petición
  // de esta prueba puede alcanzar PostgreSQL, incluso si se remonta el router.
  const internalError = new Error('host=private.example password=secret SELECT * FROM users');
  const query = t.mock.method(pool, 'query', async () => { throw internalError; });
  const connect = t.mock.method(pool, 'connect', async () => { throw internalError; });
  const app = require('../src/index');
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await once(server, 'listening');
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const user = { name: 'Prueba', email: 'test@example.invalid', password: 'solo-prueba' };
  const routes = [
    ['GET', '/api/users'],
    ['GET', '/api/users/1'],
    ['POST', '/api/users', JSON.stringify(user)],
    ['PUT', '/api/users/1', JSON.stringify(user)],
    ['DELETE', '/api/users/1'],
  ];

  async function assertBlocked(method, path, body, headers = {}) {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body,
    });
    assert.equal(response.status, 404);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await response.json(), { success: false, message: 'Ruta no encontrada' });
    assert.equal(query.mock.callCount(), 0);
    assert.equal(connect.mock.callCount(), 0);
  }

  for (const [method, path, body] of routes) {
    await t.test(`${method} ${path} devuelve 404 sin acceder a PostgreSQL`, async () => {
      await assertBlocked(method, path, body);
      await assertBlocked(method, path, body, { Authorization: 'Bearer token-ficticio' });
    });
  }

  await t.test('variantes de URL y otros métodos tampoco permiten acceso', async () => {
    for (const [method, path] of [
      ['GET', '/api/users/?email=test%40example.invalid'],
      ['GET', '/API/USERS/1/'],
      ['GET', '/api/users/no-es-un-id'],
      ['PATCH', '/api/users/1'],
      ['OPTIONS', '/api/users'],
    ]) {
      await assertBlocked(method, path);
    }
    const response = await fetch(`${baseUrl}/api/users/1`, { method: 'HEAD' });
    assert.equal(response.status, 404);
    assert.equal(await response.text(), '');
    assert.equal(query.mock.callCount(), 0);
    assert.equal(connect.mock.callCount(), 0);
  });

  await t.test('cuerpos JSON inválidos tampoco exponen errores internos', async () => {
    await assertBlocked('POST', '/api/users', '{"password":');
    await assertBlocked('PUT', '/api/users/1', '{"email":');
  });

  await t.test('la raíz y Swagger siguen disponibles sin anunciar usuarios', async () => {
    const root = await fetch(`${baseUrl}/`);
    assert.equal(root.status, 200);
    assert.deepEqual(await root.json(), { message: 'API corriendo', docs: '/api-docs' });

    const docs = await fetch(`${baseUrl}/api-docs/`);
    assert.equal(docs.status, 200);
    assert.match(await docs.text(), /swagger-ui-init\.js/);
    // Comprobar el documento que realmente recibe Swagger UI por HTTP.
    const init = await fetch(`${baseUrl}/api-docs/swagger-ui-init.js`);
    assert.equal(init.status, 200);
    const script = await init.text();
    assert.match(script, /"\/api\/health"/);
    assert.doesNotMatch(script, /\/api\/users|"User"|"UserInput"|"UserUpdate"/);
    assert.equal(query.mock.callCount(), 0);
    assert.equal(connect.mock.callCount(), 0);
  });

  await t.test('health conserva sus respuestas 200 y 503 en la aplicación real', async () => {
    query.mock.mockImplementation(async (config) => {
      assert.deepEqual(config, { text: 'SELECT 1', query_timeout: 5000 });
      return { rows: [{ '?column?': 1 }] };
    });
    const healthy = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthy.status, 200);
    assert.deepEqual(await healthy.json(), { status: 'ok', database: 'connected' });

    query.mock.mockImplementation(async () => { throw internalError; });
    const unavailable = await fetch(`${baseUrl}/api/health`);
    assert.equal(unavailable.status, 503);
    assert.deepEqual(await unavailable.json(), { status: 'unavailable', database: 'disconnected' });
    assert.equal(query.mock.callCount(), 2);
    assert.equal(connect.mock.callCount(), 0);
  });
});
