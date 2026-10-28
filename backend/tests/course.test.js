const assert = require('node:assert/strict');
const { test } = require('node:test');
const createCourseRepository = require('../src/repositories/course.repository');
const { createCourseService, CatalogUnavailableError } = require('../src/services/course.service');
const createCourseController = require('../src/controllers/course.controller');
const serve = require('./helpers/course-app');

const courses = [
  { id: 83, title: 'CSS', slug: 'css', description: null },
  { id: 42, title: 'HTML', slug: 'html', description: 'Estructura web' },
];
const sql = 'SELECT id, title, slug, description FROM public.courses ORDER BY title ASC, id ASC';
const privateMessage = 'SELECT password FROM users; host=private.invalid password=secreto-ficticio';

test('repositorio: solo consulta pública estática, sin entradas externas ni escrituras', async () => {
  const calls = [];
  const repository = createCourseRepository({ async query(...args) {
    calls.push(args);
    return { rows: courses };
  } });
  assert.deepEqual(await repository.findAll(), courses);
  assert.deepEqual(calls, [[sql]]);
});

test('servicio: conserva orden, IDs y null; excluye cualquier campo ajeno al contrato', async () => {
  let calls = 0;
  const service = createCourseService({ async findAll() {
    calls++;
    return courses.map((course) => ({ ...course, password: 'privado', units: [], sessions: [] }));
  } });
  assert.deepEqual(await service.listCourses(), courses);
  assert.equal(calls, 1);
  assert.deepEqual(await createCourseService({ async findAll() { return []; } }).listCourses(), []);
});

test('controlador: propaga fallos sin enviar éxito ni transformar errores en catálogo vacío', async () => {
  const error = new Error(privateMessage);
  const service = createCourseService({ async findAll() { throw error; } });
  await assert.rejects(service.listCourses(), (actual) => actual === error);
  let forwarded;
  await createCourseController(service).list({}, {
    status() { assert.fail('No debe responder antes del manejador de errores'); },
    json() { assert.fail('No debe enviar datos'); },
  }, (actual) => { forwarded = actual; });
  assert.equal(forwarded, error);
});

