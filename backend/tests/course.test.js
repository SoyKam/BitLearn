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

  await t.test('métodos de escritura y rutas desconocidas devuelven 404 sin consultas', async () => {
    const count = queries.length;
    for (const [method, path] of [
      ['POST', '/api/courses'], ['PUT', '/api/courses/1'],
      ['PATCH', '/api/courses/1'], ['DELETE', '/api/courses/1'],
      ['GET', '/api/users'], ['GET', '/inexistente'],
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

  await t.test('Swagger servido por HTTP incluye ambas consultas implementadas y contratos anteriores', async () => {
    const spec = require('../src/config/swagger');
    assert.deepEqual(Object.keys(spec.paths).sort(), ['/api/auth/login', '/api/auth/logout',
      '/api/auth/me', '/api/auth/refresh', '/api/auth/register', '/api/courses', '/api/courses/{slug}', '/api/health']);
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
    assert.match(script, /\/api\/courses\/\{slug\}/);
    assert.doesNotMatch(script, /\/api\/users/);
  });
});

const detailSql = 'SELECT id, title, slug, description FROM public.courses WHERE slug = $1';
const structure = [
  { unit_id: 90, unit_title: 'Primera', unit_position: 1, lesson_id: 99, lesson_title: 'Inicio', lesson_position: 2 },
  { unit_id: 90, unit_title: 'Primera', unit_position: 1, lesson_id: 12, lesson_title: 'Final', lesson_position: 7 },
  { unit_id: 10, unit_title: 'Vacía', unit_position: 3, lesson_id: null, lesson_title: null, lesson_position: null },
];
const detail = { ...courses[1], units: [
  { id: 90, title: 'Primera', position: 1, lessons: [
    { id: 99, title: 'Inicio', position: 2 }, { id: 12, title: 'Final', position: 7 },
  ] },
  { id: 10, title: 'Vacía', position: 3, lessons: [] },
] };

test('repositorio de detalle: parámetros separados del SQL, solo lectura y JOIN ordenado', async () => {
  const calls = [];
  const repository = createCourseRepository({ async query(...args) {
    calls.push(args);
    return { rows: args[0] === detailSql ? [courses[1]] : structure };
  } });
  const injection = "html'; DROP TABLE courses; --";
  assert.deepEqual(await repository.findBySlug(injection), courses[1]);
  assert.deepEqual(calls[0], [detailSql, [injection]]);
  assert.deepEqual(await repository.findStructureByCourseId(42), structure);
  assert.deepEqual(calls[1][1], [42]);
  const query = calls[1][0].replace(/\s+/g, ' ').trim();
  assert.equal(query, 'SELECT u.id AS unit_id, u.title AS unit_title, u.position AS unit_position, '
    + 'l.id AS lesson_id, l.title AS lesson_title, l.position AS lesson_position '
    + 'FROM public.units u LEFT JOIN public.lessons l ON l.unit_id = u.id '
    + 'WHERE u.course_id = $1 ORDER BY u.position ASC, l.position ASC');
  assert.equal(calls.length, 2);
  assert.equal(await createCourseRepository({ async query() { return { rows: [] }; } }).findBySlug('ausente'), null);
});

test('servicio de detalle: contrato exacto, sin campos privados y sin N+1', async () => {
  let structureCalls = 0;
  let rows = structure;
  let course = { ...courses[1], password: 'privado', users: [], sessions: [] };
  const service = createCourseService({
    async findBySlug(slug) { assert.equal(slug, 'html'); return course; },
    async findStructureByCourseId(id) {
      assert.equal(id, 42);
      structureCalls++;
      return rows.map((row) => ({ ...row, content: 'privado', password: 'privado', sessions: [] }));
    },
  });
  assert.deepEqual(await service.getCourseBySlug('html'), detail);
  assert.equal(structureCalls, 1);
  rows = [];
  assert.deepEqual(await service.getCourseBySlug('html'), { ...courses[1], units: [] });
  rows = Array.from({ length: 100 }, (_, i) => ({
    unit_id: i + 1, unit_title: `Unidad ${i}`, unit_position: i + 1,
    lesson_id: null, lesson_title: null, lesson_position: null,
  }));
  assert.equal((await service.getCourseBySlug('html')).units.length, 100);
  assert.equal(structureCalls, 3);
  course = null;
  assert.equal(await service.getCourseBySlug('html'), null);
  assert.equal(structureCalls, 3, 'No consultar estructura de cursos inexistentes');
});

test('controlador de detalle: rechaza tipos incorrectos y vacío antes del servicio; propaga errores', async () => {
  const failure = new Error(privateMessage);
  let calls = 0;
  const controller = createCourseController({ async getCourseBySlug() { calls++; throw failure; } });
  for (const slug of [undefined, null, 1, {}, [], '', true]) {
    await controller.detail({ params: { slug } }, {
      status(status) { assert.equal(status, 400); return this; },
      json(body) { assert.deepEqual(body, { success: false, message: 'Slug de curso inválido.' }); },
    }, () => assert.fail('Entrada inválida no debe propagar errores'));
  }
  assert.equal(calls, 0);
  let forwarded;
  await controller.detail({ params: { slug: 'html' } }, {
    status() { assert.fail('No debe enviar éxito'); },
  }, (error) => { forwarded = error; });
  assert.equal(forwarded, failure);
});

test('GET /api/courses/:slug: validación, contrato público y errores seguros', async (t) => {
  const queries = [];
  let failure;
  let failOnStructure = false;
  const base = await serve(t, { async query(...args) {
    queries.push(args);
    if (failure && (!failOnStructure || args[0] !== detailSql)) throw failure;
    if (args[0] === detailSql) return { rows: args[1][0] === 'html' ? [courses[1]] : [] };
    return { rows: structure };
  } });

  await t.test('público, dos consultas, sin cookies ni CORS abierto, incluso con tokens inválidos', async () => {
    const response = await fetch(`${base}/api/courses/html`, { headers: {
      Authorization: 'Bearer invalido', Cookie: 'bitlearn_refresh=invalido', Origin: 'https://example.invalid',
    } });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.headers.get('access-control-allow-origin'), null);
    assert.ok(response.headers.get('x-correlation-id'));
    assert.deepEqual(await response.json(), { success: true, data: detail });
    assert.equal(queries.length, 2);
  });

  await t.test('slug válido inexistente: 404 y una sola consulta, incluidos límites válidos', async () => {
    for (const slug of ['ausente', 'a', 'web-2', 'a'.repeat(150)]) {
      const count = queries.length;
      const response = await fetch(`${base}/api/courses/${slug}`);
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { success: false, message: 'Curso no encontrado.' });
      assert.deepEqual(queries.slice(count), [[detailSql, [slug]]]);
    }
  });

  await t.test('slugs inválidos e inyecciones: 400 sin consultar ni revelar detalles', async () => {
    const count = queries.length;
    for (const slug of ['HTML', '-html', 'html-', 'ht--ml', 'ht ml', ' html', 'html ',
      'html\n', 'html\r', 'html\r\n', 'html\t', 'html\u2028', 'html\0', 'html/css', 'ht\\ml',
      'html?', 'html#', 'ht_ml', 'á', 'a'.repeat(151), "html' OR '1'='1", "'; DROP TABLE courses; --",
      '<script>alert(1)</script>']) {
      const response = await fetch(`${base}/api/courses/${encodeURIComponent(slug)}`);
      assert.equal(response.status, 400, JSON.stringify(slug));
      assert.deepEqual(await response.json(), { success: false, message: 'Slug de curso inválido.' });
    }
    for (const path of ['%', '%C3%28']) {
      const response = await fetch(`${base}/api/courses/${path}`);
      assert.equal(response.status, 400);
      assert.deepEqual(await response.json(), { success: false, message: 'Slug de curso inválido.' });
    }
    assert.equal(queries.length, count);
  });

  await t.test('POST, PUT, PATCH y DELETE bloqueados en listado y detalle', async () => {
    const count = queries.length;
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
      for (const path of ['/api/courses', '/api/courses/html']) {
        const response = await fetch(`${base}${path}`, { method });
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { success: false, message: 'Ruta no encontrada' });
      }
    }
    assert.equal(queries.length, count);
  });

  await t.test('distingue rutas no reconocidas, parámetros codificados y decodificación única', async () => {
    const count = queries.length;
    // El slash literal crea otro segmento; el codificado llega al validador del slug.
    // No usar ../ literal con fetch: su parser URL normaliza los segmentos antes de enviar.
    for (const [path, status] of [
      ['html/lecciones', 404], ['..%2Fhtml', 400], ['html%2Fcss', 400],
      ['%2568tml', 400], ['%ZZ', 400], ['%E0%A4%A', 400],
    ]) {
      const response = await fetch(`${base}/api/courses/${path}`);
      assert.equal(response.status, status, path);
      assert.deepEqual(await response.json(), { success: false, message: status === 404
        ? 'Ruta no encontrada' : 'Slug de curso inválido.' });
    }
    assert.equal(queries.length, count);
    const encoded = await fetch(`${base}/api/courses/%68tml`);
    assert.equal(encoded.status, 200);
    assert.deepEqual(await encoded.json(), { success: true, data: detail });
    assert.equal(queries.length - count, 2);
    assert.deepEqual(queries[count], [detailSql, ['html']]);
  });

  for (const onStructure of [false, true]) {
    for (const code of ['ECONNREFUSED', '57P03', '42P01', '42501', undefined]) {
      await t.test(`error ${code} en ${onStructure ? 'estructura' : 'curso'} no expone detalles`, async (context) => {
        failOnStructure = onStructure;
        failure = Object.assign(new Error(privateMessage), { code });
        const log = context.mock.method(console, 'error', () => {});
        const response = await fetch(`${base}/api/courses/html`);
        const status = ['ECONNREFUSED', '57P03'].includes(code) ? 503 : 500;
        assert.equal(response.status, status);
        assert.deepEqual(await response.json(), { success: false, message: status === 503
          ? 'El catálogo no está disponible temporalmente.' : 'No se pudo completar la solicitud.' });
        assert.equal(log.mock.callCount(), 1);
        assert.deepEqual(JSON.parse(log.mock.calls[0].arguments[0]), {
          level: 'error', event: 'request_failed', correlation_id: response.headers.get('x-correlation-id'),
        });
      });
    }
  }
  failure = undefined;
  assert.deepEqual(await (await fetch(`${base}/api/courses/html`)).json(), { success: true, data: detail });
});

