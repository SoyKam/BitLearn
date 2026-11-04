const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const express = require('express');
const jwt = require('jsonwebtoken');
const router = require('../src/routes/review.routes');
const repository = require('../src/repositories/review.repository');
const { createReviewService } = require('../src/services/review.service');
const { createAuthService } = require('../src/services/auth.service');
const tokenService = require('../src/services/token.service');
const { testConfig } = require('./helpers/auth-config');
const errorHandler = require('../src/middlewares/error-handler');

const instant = new Date('2026-11-03T12:00:00Z');
const dueRow = { flashcard_id: 5, lesson_id: 3, lesson_title: 'Lección', course_slug: 'html',
  front: 'Pregunta', back: 'Respuesta', progress_id: 5, repetitions: 2, ease_factor: '2.6000',
  interval_days: 6, last_review_at: instant, next_review_at: instant };
const historyRow = { id: '9007199254740993', flashcard_id: 5, course_slug: 'html', lesson_title: 'Lección',
  front: 'Pregunta', quality: 4, reviewed_at: instant, ease_factor_before: '2.5000', ease_factor_after: '2.6000',
  interval_before_days: 1, interval_after_days: 6, next_review_at: instant, total: '3' };

test('consultas parametrizadas, proyección explícita, fechas y BIGSERIAL sin pérdida', async () => {
  const calls = [];
  const service = createReviewService(repository({ async query(sql, params) {
    calls.push({ sql, params });
    assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE)\b/i);
    return { rows: sql.includes('LATERAL') ? [{ ...historyRow, user_id: 7, request_id: 'secret' }] : [dueRow,
      { ...dueRow, progress_id: null, repetitions: null, ease_factor: null, interval_days: null,
        last_review_at: null, next_review_at: null }] };
  } }));
  const due = await service.due(7);
  assert.deepEqual(due[0], { flashcardId: 5, lessonId: 3, lessonTitle: 'Lección', courseSlug: 'html', front: 'Pregunta',
    back: 'Respuesta', status: 'due', repetitions: 2, easeFactor: 2.6, intervalDays: 6,
    lastReviewAt: instant.toISOString(), nextReviewAt: instant.toISOString() });
  assert.deepEqual(due[1], { ...due[0], status: 'new', repetitions: 0, easeFactor: 2.5, intervalDays: 0,
    lastReviewAt: null, nextReviewAt: null });
  const history = await service.history(7, { limit: 1, offset: 2 });
  assert.deepEqual(history, { items: [{ reviewId: historyRow.id, flashcardId: 5, courseSlug: 'html', lessonTitle: 'Lección',
    front: 'Pregunta', quality: 4, reviewedAt: instant.toISOString(), easeFactorBefore: 2.5, easeFactorAfter: 2.6,
    intervalBeforeDays: 1, intervalAfterDays: 6, nextReviewAt: instant.toISOString() }], total: 3, limit: 1, offset: 2 });
  assert.deepEqual(calls.map(c => c.params), [[7, 50, null], [7, 1, 2]]);
  assert.match(calls[0].sql, /p.user_id = \$1/); assert.match(calls[0].sql, /lp.user_id = \$1/);
  assert.match(calls[0].sql, /<= COALESCE\(\$3::timestamptz, statement_timestamp\(\)\)/);
  assert.match(calls[1].sql, /WHERE r.user_id = \$1/);
});

test('vacíos y total fuera de página', async () => {
  for (const total of ['0', '3']) {
    const service = createReviewService(repository({ query: async sql => ({ rows: sql.includes('LATERAL')
      ? [{ total, id: null }] : [] }) }));
    assert.deepEqual(await service.due(1), []);
    assert.deepEqual(await service.history(1), { items: [], total: Number(total), limit: 20, offset: 0 });
  }
});

test('rechaza factores, fechas, IDs y totales corruptos', async () => {
  for (const value of ['NaN', 'Infinity', '2.50001', '2.5x', '', ' 2.5', '1.2999', '10000', null, 2.5]) {
    for (const field of ['ease_factor_before', 'ease_factor_after']) {
      const repo = repository({ query: async () => ({ rows: [{ ...historyRow, [field]: value }] }) });
      await assert.rejects(repo.findHistory(1, 20, 0));
    }
    await assert.rejects(repository({ query: async () => ({ rows: [{ ...dueRow, ease_factor: value }] }) }).findDue(1, 50));
  }
  for (const change of [{ id: 9007199254740992 }, { total: '9007199254740993' },
    { reviewed_at: new Date(NaN) }, { next_review_at: '2026-11-03' }]) {
    await assert.rejects(repository({ query: async () => ({ rows: [{ ...historyRow, ...change }] }) }).findHistory(1, 20, 0));
  }
});

