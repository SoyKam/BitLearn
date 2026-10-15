const assert = require('node:assert/strict');
const { once } = require('node:events');
const { test } = require('node:test');
const express = require('express');
const pool = require('../src/config/db');
const healthRoutes = require('../src/routes/health.routes');

test('GET /api/health responde y se recupera de fallos de PostgreSQL', async (t) => {
  const app = express();
  app.use('/api/health', healthRoutes);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}/api/health`;

  let databaseError;
  const query = t.mock.method(pool, 'query', async (config) => {
    assert.equal(config.text, 'SELECT 1');
    assert.equal(config.query_timeout, 5000);
    if (databaseError) throw databaseError;
    return { rows: [{ '?column?': 1 }] };
  });

  await t.test('devuelve 200 con la consulta disponible', async () => {
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.deepEqual(await response.json(), { status: 'ok', database: 'connected' });
  });

  for (const code of ['ECONNREFUSED', 'ETIMEDOUT']) {
    await t.test(`devuelve 503 sin detalles internos ante ${code}`, async () => {
      databaseError = Object.assign(
        new Error('host=private.example port=5432 password=secret certificate=private'),
        { code }
      );
      const response = await fetch(url);
      assert.equal(response.status, 503);
      assert.match(response.headers.get('content-type'), /application\/json/);
      assert.deepEqual(await response.json(), {
        status: 'unavailable', database: 'disconnected',
      });
    });
  }

  await t.test('vuelve a responder 200 sin reiniciar el servidor', async () => {
    databaseError = undefined;
    const response = await fetch(url);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'ok', database: 'connected' });
  });

  assert.equal(query.mock.callCount(), 4);
});