test('Swagger: detalle público, parámetro requerido, contratos cerrados y todos los estados HTTP', () => {
  const spec = require('../src/config/swagger');
  assert.deepEqual(Object.keys(spec.paths['/api/courses/{slug}']), ['get']);
  const endpoint = spec.paths['/api/courses/{slug}'].get;
  assert.deepEqual(endpoint.security, []);
  assert.deepEqual(endpoint.tags, ['Courses']);
  assert.deepEqual(Object.keys(endpoint.responses), ['200', '400', '404', '500', '503']);
  assert.equal(endpoint.parameters.length, 1);
  assert.deepEqual(endpoint.parameters[0], {
    in: 'path', name: 'slug', required: true,
    description: 'Slug canónico del curso, sin normalización automática.',
    schema: { type: 'string', minLength: 1, maxLength: 150, pattern: '^[a-z0-9]+(-[a-z0-9]+)*$' },
    example: 'html',
  });
  assert.equal(endpoint.responses['200'].content['application/json'].schema.properties.data.$ref,
    '#/components/schemas/CourseDetail');
  for (const [name, keys] of [
    ['CourseDetail', ['id', 'title', 'slug', 'description', 'units']],
    ['CourseUnit', ['id', 'title', 'position', 'lessons']],
    ['CourseLesson', ['id', 'title', 'position']],
  ]) {
    assert.equal(spec.components.schemas[name].additionalProperties, false);
    assert.deepEqual(Object.keys(spec.components.schemas[name].properties), keys);
    assert.deepEqual(spec.components.schemas[name].required, keys);
  }
  assert.equal(spec.components.schemas.CourseDetail.properties.units.items.$ref, '#/components/schemas/CourseUnit');
  assert.equal(spec.components.schemas.CourseUnit.properties.lessons.items.$ref, '#/components/schemas/CourseLesson');
});