test('HTTP GET: validación estricta, JWT, sesión, errores y cabeceras privadas', async t => {
  t.mock.method(console, 'error', () => {});
  const config = testConfig(); const tokens = tokenService(config); let active = true; let failure;
  const auth = createAuthService({}, { isActive: async () => active }, tokens);
  const token = tokens.createAccessToken(17, '1').accessToken;
  const expired = jwt.sign({ ...jwt.decode(token), exp: Math.floor(Date.now() / 1000) - 1 }, config.signingKey);
  const calls = [];
  const service = Object.fromEntries(['due', 'history'].map(method => [method, async (...args) => {
    if (failure) throw failure;
    calls.push([method, ...args]); return method === 'due' ? [] : { items: [], total: 0, ...args[1] };
  }]));
  const app = express(); app.use('/api/reviews', router(service, auth)); app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1'); t.after(() => new Promise(r => server.close(r))); await once(server, 'listening');
  async function get(path, bearer = token) {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/reviews/${path}`, {
      headers: bearer ? { Authorization: `Bearer ${bearer}` } : {} });
    assert.equal(res.headers.get('cache-control'), 'no-store'); assert.ok(res.headers.get('x-correlation-id'));
    return { status: res.status, body: await res.json() };
  }
  for (const path of ['due', 'history']) {
    for (const bearer of ['', 'invalid', 'a.b.c', expired]) assert.equal((await get(path, bearer)).status, 401);
    active = false; assert.equal((await get(path)).status, 401); active = true;
    for (const query of ['limit=0', 'limit=101', 'limit=-1', 'limit=1.5', 'limit=1e1', 'limit=+1',
      'limit=%201', 'limit=1%0A', 'limit=', 'limit=abc', 'limit=1&limit=2', 'limit[]=2',
      'userId=18', 'now=2099-01-01', 'unknown=1', 'limit=1%3BDROP%20TABLE%20users']) {
      assert.equal((await get(`${path}?${query}`)).status, 400, query);
    }
    for (const [error, status] of [[new Error('SQL password secret'), 500],
      [Object.assign(new Error('host password'), { code: 'ECONNREFUSED' }), 503]]) {
      failure = error; const res = await get(path); assert.equal(res.status, status);
      assert.doesNotMatch(JSON.stringify(res.body), /SQL|password|secret|host|stack|token/);
    }
    failure = undefined;
  }
  for (const query of ['offset=-1', 'offset=10001', 'offset=1.1', 'offset=1e2', 'offset=', 'offset=abc', 'offset=0&offset=1']) {
    assert.equal((await get(`history?${query}`)).status, 400);
  }
  assert.equal((await get('due?offset=0')).status, 400); assert.equal(calls.length, 0);
  assert.deepEqual((await get('due')).body, { success: true, data: [] });
  assert.deepEqual((await get('history')).body, { success: true, data: { items: [], total: 0, limit: 20, offset: 0 } });
  assert.equal((await get('due?limit=100')).status, 200);
  assert.equal((await get('history?limit=1&offset=10000')).status, 200);
  assert.deepEqual(calls, [['due', 17, { limit: 50 }], ['history', 17, { limit: 20, offset: 0 }],
    ['due', 17, { limit: 100 }], ['history', 17, { limit: 1, offset: 10000 }]]);
});

test('Swagger conserva POST y documenta ambos GET', () => {
  const spec = require('../src/config/swagger');
  assert.ok(spec.paths['/api/reviews'].post);
  for (const path of ['due', 'history']) {
    const endpoint = spec.paths[`/api/reviews/${path}`].get;
    assert.deepEqual(endpoint.security, [{ bearerAuth: [] }]);
    assert.deepEqual(Object.keys(endpoint.responses).sort(), ['200', '400', '401', '500', '503']);
    assert.deepEqual(endpoint.parameters.map(p => p.name), path === 'due' ? ['limit'] : ['limit', 'offset']);
  }
  assert.equal(spec.components.schemas.ReviewHistoryItem.properties.reviewId.type, 'string');
});
