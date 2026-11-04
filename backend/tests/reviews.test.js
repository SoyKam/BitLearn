const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const { randomUUID } = require('node:crypto');
const express = require('express');
const { createAuthService } = require('../src/services/auth.service');
const tokenService = require('../src/services/token.service');
const { testConfig } = require('./helpers/auth-config');
const { createReviewService, ReviewNotFoundError, ReviewForbiddenError, ReviewConflictError, ReviewNotDueError } = require('../src/services/review.service');
const repository = require('../src/repositories/review.repository');
const router = require('../src/routes/review.routes');
const errorHandler = require('../src/middlewares/error-handler');
const { calculateSm2, createInitialSm2State } = require('../src/domain/sm2');

const input = () => ({ flashcardId: 5, quality: 5, requestId: randomUUID() });
const instant = new Date('2026-11-03T12:00:00Z');
const historic = { reviewId: '123', flashcardId: 5, quality: 5, easeFactor: 2.6,
  intervalDays: 1, reviewedAt: instant.toISOString(), nextReviewAt: '2026-11-04T12:00:00.000Z' };
function fixture(overrides = {}) {
  const calls = [];
  const tx = { findReview: async () => null, lockCard: async () => {},
    findCard: async () => ({ completed: true }), findProgress: async () => null,
    now: async () => instant,
    saveProgress: async (s) => calls.push(s), insertReview: async (before, after) => {
      calls.push(before); return { ...historic, easeFactor: after.easeFactor, intervalDays: after.intervalDays,
        reviewedAt: after.lastReviewAt, nextReviewAt: after.nextReviewAt };
    }, ...overrides };
  return { calls, service: createReviewService({ record: async (user, body, work) => work(tx) }) };
}

test('servicio integra motor real, estado inicial, factor, intervalo, repeticiones y fechas', async () => {
  const { service, calls } = fixture();
  const result = await service.record(1, input());
  assert.deepEqual(calls, [calculateSm2(createInitialSm2State(), 5, instant), createInitialSm2State()]);
  assert.deepEqual(result, { ...historic, replayed: false });
  assert.equal('repetitions' in result, false);
});
test('estado almacenado y vencimiento inclusivo', async () => {
  const previous = { repetitions: 2, easeFactor: 2.6, intervalDays: 6, nextReviewAt: instant };
  const { service, calls } = fixture({ findProgress: async () => previous, findCard: async () => ({ completed: false }) });
  await service.record(1, input());
  assert.deepEqual(calls[0], calculateSm2(previous, 5, instant));
  assert.equal(calls[0].intervalDays, 16);
  assert.equal(calls[0].repetitions, 3);
});
for (const [name, overrides, error] of [
  ['inexistente', { findCard: async () => null }, ReviewNotFoundError],
  ['no completada', { findCard: async () => ({ completed: false }) }, ReviewForbiddenError],
  ['no pendiente', { findProgress: async () => ({ nextReviewAt: new Date('2099-01-01') }) }, ReviewNotDueError],
]) test(name, async () => {
  const { service, calls } = fixture(overrides);
  await assert.rejects(service.record(1, input()), error); assert.deepEqual(calls, []);
});
test('idempotencia histórica no consulta estado, reloj ni recalcula', async () => {
  const { service, calls } = fixture({ findReview: async () => historic,
    findProgress: () => assert.fail(), now: () => assert.fail(), lockCard: () => assert.fail() });
  assert.deepEqual(await service.record(1, input()), { ...historic, replayed: true });
  for (const changed of [{ quality: 4 }, { flashcardId: 6 }]) {
    await assert.rejects(service.record(1, { ...input(), ...changed }), ReviewConflictError);
  }
  assert.deepEqual(calls, []);
});
test('reconsulta idempotencia después de esperar bloqueo', async () => {
  let reads = 0;
  const { service, calls } = fixture({ findReview: async () => ++reads === 1 ? null : historic,
    findCard: () => assert.fail() });
  assert.equal((await service.record(1, input())).replayed, true); assert.deepEqual(calls, []);
});

