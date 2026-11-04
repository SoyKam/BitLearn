const assert = require('node:assert/strict');
const { test } = require('node:test');
const { once } = require('node:events');
const express = require('express');
const createLessonRepository = require('../src/repositories/lesson.repository');
const createProgressRepository = require('../src/repositories/progress.repository');
const { createLessonService, questionSchema, LearningInputError, LearningNotFoundError } = require('../src/services/lesson.service');
const createLessonRouter = require('../src/routes/lesson.routes');
const createProgressRouter = require('../src/routes/progress.routes');
const errorHandler = require('../src/middlewares/error-handler');
const { seedQuestions, QuestionSeedError } = require('../src/config/seed-questions');
const serve = require('./helpers/course-app');

const question = { id: 12, prompt: 'Pregunta', options: ['A', 'B'], correct_option_index: 1, explanation: null };

test('repositorios: parámetros separados, pertenencia y ausencia de interpolación de entradas', async () => {
  const calls = [];
  const database = { async query(...args) { calls.push(args); return { rows: [] }; } };
  const lessons = createLessonRepository(database);
  const progress = createProgressRepository(database);
  const injection = "1; DROP TABLE users; --";
  assert.equal(await lessons.findById(injection), null);
  assert.deepEqual(calls.at(-1)[1], [injection]);
  await lessons.findQuestions(injection);
  assert.deepEqual(calls.at(-1)[1], [injection]);
  assert.equal(await lessons.findQuestion(injection, 12), null);
  assert.deepEqual(calls.at(-1)[1], [injection, 12]);
  assert.match(calls.at(-1)[0], /lesson_id = \$1 AND id = \$2/);
  await progress.recordAnswer(injection, 5, true);
  assert.deepEqual(calls.at(-1)[1], [injection, 5, 1]);
  await progress.findByUser(injection);
  assert.deepEqual(calls.at(-1)[1], [injection]);
  assert.ok(calls.every(([sql]) => !sql.includes(injection)));
});

test('servicio: contrato público explícito y validación de datos almacenados antes de escribir', async () => {
  let writes = 0;
  let q = { ...question, password: 'secreto' };
  const lesson = { id: 5, title: 'Título', content: 'Contenido', course_id: 3,
    course_title: 'HTML', course_slug: 'html', unit_id: 4, unit_title: 'Unidad', token: 'privado' };
  const service = createLessonService({
    async findById() { return lesson; }, async findQuestions() { return [q]; },
    async findQuestion() { return q; },
  }, { async recordAnswer() { writes++; return { attempts: 1, correctAnswers: 1, completedAt: new Date() }; } });
  assert.deepEqual((await service.detail(5)).questions, [{ id: 12, prompt: 'Pregunta', options: ['A', 'B'] }]);
  assert.doesNotMatch(JSON.stringify(await service.detail(5)), /correct_option_index|explanation|secreto|privado|token/);
  await assert.rejects(service.answer(1, 5, { questionId: 12, optionIndex: 2 }), LearningInputError);
  for (const options of [['A'], ['A', 'B', 'C', 'D', 'E', 'F', 'G'], ['A', ' '], ['A', 3], {}, null]) {
    q = { ...question, options };
    await assert.rejects(service.answer(1, 5, { questionId: 12, optionIndex: 1 }));
  }
  for (const index of [-1, 2, 1.5]) {
    assert.equal(questionSchema.safeParse({ ...question, correct_option_index: index }).success, false);
  }
  q = null;
  await assert.rejects(service.answer(1, 5, { questionId: 12, optionIndex: 1 }), LearningNotFoundError);
  assert.equal(writes, 0);
});

