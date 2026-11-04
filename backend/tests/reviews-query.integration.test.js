const assert = require('node:assert/strict');
const { test } = require('node:test');
const { randomUUID } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { temporaryPostgres, postgresSkip } = require('./helpers/temporary-postgres');
const serve = require('./helpers/course-app');
const migrate = require('../src/config/migrate');
const { seedCatalog } = require('../src/config/seed-catalog');
const { seedQuestions } = require('../src/config/seed-questions');
const { seedFlashcards } = require('../src/config/seed-flashcards');
const repository = require('../src/repositories/review.repository');
const { createReviewService } = require('../src/services/review.service');
const loadAuthConfig = require('../src/config/auth');

test('consultas de repasos con PostgreSQL temporal', { skip: postgresSkip, timeout: 60000 }, async t => {
  const { database } = await temporaryPostgres(t); const pool = await database(t);
  await migrate(pool, { log() {} }); await seedCatalog(pool); await seedQuestions(pool); await seedFlashcards(pool);
  const cards = (await pool.query(`SELECT f.*, c.slug, l.title AS lesson_title FROM flashcards f
    JOIN lessons l ON l.id=f.lesson_id JOIN units u ON u.id=l.unit_id JOIN courses c ON c.id=u.course_id
    ORDER BY c.slug,u.position,l.position,f.position,f.id`)).rows;
  const card = cards[0]; const base = await serve(t, pool);
  async function request(path, token, body) {
    const res = await fetch(base + path, { method: body ? 'POST' : 'GET',
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    if (path.startsWith('/api/reviews')) {
      assert.equal(res.headers.get('cache-control'), 'no-store'); assert.ok(res.headers.get('x-correlation-id'));
    }
    return { status: res.status, body: await res.json() };
  }
  const users = [];
  for (const name of ['Alice', 'Bob']) {
    const credentials = { name, email: `${name}@example.invalid`, password: 'Ficticio-password-123' };
    const registered = await request('/api/auth/register', null, credentials); assert.equal(registered.status, 201);
    const login = await request('/api/auth/login', null, { email: credentials.email, password: credentials.password });
    assert.equal(login.status, 200); users.push({ id: registered.body.data.id, token: login.body.data.accessToken });
  }
  const [alice, bob] = users;
  async function snapshot() {
    const result = {};
    for (const table of ['courses','units','lessons','questions','flashcards','users','auth_sessions',
      'auth_refresh_tokens','user_lesson_progress','user_card_progress','card_reviews']) {
      result[table] = (await pool.query(`SELECT * FROM public.${table} ORDER BY 1, 2`)).rows;
    }
    return result;
  }
  // El helper usa max:1: todos los GET y su autenticación comparten el modo read-only.
  async function get(path, user = alice) {
    const before = await snapshot(); await pool.query('SET default_transaction_read_only = on');
    try {
      const result = await request(`/api/reviews/${path}`, user.token);
      assert.equal(result.status, 200, JSON.stringify(result.body));
      assert.deepEqual(await snapshot(), before); return result.body.data;
    } finally { await pool.query('SET default_transaction_read_only = off'); }
  }
  await t.test('sin progreso o lección incompleta: vacíos sin escrituras', async () => {
    assert.deepEqual(await get('due'), []);
    assert.deepEqual(await get('history'), { items: [], total: 0, limit: 20, offset: 0 });
    await pool.query('INSERT INTO user_lesson_progress(user_id,lesson_id) VALUES ($1,$2)', [alice.id, card.lesson_id]);
    assert.deepEqual(await get('due'), []);
    await pool.query('UPDATE user_lesson_progress SET completed_at=clock_timestamp() WHERE user_id=$1', [alice.id]);
  });
  await t.test('lección completada ofrece solo sus tarjetas nuevas sin crear estado', async () => {
    const due = await get('due');
    assert.deepEqual(due.map(c => c.flashcardId), cards.filter(c => c.lesson_id === card.lesson_id).map(c => c.id));
    for (const c of due) {
      assert.equal(c.status, 'new'); assert.equal(c.repetitions, 0); assert.equal(c.easeFactor, 2.5);
      assert.equal(c.intervalDays, 0); assert.equal(c.lastReviewAt, null); assert.equal(c.nextReviewAt, null);
    }
    assert.deepEqual(await get('due', bob), []);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM user_card_progress')).rows[0].n, 0);
    assert.equal((await get('due?limit=1')).length, 1);
  });
  let first;
  await t.test('GET → POST → GET: futuro excluido e historial confirmado', async () => {
    const res = await request('/api/reviews', alice.token, { flashcardId: card.id, quality: 5, requestId: randomUUID() });
    assert.equal(res.status, 200); first = res.body.data;
    assert.ok(!(await get('due')).some(c => c.flashcardId === card.id));
    const history = await get('history'); assert.equal(history.total, 1);
    assert.deepEqual(history.items[0], { reviewId: first.reviewId, flashcardId: card.id, courseSlug: card.slug,
      lessonTitle: card.lesson_title, front: card.front, quality: 5, reviewedAt: first.reviewedAt,
      easeFactorBefore: 2.5, easeFactorAfter: 2.6, intervalBeforeDays: 0, intervalAfterDays: 1, nextReviewAt: first.nextReviewAt });
    assert.deepEqual(await get('history', bob), { items: [], total: 0, limit: 20, offset: 0 });
  });
  const fixed = new Date('2040-01-01T00:00:00Z');
  const service = createReviewService(repository(pool, { clock: () => fixed }));
  await t.test('vencimiento inclusivo, futuro y estado sin lección completada', async () => {
    await pool.query('UPDATE user_lesson_progress SET completed_at=NULL WHERE user_id=$1', [alice.id]);
    await pool.query('UPDATE user_card_progress SET next_review_at=$1 WHERE user_id=$2', [fixed, alice.id]);
    const before = await snapshot(); const due = await service.due(alice.id);
    assert.equal(due.length, 1); assert.equal(due[0].flashcardId, card.id); assert.equal(due[0].status, 'due');
    assert.equal(due[0].easeFactor, 2.6); assert.equal(due[0].nextReviewAt, fixed.toISOString());
    assert.deepEqual(await snapshot(), before);
    await pool.query("UPDATE user_card_progress SET next_review_at=$1::timestamptz + interval '1 millisecond' WHERE user_id=$2", [fixed, alice.id]);
    assert.deepEqual(await service.due(alice.id), []);
    await pool.query("UPDATE user_card_progress SET next_review_at='2000-01-01' WHERE user_id=$1", [alice.id]);
    assert.equal((await get('due')).length, 1);
  });
  await t.test('orden vencidas por antigüedad, luego nuevas por catálogo, límites SQL', async () => {
    await pool.query(`INSERT INTO user_lesson_progress(user_id,lesson_id,completed_at)
      SELECT $1,id,clock_timestamp() FROM lessons ON CONFLICT(user_id,lesson_id)
      DO UPDATE SET completed_at=EXCLUDED.completed_at`, [alice.id]);
    for (const [c, next] of [[cards[10], '1999-01-01'], [cards[5], '2000-01-01']]) {
      await pool.query('INSERT INTO user_card_progress(user_id,flashcard_id,next_review_at) VALUES($1,$2,$3)', [alice.id, c.id, next]);
    }
    const expected = [cards[10], card, cards[5], ...cards.filter(c => ![cards[10].id, card.id, cards[5].id].includes(c.id))].map(c => c.id);
    assert.deepEqual((await get('due')).map(c => c.flashcardId), expected);
    assert.deepEqual((await get('due?limit=2')).map(c => c.flashcardId), expected.slice(0, 2));
    await pool.query(`INSERT INTO flashcards(lesson_id,position,front,back)
      SELECT $1,n,'Extra ' || n,'Respuesta' FROM generate_series(10,120) n`, [card.lesson_id]);
    assert.equal((await get('due')).length, 50); assert.equal((await get('due?limit=100')).length, 100);
  });
  await t.test('historial individual 3 frente a 1, factores independientes, orden y paginación', async () => {
    await pool.query('INSERT INTO user_lesson_progress(user_id,lesson_id,completed_at) VALUES($1,$2,clock_timestamp())', [bob.id, card.lesson_id]);
    const bobReview = await request('/api/reviews', bob.token, { flashcardId: card.id, quality: 2, requestId: randomUUID() });
    assert.equal(bobReview.status, 200);
    // Igual fecha para desempatar por BIGSERIAL; nunca se cambia el historial previo.
    await pool.query('ALTER SEQUENCE card_reviews_id_seq RESTART WITH 9007199254740993');
    const second = await service.record(alice.id, { flashcardId: card.id, quality: 4, requestId: randomUUID() });
    await pool.query('UPDATE user_card_progress SET next_review_at=$1 WHERE user_id=$2 AND flashcard_id=$3', [fixed, alice.id, card.id]);
    const third = await service.record(alice.id, { flashcardId: card.id, quality: 4, requestId: randomUUID() });
    const a = await get('history'); const b = await get('history', bob);
    assert.equal(a.total, 3); assert.equal(b.total, 1);
    assert.deepEqual(a.items.map(r => r.reviewId), [third.reviewId, second.reviewId, first.reviewId]);
    assert.equal(a.items[0].easeFactorAfter, 2.6); assert.equal(b.items[0].easeFactorAfter, 2.18);
    assert.equal(a.items[1].intervalAfterDays, 6); assert.equal(b.items[0].intervalAfterDays, 1);
    assert.equal(a.items[2].reviewedAt, first.reviewedAt); assert.equal(a.items[2].nextReviewAt, first.nextReviewAt);
    assert.deepEqual(await get('history?limit=1&offset=1'), { items: [a.items[1]], total: 3, limit: 1, offset: 1 });
    assert.deepEqual(await get('history?offset=10000'), { items: [], total: 3, limit: 20, offset: 10000 });
    await pool.query("UPDATE user_card_progress SET next_review_at='2000-01-01' WHERE flashcard_id=$1", [card.id]);
    assert.equal((await get('due')).find(c => c.flashcardId === card.id).easeFactor, 2.6);
    assert.equal((await get('due', bob)).find(c => c.flashcardId === card.id).easeFactor, 2.18);
    assert.doesNotMatch(JSON.stringify([a, b]), /user_id|request_id|password|token|session/);
  });
  await t.test('JWT ausente, inválido, expirado o revocado y userId rechazado', async () => {
    const claims = jwt.decode(bob.token);
    const expired = jwt.sign({ ...claims, exp: Math.floor(Date.now() / 1000) - 1 }, loadAuthConfig().signingKey);
    await pool.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1', [claims.sid]);
    const before = await snapshot();
    for (const path of ['due','history']) {
      for (const token of [null, 'a.b.c', expired, bob.token]) assert.equal((await request(`/api/reviews/${path}`, token)).status, 401);
      assert.equal((await request(`/api/reviews/${path}?userId=${bob.id}`, alice.token)).status, 400);
    }
    assert.deepEqual(await snapshot(), before);
  });
});
