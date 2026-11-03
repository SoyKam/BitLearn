const assert = require('node:assert/strict');
const { test } = require('node:test');
const { setTimeout: delay } = require('node:timers/promises');
const { Pool } = require('pg');
const jwt = require('jsonwebtoken');
const { temporaryPostgres, postgresSkip } = require('./helpers/temporary-postgres');
const serve = require('./helpers/course-app');
const migrate = require('../src/config/migrate');
const { seedCatalog } = require('../src/config/seed-catalog');
const { seedQuestions } = require('../src/config/seed-questions');
const loadAuthConfig = require('../src/config/auth');

async function catalogState(pool) {
  const result = {};
  for (const table of ['courses', 'units', 'lessons']) {
    result[table] = (await pool.query(`SELECT * FROM public.${table} ORDER BY id`)).rows;
  }
  return result;
}

test('aprendizaje HTTP y seed con PostgreSQL temporal', { skip: postgresSkip, timeout: 60000 }, async (t) => {
  const { database, connection } = await temporaryPostgres(t);
  const isolated = await database(t);
  const pool = new Pool({ ...connection, database: isolated.options.database, max: 8,
    application_name: 'bitlearn-learning-test' });
  t.after(() => pool.end());
  await migrate(pool, { log() {} });
  await pool.query("SELECT setval('courses_id_seq', 31, false), setval('units_id_seq', 41, false), setval('lessons_id_seq', 51, false)");
  await seedCatalog(pool);
  const before = await catalogState(pool);

  await t.test('seed crea nueve preguntas sin IDs fijos ni cambios de catálogo; repetición idempotente', async () => {
    assert.equal((await seedQuestions(pool)).filter((r) => r.created).length, 9);
    const first = (await pool.query('SELECT * FROM questions ORDER BY id')).rows;
    assert.equal(first.length, 9);
    assert.ok(first.every((q) => q.lesson_id >= 51));
    assert.equal((await seedQuestions(pool)).filter((r) => r.created).length, 0);
    assert.deepEqual((await pool.query('SELECT * FROM questions ORDER BY id')).rows, first);
    assert.deepEqual(await catalogState(pool), before);
  });

  await t.test('conflicto tardío revierte inserciones previas, no sobrescribe y detecta identidad incorrecta', async () => {
    const original = (await pool.query('SELECT * FROM questions ORDER BY id')).rows;
    await pool.query('DELETE FROM questions WHERE id = $1', [original[0].id]);
    await pool.query("UPDATE questions SET explanation = 'Contenido distinto' WHERE id = $1", [original[8].id]);
    const conflicting = (await pool.query('SELECT * FROM questions ORDER BY id')).rows;
    await assert.rejects(seedQuestions(pool), /Conflicto/);
    assert.deepEqual((await pool.query('SELECT * FROM questions ORDER BY id')).rows, conflicting);
    await pool.query('UPDATE questions SET explanation = $1 WHERE id = $2', [original[8].explanation, original[8].id]);
    await pool.query("UPDATE lessons SET title = 'Otro título' WHERE id = $1", [original[8].lesson_id]);
    await assert.rejects(seedQuestions(pool), /identidad/);
    assert.equal((await pool.query('SELECT count(*)::int AS n FROM questions')).rows[0].n, 8);
    await pool.query('UPDATE lessons SET title = $1 WHERE id = $2',
      [before.lessons.find((l) => l.id === original[8].lesson_id).title, original[8].lesson_id]);
    await seedQuestions(pool);
    assert.deepEqual(await catalogState(pool), before);
  });

  const base = await serve(t, pool);
  async function request(path, { token, body, method = 'GET', raw } = {}) {
    const response = await fetch(base + path, { method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...((body !== undefined || raw !== undefined) ? { 'Content-Type': 'application/json' } : {}) },
      body: raw !== undefined ? raw : body !== undefined ? JSON.stringify(body) : undefined });
    assert.ok(response.headers.get('x-correlation-id'));
    if (path.startsWith('/api/progress') || path.endsWith('/answer')) {
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    return { status: response.status, data: await response.json() };
  }
  const identities = [];
  for (const name of ['Alice', 'Bob']) {
    const credentials = { name, email: `${name.toLowerCase()}@example.invalid`, password: 'Password-ficticio-123' };
    const registered = await request('/api/auth/register', { method: 'POST', body: credentials });
    assert.equal(registered.status, 201);
    const login = await request('/api/auth/login', { method: 'POST', body: { email: credentials.email, password: credentials.password } });
    assert.equal(login.status, 200);
    identities.push({ id: registered.data.data.id, token: login.data.data.accessToken });
  }
  const [alice, bob] = identities;
  const questions = (await pool.query('SELECT * FROM questions ORDER BY lesson_id')).rows;
  const q = questions[0];
  const path = `/api/lessons/${q.lesson_id}`;
  const answer = (optionIndex, token = alice.token, questionId = q.id) => request(`${path}/answer`, {
    method: 'POST', token, body: { questionId, optionIndex },
  });
  const state = async () => (await pool.query('SELECT * FROM user_lesson_progress ORDER BY user_id, lesson_id')).rows;

  await t.test('detalle público: contenido, relaciones y preguntas ordenadas; sin solución ni explicación', async () => {
    await pool.query(`INSERT INTO questions (lesson_id, position, prompt, options, correct_option_index)
      VALUES ($1, 3, 'Tercera', '["A","B"]', 0), ($1, 2, 'Segunda', '["A","B"]', 1)`, [q.lesson_id]);
    const result = await request(path);
    assert.equal(result.status, 200);
    const lesson = before.lessons.find((l) => l.id === q.lesson_id);
    const unit = before.units.find((u) => u.id === lesson.unit_id);
    const course = before.courses.find((c) => c.id === unit.course_id);
    assert.deepEqual(result.data.data, {
      id: lesson.id, title: lesson.title, content: lesson.content,
      course: { id: course.id, title: course.title, slug: course.slug }, unit: { id: unit.id, title: unit.title },
      questions: (await pool.query('SELECT id, prompt, options FROM questions WHERE lesson_id = $1 ORDER BY position', [q.lesson_id])).rows,
    });
    assert.doesNotMatch(JSON.stringify(result.data), /correct_option_index|explanation|password|session|token/);
    await pool.query('DELETE FROM questions WHERE lesson_id = $1 AND position > 1', [q.lesson_id]);
  });

  await t.test('lección sin preguntas, 404 y progreso vacío con total dinámico', async () => {
    const extra = (await pool.query("INSERT INTO lessons (unit_id, title, position) VALUES ($1, 'Extra', 10) RETURNING id", [before.units[0].id])).rows[0];
    const result = await request(`/api/lessons/${extra.id}`);
    assert.equal(result.status, 200);
    assert.deepEqual(result.data.data.questions, []);
    assert.equal((await request('/api/lessons/2147483647')).status, 404);
    const progress = await request('/api/progress', { token: alice.token });
    assert.deepEqual(progress.data, { success: true, data: { completedLessons: 0, totalLessons: 10, lessons: [] } });
  });

  await t.test('IDs estrictos, inyección, JSON inválido y campos extra no modifican progreso', async () => {
    const initial = await state();
    for (const id of ['0', '-1', '+1', '1.5', '1e1', ' 1', '1 ', '1\n', '2147483648', "1 OR 1=1", '1;DROP TABLE users']) {
      for (const suffix of ['', '/answer']) {
        assert.equal((await request(`/api/lessons/${encodeURIComponent(id)}${suffix}`, {
          ...(suffix ? { method: 'POST', token: alice.token, body: { questionId: q.id, optionIndex: 0 } } : {}),
        })).status, 400, id);
      }
    }
    assert.equal((await request('/api/lessons/%ZZ')).status, 400);
    for (const body of [null, [], {}, { questionId: '1', optionIndex: 0 },
      { questionId: 0, optionIndex: 0 }, { questionId: 2147483648, optionIndex: 0 },
      { questionId: q.id, optionIndex: -1 }, { questionId: q.id, optionIndex: 0.5 },
      { questionId: q.id, optionIndex: '0' },
      ...['userId', 'user_id', 'correct', 'attempts', 'quality'].map((key) => ({ questionId: q.id, optionIndex: 0, [key]: bob.id }))]) {
      assert.equal((await request(`${path}/answer`, { method: 'POST', token: alice.token, body })).status, 400);
    }
    for (const raw of ['{broken', 'x'.repeat(4097)]) {
      assert.equal((await request(`${path}/answer`, { method: 'POST', token: alice.token, raw })).status, 400);
    }
    assert.equal((await answer(4)).status, 400);
    assert.equal((await answer(0, alice.token, questions[1].id)).status, 404);
    assert.equal((await answer(0, alice.token, 2147483647)).status, 404);
    assert.deepEqual(await state(), initial);
  });

  await t.test('JWT ausente, inválido, expirado y sesión revocada: 401 en ambas rutas privadas', async () => {
    const config = loadAuthConfig();
    const claims = jwt.decode(bob.token);
    const expired = jwt.sign({ ...claims, iat: Math.floor(Date.now() / 1000) - 100, exp: Math.floor(Date.now() / 1000) - 1 }, config.signingKey);
    const invalid = jwt.sign(claims, Buffer.alloc(32, 1));
    await pool.query('UPDATE auth_sessions SET revoked_at = clock_timestamp() WHERE id = $1', [claims.sid]);
    for (const token of [undefined, 'invalid', invalid, expired, bob.token]) {
      assert.equal((await request('/api/progress', { token })).status, 401);
      assert.equal((await answer(0, token || '')).status, 401);
    }
    // Nueva sesión legítima mediante login; la revocada no se reactiva.
    const login = await request('/api/auth/login', { method: 'POST', body: {
      email: 'bob@example.invalid', password: 'Password-ficticio-123',
    } });
    bob.token = login.data.data.accessToken;
    assert.deepEqual(await state(), []);
  });

  await t.test('fallo, acierto y repetición: contadores, explicación y primera finalización', async () => {
    const wrong = await answer((q.correct_option_index + 1) % q.options.length);
    assert.equal(wrong.status, 200);
    assert.deepEqual(wrong.data.data, { correct: false, completed: false, explanation: q.explanation,
      progress: { attempts: 1, correctAnswers: 0, completedAt: null } });
    const right = await answer(q.correct_option_index);
    assert.equal(right.status, 200);
    const firstDate = right.data.data.progress.completedAt;
    assert.ok(firstDate);
    const again = await answer(q.correct_option_index);
    assert.equal(again.data.data.correct, true);
    assert.deepEqual(again.data.data.progress, { attempts: 3, correctAnswers: 2, completedAt: firstDate });
    const wrongAgain = await answer((q.correct_option_index + 1) % q.options.length);
    assert.equal(wrongAgain.data.data.completed, true);
    assert.deepEqual(wrongAgain.data.data.progress, { attempts: 4, correctAnswers: 2, completedAt: firstDate });
  });

  await t.test('dos respuestas realmente bloqueadas concurrentes conservan ambos incrementos', async () => {
    const initial = (await state())[0];
    const blocker = await pool.connect();
    let pending = [];
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT * FROM user_lesson_progress WHERE user_id = $1 AND lesson_id = $2 FOR UPDATE', [alice.id, q.lesson_id]);
      pending = [answer(q.correct_option_index), answer(q.correct_option_index)];
      const deadline = Date.now() + 5000;
      let blocked = false;
      while (Date.now() < deadline) {
        const { rows } = await pool.query("SELECT count(*)::int AS n FROM pg_stat_activity WHERE application_name = 'bitlearn-learning-test' AND wait_event_type = 'Lock'");
        if (rows[0].n >= 2) { blocked = true; break; }
        await delay(10);
      }
      assert.ok(blocked, 'Ambas solicitudes deben esperar el bloqueo PostgreSQL');
      await blocker.query('COMMIT');
      assert.deepEqual((await Promise.all(pending)).map((r) => r.status), [200, 200]);
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
      await Promise.allSettled(pending);
    }
    const final = (await state())[0];
    assert.equal(final.attempts, initial.attempts + 2);
    assert.equal(final.correct_answers, initial.correct_answers + 2);
    assert.deepEqual(final.completed_at, initial.completed_at);
  });

  await t.test('aislamiento, orden, conteo y explicación null; parámetros no seleccionan otro usuario', async () => {
    const initial = (await state())[0];
    const otherQ = questions[3];
    await pool.query('UPDATE questions SET explanation = NULL WHERE id = $1', [otherQ.id]);
    const other = await request(`/api/lessons/${otherQ.lesson_id}/answer`, { method: 'POST', token: bob.token,
      body: { questionId: otherQ.id, optionIndex: otherQ.correct_option_index } });
    assert.equal(other.status, 200);
    assert.equal(other.data.data.explanation, null);
    await request(`/api/lessons/${otherQ.lesson_id}/answer`, { method: 'POST', token: alice.token,
      body: { questionId: otherQ.id, optionIndex: otherQ.correct_option_index } });
    assert.deepEqual((await state()).find((r) => r.user_id === alice.id && r.lesson_id === q.lesson_id), initial);
    const a = await request(`/api/progress?userId=${bob.id}`, { token: alice.token });
    const b = await request(`/api/progress?userId=${alice.id}`, { token: bob.token });
    assert.equal(a.data.data.completedLessons, 2);
    assert.equal(a.data.data.totalLessons, 10);
    assert.deepEqual(a.data.data.lessons.map((l) => l.courseSlug), ['css', 'html']);
    assert.equal(b.data.data.completedLessons, 1);
    assert.equal(b.data.data.lessons.length, 1);
    assert.equal(b.data.data.lessons[0].attempts, 1);
    assert.doesNotMatch(JSON.stringify(a.data), /user_id|session|token|password/);
  });

  await t.test('fallo PostgreSQL durante escritura es seguro y atómico', async (context) => {
    context.mock.method(console, 'error', () => {});
    const initial = await state();
    await pool.query('ALTER TABLE user_lesson_progress ADD CONSTRAINT learning_test_failure CHECK (attempts < 0) NOT VALID');
    try {
      const response = await answer(q.correct_option_index);
      assert.equal(response.status, 500);
      assert.deepEqual(response.data, { success: false, message: 'No se pudo completar la solicitud.' });
      assert.deepEqual(await state(), initial);
    } finally {
      await pool.query('ALTER TABLE user_lesson_progress DROP CONSTRAINT learning_test_failure');
    }
  });
});