test('GET /api/courses en la aplicación real: contrato, seguridad, errores y Swagger', async (t) => {
  let rows = courses;
  let failure;
  const queries = [];
  const base = await serve(t, {
    async query(...args) {
      queries.push(args);
      if (failure) throw failure;
      return { rows };
    },
    connect() { assert.fail('No adquirir conexiones ni ejecutar transacciones'); },
  });

  await t.test('público, JSON válido, sin cookies, sin CORS abierto y con correlación', async () => {
    const response = await fetch(`${base}/api/courses`, { headers: { Origin: 'https://example.invalid' } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.ok(response.headers.get('x-correlation-id'));
    assert.deepEqual(await response.json(), { success: true, data: courses });
    assert.deepEqual(queries, [[sql]]);
  });

  await t.test('no usa filtros externos ni requiere tokens válidos', async () => {
    const response = await fetch(`${base}/api/courses?title=${encodeURIComponent("'; DROP TABLE courses; --")}`, {
      headers: { Authorization: 'Bearer invalido', Cookie: 'bitlearn_refresh=invalido' },
    });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, data: courses });
    assert.deepEqual(queries.at(-1), [sql]);
  });

  await t.test('catálogo vacío devuelve 200 sin seed ni escrituras', async () => {
    rows = [];
    const response = await fetch(`${base}/api/courses`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, data: [] });
    assert.ok(queries.every((args) => args.length === 1 && args[0] === sql));
  });

  await t.test('métodos de escritura, detalle y rutas desconocidas devuelven 404 sin consultas', async () => {
    const count = queries.length;
    for (const [method, path] of [
      ['POST', '/api/courses'], ['PUT', '/api/courses/1'],
      ['PATCH', '/api/courses/1'], ['DELETE', '/api/courses/1'],
      ['GET', '/api/courses/html'], ['GET', '/api/users'], ['GET', '/inexistente'],
    ]) {
      const response = await fetch(`${base}${path}`, {
        method, headers: { 'Content-Type': 'application/json' },
        // El catálogo no agrega un parser JSON global ni procesa este cuerpo.
        ...(['POST', 'PUT', 'PATCH'].includes(method) ? { body: '{invalid' } : {}),
      });
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { success: false, message: 'Ruta no encontrada' });
    }
    assert.equal(queries.length, count);
  });

  const unavailableCodes = ['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
    'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
    '08000', '08001', '08003', '08006', '08007', '53300', '57P01', '57P02', '57P03'];
  const unavailableMessages = ['Connection terminated unexpectedly',
    'Connection terminated due to connection timeout', 'timeout exceeded when trying to connect', 'timeout expired'];
  for (const error of [
    ...unavailableCodes.map((code) => Object.assign(new Error(privateMessage), { code })),
    ...unavailableMessages.map((message) => new Error(message)),
    ...['42P01', '42501', '28P01', 'XX000', undefined].map((code) => Object.assign(new Error(privateMessage), { code })),
  ]) {
    const status = unavailableCodes.includes(error.code) || unavailableMessages.includes(error.message) ? 503 : 500;
    await t.test(`error ${error.code || error.message}: ${status} seguro`, async (context) => {
      failure = error;
      const log = context.mock.method(console, 'error', () => {});
      if (status === 503) {
        await assert.rejects(createCourseRepository({ async query() { throw error; } }).findAll(), CatalogUnavailableError);
      }
      const response = await fetch(`${base}/api/courses`);
      assert.equal(response.status, status);
      assert.deepEqual(await response.json(), { success: false, message: status === 503
        ? 'El catálogo no está disponible temporalmente.' : 'No se pudo completar la solicitud.' });
      assert.equal(log.mock.callCount(), 1);
      assert.deepEqual(JSON.parse(log.mock.calls[0].arguments[0]), {
        level: 'error', event: 'request_failed', correlation_id: response.headers.get('x-correlation-id'),
      });
    });
  }

  await t.test('recupera 200 después de un fallo sin reiniciar', async () => {
    failure = undefined;
    rows = courses;
    const response = await fetch(`${base}/api/courses`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { success: true, data: courses });
  });

  await t.test('Swagger servido por HTTP incluye solo la consulta implementada y contratos anteriores', async () => {
    const spec = require('../src/config/swagger');
    assert.deepEqual(Object.keys(spec.paths).sort(), ['/api/auth/login', '/api/auth/logout',
      '/api/auth/me', '/api/auth/refresh', '/api/auth/register', '/api/courses', '/api/health']);
    assert.deepEqual(Object.keys(spec.paths['/api/courses']), ['get']);
    const endpoint = spec.paths['/api/courses'].get;
    assert.deepEqual(endpoint.security, []);
    assert.deepEqual(endpoint.tags, ['Courses']);
    assert.deepEqual(Object.keys(endpoint.responses), ['200', '500', '503']);
    const schema = endpoint.responses['200'].content['application/json'].schema;
    assert.deepEqual(schema.required, ['success', 'data']);
    assert.equal(schema.properties.data.items.$ref, '#/components/schemas/Course');
    assert.equal(spec.components.schemas.Course.additionalProperties, false);
    assert.deepEqual(Object.keys(spec.components.schemas.Course.properties), ['id', 'title', 'slug', 'description']);
    assert.deepEqual(spec.components.schemas.Course.required, ['id', 'title', 'slug', 'description']);
    assert.equal(spec.components.schemas.Course.properties.description.nullable, true);
    const response = await fetch(`${base}/api-docs/swagger-ui-init.js`);
    assert.equal(response.status, 200);
    const script = await response.text();
    assert.match(script, /"\/api\/courses"/);
    assert.doesNotMatch(script, /\/api\/users|\/api\/courses\/\{/);
  });
});
