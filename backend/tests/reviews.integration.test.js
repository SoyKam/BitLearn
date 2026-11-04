const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { temporaryPostgres, postgresSkip } = require('./helpers/temporary-postgres');
const serve = require('./helpers/course-app');
const migrate = require('../src/config/migrate');
const { seedCatalog } = require('../src/config/seed-catalog');
const { seedQuestions } = require('../src/config/seed-questions');
const { seedFlashcards } = require('../src/config/seed-flashcards');
const repository = require('../src/repositories/review.repository');
const { createReviewService, ReviewConflictError, ReviewNotDueError } = require('../src/services/review.service');
const loadAuthConfig = require('../src/config/auth');

test('repasos con PostgreSQL temporal aislado', { skip: postgresSkip, timeout: 60000 }, async (t) => {
  t.mock.method(console, 'error', () => {});
  const { database, connection } = await temporaryPostgres(t);
  const isolated = await database(t);
  const pool = new Pool({ ...connection, database: isolated.options.database, max: 8,
    application_name: 'bitlearn-reviews-test', statement_timeout: 10000 });
  t.after(() => pool.end());
  await migrate(pool, { log() {} }); await seedCatalog(pool); await seedQuestions(pool); await seedFlashcards(pool);
  const shared = (await pool.query('SELECT * FROM flashcards ORDER BY id')).rows;
  const [card, other] = shared;
  const base = await serve(t, pool);
  async function request(path, body, token) {
    const res = await fetch(base + path, { method: 'POST', headers: { 'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    if (path === '/api/reviews') {
      assert.equal(res.headers.get('cache-control'), 'no-store'); assert.ok(res.headers.get('x-correlation-id'));
    }
    return { status: res.status, body: await res.json() };
  }
  const users = [];
  for (const name of ['Alice', 'Bob']) {
    const credentials = { name, email: `${name}@example.invalid`, password: 'Ficticio-password-123' };
    const registered = await request('/api/auth/register', credentials); assert.equal(registered.status, 201);
    const login = await request('/api/auth/login', { email: credentials.email, password: credentials.password });
    assert.equal(login.status, 200);
    users.push({ id: registered.body.data.id, token: login.body.data.accessToken });
  }
  const [alice, bob] = users;
  const payload = (id = card.id, quality = 5) => ({ flashcardId: id, quality, requestId: randomUUID() });
  const post = (body, token = alice.token) => request('/api/reviews', body, token);
  const snapshot = async () => ({
    progress: (await pool.query('SELECT * FROM user_card_progress ORDER BY user_id, flashcard_id')).rows,
    history: (await pool.query('SELECT * FROM card_reviews ORDER BY id')).rows,
  });
  await t.test('JWT ausente, inválido, expirado y sesión revocada', async () => {
    const claims = jwt.decode(bob.token);
    const expired = jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 1 }, loadAuthConfig().signingKey);
    for (const token of ['', 'bad', 'a.b.c', expired]) assert.equal((await post(payload(), token)).status, 401);
    await pool.query('UPDATE auth_sessions SET revoked_at = clock_timestamp() WHERE id = $1', [claims.sid]);
    assert.equal((await post(payload(), bob.token)).status, 401);
    bob.token = (await request('/api/auth/login', { email: 'Bob@example.invalid', password: 'Ficticio-password-123' })).body.data.accessToken;
    assert.deepEqual(await snapshot(), { progress: [], history: [] });
  });
  await t.test('404, activación requiere lección completada y no admite userId ni SQL', async () => {
    assert.equal((await post(payload(2147483647))).status, 404);
    assert.equal((await post(payload())).status, 403);
    assert.equal((await post({ ...payload(), userId: bob.id })).status, 400);
    assert.equal((await post(payload('1; DROP TABLE users'))).status, 400);
    assert.deepEqual(await snapshot(), { progress: [], history: [] });
    await pool.query(`INSERT INTO user_lesson_progress(user_id, lesson_id, completed_at)
      SELECT u.id, l.id, clock_timestamp() FROM users u CROSS JOIN lessons l`);
  });
  let first; const original = payload();
  await t.test('primer repaso persiste estado e historial coherentes y protege catálogo y otros usuarios', async () => {
    const res = await post(original); assert.equal(res.status, 200); first = res.body.data;
    const { progress: [p], history: [h] } = await snapshot();
    assert.equal(p.user_id, alice.id); assert.equal(p.flashcard_id, card.id);
    assert.equal(p.repetitions, 1); assert.equal(p.ease_factor, '2.6000'); assert.equal(p.interval_days, 1);
    assert.equal(p.next_review_at.getTime() - p.last_review_at.getTime(), 86400000);
    assert.equal(h.user_id, alice.id); assert.equal(h.request_id, original.requestId);
    assert.equal(h.ease_factor_before, '2.5000'); assert.equal(h.ease_factor_after, p.ease_factor);
    assert.equal(h.interval_before_days, 0); assert.equal(h.interval_after_days, 1);
    assert.deepEqual(h.reviewed_at, p.last_review_at); assert.deepEqual(h.next_review_at, p.next_review_at);
    assert.equal(first.reviewId, h.id); assert.equal(first.replayed, false);
    assert.doesNotMatch(JSON.stringify(res.body), /user_id|password|token|repetitions|session/);
    assert.deepEqual((await pool.query('SELECT * FROM flashcards ORDER BY id')).rows, shared);
    assert.equal((await post(payload(), bob.token)).status, 200);
    assert.deepEqual((await snapshot()).progress.find(r => r.user_id === alice.id), p);
  });
  await t.test('reenvío histórico, conflictos y vencimiento sin escrituras', async () => {
    const before = await snapshot();
    assert.deepEqual((await post(original)).body.data, { ...first, replayed: true });
    for (const change of [{ quality: 3 }, { flashcardId: other.id }]) {
      assert.equal((await post({ ...original, ...change })).status, 409);
    }
    assert.equal((await post(payload())).status, 409); assert.deepEqual(await snapshot(), before);
  });
  let now = new Date(first.nextReviewAt);
  const service = createReviewService(repository(pool, { clock: () => now }));
  await t.test('revisión vencida usa estado previo; reenvío antiguo conserva resultado original', async () => {
    const second = await service.record(alice.id, payload());
    assert.equal(second.intervalDays, 6); assert.equal(second.easeFactor, 2.7);
    const p = (await snapshot()).progress.find(r => r.user_id === alice.id);
    assert.equal(p.repetitions, 2); assert.equal(p.next_review_at.getTime(), now.getTime() + 6 * 86400000);
    assert.deepEqual((await post(original)).body.data, { ...first, replayed: true });
  });
  for (const table of ['card_reviews', 'user_card_progress']) {
    await t.test(`fallo de ${table} revierte estado e historial, respuesta 500 segura`, async () => {
      const before = await snapshot();
      await pool.query(`ALTER TABLE ${table} ADD CONSTRAINT reviews_test_failure CHECK (false) NOT VALID`);
      try {
        const res = await post(payload(other.id)); assert.equal(res.status, 500);
        assert.deepEqual(res.body, { success: false, message: 'No se pudo completar la solicitud.' });
        assert.deepEqual(await snapshot(), before);
      } finally { await pool.query(`ALTER TABLE ${table} DROP CONSTRAINT reviews_test_failure`); }
    });
  }
  // Bloqueo externo y observación pg_stat_activity aseguran solapamiento real.
  async function concurrentlyBlocked(id, bodies) {
    const blocker = await pool.connect(); let pending = [];
    try {
      await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock($1::integer,$2::integer)', [alice.id, id]);
      pending = bodies.map(body => service.record(alice.id, body));
      // Adjuntar manejadores de inmediato evita rechazos sin manejar al desbloquear.
      const results = Promise.allSettled(pending);
      let blocked = false;
      for (let n = 0; n < 300; n++) {
        const { rows } = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'bitlearn-reviews-test' AND wait_event_type = 'Lock'");
        if (rows[0].n >= bodies.length) { blocked = true; break; } await delay(10);
      }
      assert.ok(blocked, 'Ambas operaciones esperan el bloqueo real');
      await blocker.query('COMMIT'); return await results;
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await Promise.allSettled(pending); }
  }
  await t.test('dos primeros repasos distintos simultáneos: uno confirma, otro no pendiente', async () => {
    const results = await concurrentlyBlocked(other.id, [payload(other.id), payload(other.id)]);
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(results.find(r => r.status === 'rejected').reason instanceof ReviewNotDueError);
    const state = await snapshot();
    assert.equal(state.progress.filter(r => r.user_id === alice.id && r.flashcard_id === other.id).length, 1);
    assert.equal(state.history.filter(r => r.user_id === alice.id && r.flashcard_id === other.id).length, 1);
  });
  await t.test('solicitudes idénticas simultáneas, estado único y locks liberados', async () => {
    const id = shared[2].id; const body = payload(id);
    const results = await concurrentlyBlocked(id, [body, body]);
    assert.ok(results.every(r => r.status === 'fulfilled'));
    const values = results.map(r => r.value);
    assert.deepEqual(values.map(r => r.replayed).sort(), [false, true]);
    assert.equal(values[0].reviewId, values[1].reviewId);
    assert.equal((await pool.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'")).rows[0].n, 0);
  });
  await t.test('carrera UNIQUE entre tarjetas distintas revierte completamente la perdedora', async () => {
    let arrived = 0; let unblock; const barrier = new Promise(r => { unblock = r; });
    const wrapped = { async connect() {
      const client = await pool.connect();
      return { release: error => client.release(error), async query(sql, params) {
        if (sql.includes('INSERT INTO public.card_reviews')) {
          if (++arrived === 2) unblock(); await barrier;
        }
        return client.query(sql, params);
      } };
    } };
    const concurrent = createReviewService(repository(wrapped, { clock: () => now }));
    const before = await snapshot(); const requestId = randomUUID();
    const results = await Promise.allSettled([shared[3], shared[4]].map(c => concurrent.record(alice.id, { ...payload(c.id), requestId })));
    assert.equal(arrived, 2); assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.ok(results.find(r => r.status === 'rejected').reason instanceof ReviewConflictError);
    const after = await snapshot(); assert.equal(after.progress.length, before.progress.length + 1);
    assert.equal(after.history.length, before.history.length + 1);
    assert.equal(after.history.filter(r => r.request_id === requestId).length, 1);
  });
  await t.test('estado e historial no son visibles ni se devuelve éxito antes de COMMIT', async () => {
    let atCommit; const reached = new Promise(r => { atCommit = r; });
    let allowCommit; const gate = new Promise(r => { allowCommit = r; });
    const wrapped = { async connect() {
      const client = await pool.connect();
      return { release: error => client.release(error), async query(sql, params) {
        if (sql === 'COMMIT') { atCommit(); await gate; }
        return client.query(sql, params);
      } };
    } };
    const controlled = createReviewService(repository(wrapped, { clock: () => now }));
    const before = await snapshot(); let settled = false;
    const pending = controlled.record(alice.id, payload(shared[5].id)).then(r => { settled = true; return r; });
    try {
      await reached;
      assert.equal(settled, false);
      assert.deepEqual(await snapshot(), before);
    } finally { allowCommit(); }
    assert.equal((await pending).replayed, false);
    const after = await snapshot();
    assert.equal(after.progress.length, before.progress.length + 1);
    assert.equal(after.history.length, before.history.length + 1);
  });
  await t.test('fallo al actualizar un estado existente revierte y conserva historial', async () => {
    now = new Date('2030-01-01T00:00:00Z'); const before = await snapshot();
    await pool.query('ALTER TABLE user_card_progress ADD CONSTRAINT reviews_test_failure CHECK (repetitions < 3) NOT VALID');
    try { await assert.rejects(service.record(alice.id, payload())); assert.deepEqual(await snapshot(), before); }
    finally { await pool.query('ALTER TABLE user_card_progress DROP CONSTRAINT reviews_test_failure'); }
  });
  assert.deepEqual((await pool.query('SELECT * FROM flashcards ORDER BY id')).rows, shared);
});