test('HTTP: validación, sesión real, privacidad y rate limit', async (t) => {
  t.mock.method(console, 'error', () => {});
  const tokens = tokenService(testConfig()); let active = true; let failure; const received = [];
  const auth = createAuthService({}, { isActive: async () => active }, tokens);
  const token = tokens.createAccessToken(17, '1').accessToken;
  const app = express(); app.use('/api/reviews', router({ record: async (...args) => {
    if (failure) throw failure; received.push(args); return { ...historic, replayed: false };
  } }, auth)); app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1'); t.after(() => new Promise(r => server.close(r))); await once(server, 'listening');
  async function post(body, bearer = token, raw) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/reviews`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', ...(bearer ? { Authorization: `Bearer ${bearer}` } : {}) },
      body: raw ?? JSON.stringify(body),
    });
    assert.equal(response.headers.get('cache-control'), 'no-store'); assert.ok(response.headers.get('x-correlation-id'));
    return { status: response.status, body: await response.json() };
  }
  for (const change of [{ flashcardId: 0 }, { flashcardId: -1 }, { flashcardId: 2147483648 }, { flashcardId: '5' },
    { flashcardId: 1.5 }, { quality: -1 }, { quality: 6 }, { quality: 2.5 }, { quality: '4' },
    { requestId: undefined }, { requestId: 'invalid' },
    ...['userId','easeFactor','intervalDays','repetitions','nextReviewAt','correct','reviewedAt'].map(k => ({ [k]: 1 }))]) {
    assert.equal((await post({ ...input(), ...change })).status, 400);
  }
  for (const raw of ['{bad', 'x'.repeat(4097), 'null', '[]']) assert.equal((await post(null, token, raw)).status, 400);
  for (const bearer of ['', 'invalid', 'a.b.c']) assert.equal((await post(input(), bearer)).status, 401);
  active = false; assert.equal((await post(input())).status, 401); active = true;
  assert.equal(received.length, 0);
  const body = input(); assert.equal((await post(body)).status, 200); assert.deepEqual(received, [[17, body]]);
  for (const [error, status] of [[new ReviewNotFoundError(),404],[new ReviewForbiddenError(),403],
    [new ReviewNotDueError(),409],[new ReviewConflictError(),409],
    [Object.assign(new Error('host password SQL secret'),{code:'ECONNREFUSED'}),503],[new Error('password SQL secret'),500]]) {
    failure = error; const res = await post(input()); assert.equal(res.status, status);
    assert.doesNotMatch(JSON.stringify(res.body), /host|password|SQL|secret|stack|token/);
  }
  failure = undefined;
  let res;
  for (let n = 0; n < 61; n++) { res = await post(input()); if (res.status === 429) break; }
  assert.equal(res.status, 429);
});

test('repositorio espera COMMIT y descarta conexión si COMMIT o ROLLBACK falla', async () => {
  for (const point of ['commit', 'rollback', 'success']) {
    const calls = []; let release; let finish;
    const gate = new Promise(r => { finish = r; });
    const client = { async query(sql) {
      calls.push(sql);
      if (sql === 'COMMIT') { await gate; if (point === 'commit') throw new Error('commit'); }
      if (sql === 'ROLLBACK' && point === 'rollback') throw new Error('rollback');
      return { rows: [] };
    }, release(error) { release = error; calls.push('release'); } };
    let settled = false;
    const promise = repository({ connect: async () => client }).record(1, input(), async () => {
      if (point === 'rollback') throw new Error('work'); return historic;
    }).then(r => { settled = true; return r; });
    if (point === 'rollback') await assert.rejects(promise, /work/);
    else {
      await new Promise(r => setImmediate(r)); assert.equal(settled, false); finish();
      if (point === 'commit') await assert.rejects(promise, /commit/);
      else assert.deepEqual(await promise, historic);
    }
    assert.equal(Boolean(release), point !== 'success'); assert.equal(calls.at(-1), 'release');
    assert.equal(calls.includes('ROLLBACK'), point !== 'success');
  }
});

test('NUMERIC corrupto se rechaza sin redondeo ni escritura', async () => {
  for (const value of ['NaN', 'Infinity', '2.50001', '2.5x', '', ' 2.5', '1.2999', '10000.0000', null]) {
    const calls = [];
    const client = { query: async (sql) => {
      calls.push(sql); return { rows: sql.includes('FOR UPDATE') ? [{ ease_factor: value }] : [] };
    }, release() {} };
    await assert.rejects(repository({ connect: async () => client }).record(1, input(), tx => tx.findProgress()));
    assert.ok(calls.includes('ROLLBACK')); assert.ok(!calls.some(s => /INSERT|UPDATE SET/.test(s)));
  }
});

test('Swagger incluye contrato y todos los estados', () => {
  const spec = require('../src/config/swagger'); const endpoint = spec.paths['/api/reviews'].post;
  assert.deepEqual(Object.keys(endpoint.responses).sort(), ['200','400','401','403','404','409','429','500','503']);
  assert.deepEqual(endpoint.security, [{ bearerAuth: [] }]);
  assert.equal(spec.components.schemas.ReviewInput.additionalProperties, false);
  assert.equal('repetitions' in spec.components.schemas.ReviewResult.properties, false);
});

test('23505 ajeno a requestId no se confunde con idempotencia', async () => {
  let connections = 0; let recovered = false; const calls = [];
  const error = Object.assign(new Error('integridad'), { code: '23505', constraint: 'user_card_progress_pkey' });
  const repo = repository({ connect: async () => {
    connections++;
    return { query: async sql => { calls.push(sql); }, release() {} };
  } });
  await assert.rejects(repo.record(1, input(), async () => { throw error; }, () => { recovered = true; }), error);
  assert.equal(connections, 1); assert.equal(recovered, false); assert.ok(calls.includes('ROLLBACK'));
});

test('23505 idempotente recupera solo después de rollback y liberar el cliente', async () => {
  const calls = []; let connections = 0;
  const repo = repository({ connect: async () => {
    const id = ++connections;
    return { query: async sql => {
      calls.push([id, sql]);
      return { rows: [{ id: '123', flashcard_id: 5, quality: 5, ease_factor_after: '2.6000',
        interval_after_days: 1, reviewed_at: instant, next_review_at: new Date(historic.nextReviewAt) }] };
    }, release() { calls.push([id, 'release']); } };
  } });
  const response = await repo.record(1, input(), async () => {
    throw Object.assign(new Error(), { code: '23505', constraint: 'card_reviews_user_id_request_id_key' });
  }, original => ({ ...original, replayed: true }));
  assert.deepEqual(response, { ...historic, replayed: true });
  assert.deepEqual(calls.slice(0, 3), [[1, 'BEGIN ISOLATION LEVEL READ COMMITTED'], [1, 'ROLLBACK'], [1, 'release']]);
  assert.equal(connections, 2); assert.equal(calls[3][0], 2);
});
