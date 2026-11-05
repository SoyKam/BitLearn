const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const net = require('node:net');
const { once } = require('node:events');
const { temporaryPostgres, postgresSkip } = require('./helpers/temporary-postgres');
const serve = require('./helpers/course-app');
const migrate = require('../src/config/migrate');
const { seedCatalog } = require('../src/config/seed-catalog');
const { seedQuestions } = require('../src/config/seed-questions');
const { seedFlashcards } = require('../src/config/seed-flashcards');

test('seguridad transversal y resiliencia en PostgreSQL temporal', { skip: postgresSkip, timeout: 60000 }, async t => {
  t.mock.method(console, 'error', () => {});
  const { database, connection } = await temporaryPostgres(t);
  const isolated = await database(t);
  const pool = new Pool({ ...connection, database: isolated.options.database, max: 4,
    statement_timeout: 5000, lock_timeout: 3000 });
  // Puerto local efímero cerrado por esta prueba: ECONNREFUSED, sin tocar servicios reales.
  const reservation = net.createServer().listen(0, '127.0.0.1');
  await once(reservation, 'listening');
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const unavailable = new Pool({ ...connection, host: '127.0.0.1', port, connectionTimeoutMillis: 100 });
  t.after(async () => { await pool.end(); await unavailable.end(); });
  await migrate(pool, { log() {} }); await seedCatalog(pool); await seedQuestions(pool); await seedFlashcards(pool);
  let fault = null;
  let releasedWithError = false;
  const base = await serve(t, {
    query(sql, params) {
      if (fault === 'unavailable') return unavailable.query(sql, params);
      if (fault === 'timeout') return pool.query('SELECT pg_sleep(10)');
      return pool.query(sql, params);
    },
    async connect() {
      const client = await pool.connect();
      return {
        release(error) { if (error) releasedWithError = true; client.release(error); },
        async query(sql, params) {
          const result = await client.query(sql, params);
          if (fault === 'commit-response-lost' && sql === 'COMMIT') {
            fault = null;
            throw Object.assign(new Error('respuesta de COMMIT perdida'), { code: 'ECONNRESET' });
          }
          return result;
        },
      };
    },
  });
  async function request(path, user, body, headers = {}) {
    const response = await fetch(base + path, { method: body === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', ...(user ? { Authorization: `Bearer ${user.token}` } : {}), ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.match(response.headers.get('x-correlation-id'), /^[0-9a-f-]{36}$/);
    return { status: response.status, data: await response.json(), cookie: response.headers.get('set-cookie') };
  }
  const users = [];
  for (const name of ['A', 'B']) {
    const credentials = { name, email: `${name}@example.invalid`, password: 'Ficticio-password-123' };
    const registered = await request('/api/auth/register', null, credentials);
    assert.equal(registered.status, 201);
    const login = await request('/api/auth/login', null, { email: credentials.email, password: credentials.password });
    assert.equal(login.status, 200);
    users.push({ id: registered.data.data.id, token: login.data.data.accessToken, cookie: login.cookie.split(';')[0] });
  }
  const [a, b] = users;
  const question = (await pool.query('SELECT * FROM questions ORDER BY id LIMIT 1')).rows[0];
  const cards = (await pool.query('SELECT * FROM flashcards WHERE lesson_id = $1 ORDER BY id', [question.lesson_id])).rows;
  const answer = { questionId: question.id, optionIndex: question.correct_option_index };
  const input = { flashcardId: cards[0].id, quality: 4, requestId: randomUUID() };
  const snapshot = async () => ({
    states: (await pool.query('SELECT * FROM user_card_progress ORDER BY user_id, flashcard_id')).rows,
    history: (await pool.query('SELECT * FROM card_reviews ORDER BY id')).rows,
  });

  await t.test('A completa y repasa; B no ve progreso, pendientes, historial, estadísticas ni retención de A', async () => {
    assert.equal((await request(`/api/lessons/${question.lesson_id}/answer`, a, answer)).status, 200);
    assert.equal((await request('/api/reviews', a, input)).status, 200);
    assert.equal((await request('/api/progress', a)).data.data.completedLessons, 1);
    assert.equal((await request('/api/reviews/history', a)).data.data.total, 1);
    assert.equal((await request('/api/dashboard', a)).data.data.summary.totalReviews, 1);
    assert.equal((await request('/api/dashboard/retention', a)).data.data.modeledCards, 1);
    const before = await snapshot();
    const alternate = { 'X-User-Id': String(a.id), 'X-Authenticated-User': String(a.id) };
    assert.equal((await request(`/api/auth/me?userId=${a.id}`, b, undefined, alternate)).data.data.id, b.id);
    assert.deepEqual((await request(`/api/progress?userId=${a.id}`, b, undefined, alternate)).data.data.lessons, []);
    assert.deepEqual((await request('/api/reviews/due', b, undefined, alternate)).data.data, []);
    assert.equal((await request('/api/reviews/history', b, undefined, alternate)).data.data.total, 0);
    const dashboard = (await request('/api/dashboard', b, undefined, alternate)).data.data;
    for (const key of ['completedLessons', 'studiedFlashcards', 'dueReviews', 'totalReviews']) assert.equal(dashboard.summary[key], 0);
    const retention = (await request('/api/dashboard/retention', b, undefined, alternate)).data.data;
    assert.equal(retention.modeledCards, 0); assert.deepEqual(retention.points, []);
    assert.equal((await request('/api/reviews', b, input)).status, 403);
    assert.equal((await request('/api/reviews', b, { ...input, userId: a.id })).status, 400);
    for (const extra of [{ completed: true }, { userId: a.id }, { completedAt: '2026-01-01' }]) {
      assert.equal((await request(`/api/lessons/${question.lesson_id}/answer`, b, { ...answer, ...extra })).status, 400);
    }
    for (const extra of [{ easeFactor: 9 }, { intervalDays: 0 }, { nextReviewAt: '2026-01-01' }]) {
      assert.equal((await request('/api/reviews', b, { ...input, ...extra })).status, 400);
    }
    for (const path of ['/api/reviews/due', '/api/reviews/history', '/api/dashboard', '/api/dashboard/retention']) {
      assert.equal((await request(`${path}?userId=${a.id}`, b)).status, 400);
    }
    assert.deepEqual(await snapshot(), before);
  });

  await t.test('B completa su lección y usa el mismo UUID sin modificar el estado de A', async () => {
    const before = await snapshot();
    assert.equal((await request(`/api/lessons/${question.lesson_id}/answer`, b, answer)).status, 200);
    assert.equal((await request('/api/reviews', b, { ...input, quality: 1 })).status, 200);
    const after = await snapshot();
    assert.deepEqual(after.states.filter(x => x.user_id === a.id), before.states);
    assert.deepEqual(after.history.filter(x => x.user_id === a.id), before.history);
    assert.equal(after.states.find(x => x.user_id === b.id).ease_factor, '1.9600');
  });

  await t.test('COMMIT confirmado con respuesta perdida: 503 sin falso éxito, replay único y conexión descartada', async () => {
    const body = { ...input, flashcardId: cards[1].id, requestId: randomUUID() };
    const before = await snapshot();
    fault = 'commit-response-lost';
    const lost = await request('/api/reviews', a, body);
    assert.equal(lost.status, 503); assert.equal(lost.data.success, false); assert.equal(releasedWithError, true);
    const committed = await snapshot();
    assert.equal(committed.history.length, before.history.length + 1);
    assert.equal(committed.states.length, before.states.length + 1);
    const replay = await request('/api/reviews', a, body);
    assert.equal(replay.status, 200); assert.equal(replay.data.data.replayed, true);
    assert.equal(replay.data.data.reviewId, committed.history.at(-1).id);
    assert.deepEqual(await snapshot(), committed);
    assert.equal((await request('/api/reviews', a, { ...body, quality: 5 })).status, 409);
  });

  await t.test('PostgreSQL ausente y timeout real devuelven 503 y permiten recuperación', async () => {
    for (const mode of ['unavailable', 'timeout']) {
      fault = mode;
      try {
        const response = await request('/api/auth/me', a);
        assert.equal(response.status, 503);
        assert.deepEqual(response.data, { success: false, message: 'El servicio no está disponible temporalmente.' });
      } finally { fault = null; }
      assert.equal((await request('/api/auth/me', a)).status, 200);
    }
  });

  await t.test('timeout de bloqueo revierte repaso y libera cliente sin escrituras parciales', async () => {
    const blocker = await pool.connect();
    const before = await snapshot();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT pg_advisory_xact_lock($1::integer,$2::integer)', [a.id, cards[0].id]);
      const response = await request('/api/reviews', a, { ...input, requestId: randomUUID() });
      assert.equal(response.status, 503); assert.deepEqual(await snapshot(), before);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    assert.equal((await request('/api/reviews', a, input)).data.data.replayed, true);
  });

  await t.test('logout revoca A; ni JWT anterior ni refresh reutilizado escriben; B sigue activo', async () => {
    const before = await snapshot();
    assert.equal((await request('/api/auth/logout', a, {}, { Cookie: a.cookie })).status, 200);
    assert.equal((await request('/api/reviews', a, input)).status, 401);
    for (const path of ['/api/auth/me', '/api/progress', '/api/reviews/due', '/api/reviews/history', '/api/dashboard', '/api/dashboard/retention']) {
      assert.equal((await request(path, a)).status, 401);
    }
    assert.equal((await request('/api/auth/refresh', b, { userId: b.id }, { Cookie: a.cookie })).status, 401);
    assert.equal((await request('/api/auth/me', b)).data.data.id, b.id);
    assert.deepEqual(await snapshot(), before);
  });
  assert.equal(pool.idleCount, pool.totalCount);
});