test('rutas privadas: errores PostgreSQL seguros, incluso durante verificación de sesión', async (t) => {
  t.mock.method(console, 'error', () => {});
  let failure;
  const base = await serve(t, { async query() { throw failure; } });
  for (const code of ['ECONNREFUSED', '57P03', '53300', '42501', 'XX000']) {
    failure = Object.assign(new Error('SELECT password FROM users; secreto pg'), { code });
    for (const path of ['/api/lessons/1']) {
      const response = await fetch(base + path);
      assert.equal(response.status, ['ECONNREFUSED', '57P03', '53300'].includes(code) ? 503 : 500);
      assert.ok(response.headers.get('x-correlation-id'));
      assert.doesNotMatch(await response.text(), /SELECT|password|secreto|stack|pg/);
    }
  }
  const app = express();
  const auth = { async authenticate() { throw failure; } };
  app.use('/api/lessons', createLessonRouter({}, auth));
  app.use('/api/progress', createProgressRouter({}, auth));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  failure = Object.assign(new Error('pg privado'), { code: 'ECONNREFUSED' });
  for (const [path, method] of [['/api/lessons/1/answer', 'POST'], ['/api/progress', 'GET']]) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}${path}`, {
      method, headers: { Authorization: 'Bearer a.b.c' },
    });
    assert.equal(response.status, 503);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.ok(response.headers.get('x-correlation-id'));
    assert.doesNotMatch(await response.text(), /pg|privado/);
  }
});

test('límite de respuestas: solicitud 61 devuelve 429 sin evaluar ni registrar', async (t) => {
  let attempts = 0;
  const app = express();
  app.use('/api/lessons', createLessonRouter({ async answer(userId) {
    assert.equal(userId, 73); attempts++; return { correct: true };
  } }, { async authenticate() { return { userId: 73, sessionId: 1 }; } }));
  app.use(errorHandler);
  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');
  for (let index = 0; index < 61; index++) {
    const response = await fetch(`http://127.0.0.1:${server.address().port}/api/lessons/1/answer`, {
      method: 'POST', headers: { Authorization: 'Bearer a.b.c', 'Content-Type': 'application/json' },
      body: JSON.stringify({ questionId: 1, optionIndex: 0 }),
    });
    assert.equal(response.status, index === 60 ? 429 : 200);
    if (index === 60) {
      assert.ok(response.headers.get('retry-after'));
      assert.ok(response.headers.get('x-correlation-id'));
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    await response.arrayBuffer();
  }
  assert.equal(attempts, 60);
});

test('seed: errores de conexión/rollback controlados y liberación del cliente', async () => {
  await assert.rejects(seedQuestions({ async connect() { throw new Error('password privado'); } }),
    (error) => error instanceof QuestionSeedError && !/password|privado/.test(error.message));
  for (const rollbackFails of [false, true]) {
    const calls = [];
    let released;
    await assert.rejects(seedQuestions({ async connect() { return {
      async query(sql) {
        calls.push(sql);
        if (sql.startsWith('LOCK TABLE')) throw new Error('tabla ausente');
        if (sql === 'ROLLBACK' && rollbackFails) throw new Error('sin conexión');
      }, release(discard) { released = discard; },
    }; } }), QuestionSeedError);
    assert.equal(calls.at(-1), 'ROLLBACK');
    assert.equal(released, rollbackFails);
    assert.ok(!calls.includes('COMMIT'));
  }
});

test('Swagger: tres endpoints, contratos cerrados, errores, Bearer y privacidad', () => {
  const spec = require('../src/config/swagger');
  for (const [path, method, statuses, security] of [
    ['/api/lessons/{id}', 'get', ['200', '400', '404', '500', '503'], []],
    ['/api/lessons/{id}/answer', 'post', ['200', '400', '401', '404', '429', '500', '503'], [{ bearerAuth: [] }]],
    ['/api/progress', 'get', ['200', '401', '500', '503'], [{ bearerAuth: [] }]],
  ]) {
    const operation = spec.paths[path][method];
    assert.deepEqual(Object.keys(operation.responses), statuses);
    assert.deepEqual(operation.security, security);
    if (security.length) {
      for (const response of Object.values(operation.responses)) {
        assert.deepEqual(response.headers['Cache-Control'].schema.enum, ['no-store']);
      }
    }
  }
  assert.equal(spec.components.schemas.LessonAnswer.additionalProperties, false);
  assert.deepEqual(spec.components.schemas.LessonAnswer.required, ['questionId', 'optionIndex']);
  assert.deepEqual(Object.keys(spec.components.schemas.LessonQuestion.properties), ['id', 'prompt', 'options']);
  // Commit #26 implementa las consultas; dashboard sigue fuera de alcance.
  assert.ok(spec.paths['/api/reviews/due'].get);
  assert.ok(spec.paths['/api/reviews/history'].get);
  assert.doesNotMatch(JSON.stringify(spec.paths), /\/api\/dashboard/);
});
