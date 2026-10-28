const { once } = require('node:events');
const { testEnvironment } = require('./auth-config');

// Arranca la aplicación real con dependencias explícitas; nunca evalúa db.js
// ni lee .env. El pool recibido es un doble o el del clúster temporal.
async function serve(t, database) {
  t.mock.method(require('dotenv'), 'config', () => ({ parsed: {} }));
  for (const [key, value] of Object.entries(testEnvironment())) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  for (const module of ['config/db', 'index', 'routes/health.routes',
    'controllers/health.controller', 'repositories/health.repository']) {
    const file = require.resolve(`../../src/${module}`);
    const previous = require.cache[file];
    delete require.cache[file];
    if (module === 'config/db') require.cache[file] = { exports: database };
    t.after(() => {
      if (previous) require.cache[file] = previous;
      else delete require.cache[file];
    });
  }
  const app = require('../../src/index');
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await once(server, 'listening');
  return `http://127.0.0.1:${server.address().port}`;
}

module.exports = serve;
