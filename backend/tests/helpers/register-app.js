const { once } = require('node:events');
const express = require('express');
const createAuthRouter = require('../../src/routes/auth.routes');
const errorHandler = require('../../src/middlewares/error-handler');

async function serve(t, authService, { route = 'register', config } = {}) {
  const app = express();
  app.set('trust proxy', false);
  app.use('/api/auth', createAuthRouter(authService, config));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  }));
  await once(server, 'listening');
  return (body, { raw = false, headers = {}, method = 'POST' } = {}) => fetch(
    `http://127.0.0.1:${server.address().port}/api/auth/${route}`, {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: method === 'GET' ? undefined : raw ? body : JSON.stringify(body),
    }
  );
}

module.exports = serve;
