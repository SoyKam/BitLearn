import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import ts from 'typescript'

// Mismo compilador que las pruebas existentes; resolver solo las dependencias
// de estos módulos para ejecutarlos sin navegador ni otro framework de tests.
async function moduleUrl(path, imports = {}) {
  const source = await readFile(new URL(path, import.meta.url), 'utf8')
  let { outputText } = ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
  })
  for (const [specifier, url] of Object.entries(imports)) outputText = outputText.replaceAll(`from '${specifier}'`, `from '${url}'`)
  return `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
}
const httpUrl = await moduleUrl('../src/services/http.service.ts')
const serviceUrl = await moduleUrl('../src/services/course.service.ts', { './http.service': httpUrl })
const storeUrl = await moduleUrl('../src/stores/course.store.ts', {
  vue: import.meta.resolve('vue'), pinia: import.meta.resolve('pinia'), '../services/course.service': serviceUrl,
})
const { courseService } = await import(serviceUrl)
const { useCourseStore } = await import(storeUrl)
const sample = { id: 17, title: 'Curso desde la API de prueba', slug: 'curso-api', description: 'Contenido de prueba' }
const success = data => ({ success: true, data })
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}
function store() { setActivePinia(createPinia()); return useCourseStore() }

test('GET público: URL, opciones seguras, datos recibidos y proyección sin propiedades extra', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/courses')
    assert.equal(options.method, 'GET')
    assert.equal(options.credentials, 'same-origin')
    assert.equal(options.cache, 'no-store')
    assert.equal(options.redirect, 'error')
    assert.ok(options.signal instanceof AbortSignal)
    assert.deepEqual(options.headers, { Accept: 'application/json' })
    assert.equal(options.body, undefined)
    return Response.json({ ...success([{ ...sample, units: [], private: 'secret' }]), internal: 'secret' })
  })
  assert.deepEqual(await courseService.listCourses(), success([sample]))
  assert.equal(fetch.mock.callCount(), 1)
})

for (const description of [null, '', 'Texto <script>sin ejecutar</script>']) {
  test(`servicio admite descripción ${JSON.stringify(description)}`, async t => {
    const course = { ...sample, description }
    t.mock.method(globalThis, 'fetch', async () => Response.json(success([course])))
    assert.deepEqual(await courseService.listCourses(), success([course]))
  })
}

test('slug de 150 caracteres y entero seguro máximo son válidos', async t => {
  const course = { ...sample, id: Number.MAX_SAFE_INTEGER, slug: 'a'.repeat(150) }
  t.mock.method(globalThis, 'fetch', async () => Response.json(success([course])))
  assert.deepEqual(await courseService.listCourses(), success([course]))
})

const invalidEnvelopes = [null, [], false, 'text', {}, { success: false, data: [] }, { success: 'true', data: [] }, { success: true }, { success: true, data: null }, { success: true, data: {} }]
const invalidCourses = [null, [], 'course', {},
  ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null].map(id => ({ ...sample, id })),
  ...['', ' \n ', 23, null].map(title => ({ ...sample, title })),
  ...['', 'HTML', '-html', 'html-', 'html--css', 'html_css', '../html', 'html/css', 'html css', 'html\n', 'a'.repeat(151), null, 1].map(slug => ({ ...sample, slug })),
  ...[undefined, {}, 1, false, []].map(description => ({ ...sample, description })),
]
for (const [index, body] of [...invalidEnvelopes, ...invalidCourses.map(course => success([course])),
  success([sample, { ...sample, slug: 'otro' }]), success([sample, { ...sample, id: 18 }]),
  success([sample, { ...sample, id: 18, slug: 'otro', description: false }]),
].entries()) {
  test(`rechaza respuesta inválida ${index + 1} completa, sin convertirla en vacío ni reintentar`, async t => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(body))
    await assert.rejects(courseService.listCourses(), { kind: 'response' })
    assert.equal(fetch.mock.callCount(), 1)
  })
}

test('JSON mal formado es error de respuesta, no de conexión', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => new Response('<html>INTERNAL_TRACE</html>'))
  await assert.rejects(courseService.listCourses(), { kind: 'response' })
  assert.equal(fetch.mock.callCount(), 1)
})

for (const [label, reply, kind, status, attempts] of [
  ['red', () => { throw new TypeError('INTERNAL_TRACE') }, 'connection', null, 2],
  ['500', () => Response.json({ message: 'INTERNAL_TRACE' }, { status: 500 }), 'server', 500, 1],
  ['503', () => Response.json({ message: 'INTERNAL_TRACE' }, { status: 503 }), 'server', 503, 2],
  ['respuesta', () => Response.json({ data: [] }), 'response', null, 1],
]) {
  test(`store: ${label} controlado, reintento limitado y recuperación manual`, async t => {
    const fetch = t.mock.method(globalThis, 'fetch', reply)
    const catalog = store()
    await catalog.loadCourses()
    assert.equal(catalog.status, 'error')
    assert.equal(catalog.error.kind, kind)
    assert.equal(catalog.error.status, status)
    assert.ok(!catalog.error.message.includes('INTERNAL_TRACE'))
    assert.equal(catalog.initialized, true)
    assert.equal(catalog.loading, false)
    assert.equal(catalog.isEmpty, false)
    assert.deepEqual(catalog.courses, [])
    assert.equal(fetch.mock.callCount(), attempts)
    fetch.mock.mockImplementation(async () => Response.json(success([sample])))
    await catalog.reloadCourses()
    assert.equal(catalog.status, 'success')
    assert.equal(catalog.error, null)
    assert.deepEqual(catalog.courses, [sample])
    assert.equal(fetch.mock.callCount(), attempts + 1)
  })
}

for (const status of [503, 'network']) {
  test(`GET se recupera con un único reintento automático tras ${status}`, async t => {
    let calls = 0
    t.mock.method(globalThis, 'fetch', async () => {
      if (++calls === 1) {
        if (status === 'network') throw new TypeError('offline')
        return Response.json({}, { status })
      }
      return Response.json(success([sample]))
    })
    assert.deepEqual(await courseService.listCourses(), success([sample]))
    assert.equal(calls, 2)
  })
}

test('store: idle, carga única, colección normalizada, orden de API y caché en memoria', async t => {
  const gate = deferred()
  const second = { ...sample, id: 2, slug: 'segundo', description: null }
  const fetch = t.mock.method(globalThis, 'fetch', () => gate.promise)
  const catalog = store()
  assert.equal(catalog.status, 'idle')
  assert.equal(catalog.initialized, false)
  assert.equal(catalog.loading, false)
  assert.equal(catalog.error, null)
  assert.equal(catalog.isEmpty, false)
  assert.deepEqual(catalog.courses, [])
  const loads = [catalog.loadCourses(), catalog.loadCourses(), catalog.reloadCourses(), catalog.reloadCourses()]
  assert.equal(catalog.loading, true)
  assert.equal(catalog.initialized, false)
  assert.equal(fetch.mock.callCount(), 1)
  gate.resolve(Response.json(success([sample, second])))
  await Promise.all(loads)
  assert.equal(catalog.status, 'success')
  assert.equal(catalog.initialized, true)
  assert.equal(catalog.loading, false)
  assert.equal(catalog.isEmpty, false)
  assert.deepEqual(catalog.catalog, { byId: { 17: sample, 2: second }, allIds: [17, 2] })
  assert.deepEqual(catalog.courses, [sample, second])
  await catalog.loadCourses()
  assert.equal(fetch.mock.callCount(), 1)
})

test('catálogo vacío es éxito cacheado; recargar sustituye la colección', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(success([])))
  const catalog = store()
  await catalog.loadCourses()
  assert.equal(catalog.isEmpty, true)
  assert.equal(catalog.status, 'success')
  assert.equal(catalog.error, null)
  await catalog.loadCourses()
  assert.equal(fetch.mock.callCount(), 1)
  fetch.mock.mockImplementation(async () => Response.json(success([sample])))
  await catalog.reloadCourses()
  assert.equal(catalog.isEmpty, false)
  assert.deepEqual(catalog.courses, [sample])
  fetch.mock.mockImplementation(async () => Response.json(success([])))
  await catalog.reloadCourses()
  assert.deepEqual(catalog.catalog, { byId: {}, allIds: [] })
})

test('carga lenta y recargas se serializan: una respuesta antigua no puede sobrescribir la nueva', async t => {
  const older = deferred()
  const newer = deferred()
  const fetch = t.mock.method(globalThis, 'fetch', () => older.promise)
  const catalog = store()
  const first = catalog.loadCourses()
  const duringFirst = catalog.reloadCourses()
  assert.equal(fetch.mock.callCount(), 1, 'la recarga en vuelo se agrupa, no abre otra consulta')
  older.resolve(Response.json(success([sample])))
  await Promise.all([first, duringFirst])
  fetch.mock.mockImplementation(() => newer.promise)
  const refresh = catalog.reloadCourses()
  const duplicate = catalog.reloadCourses()
  assert.equal(fetch.mock.callCount(), 2)
  assert.equal(catalog.loading, true)
  const fresh = { ...sample, title: 'Título actualizado' }
  newer.resolve(Response.json(success([fresh])))
  await Promise.all([refresh, duplicate])
  await first
  assert.deepEqual(catalog.courses, [fresh])
})

test('fallo al recargar conserva último dato pero marca error, nunca vacío ni éxito cacheado', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(success([sample])))
  const catalog = store()
  await catalog.loadCourses()
  fetch.mock.mockImplementation(async () => Response.json({}, { status: 500 }))
  await catalog.reloadCourses()
  assert.equal(catalog.status, 'error')
  assert.equal(catalog.isEmpty, false)
  assert.deepEqual(catalog.courses, [sample])
  fetch.mock.mockImplementation(async () => Response.json(success([])))
  await catalog.loadCourses()
  assert.equal(catalog.isEmpty, true)
})

const lesson = { id: 91, title: 'Lección de prueba', position: 3 }
const unit = { id: 30, title: 'Unidad de prueba', position: 2, lessons: [lesson] }
const detail = { ...sample, units: [unit] }

for (const slug of ['html', 'css', 'javascript', 'curso-con-guiones', 'a'.repeat(150)]) {
  test(`detalle público GET ${slug}: contrato y sin tokens ni campos adicionales`, async t => {
    const expected = { ...detail, slug }
    const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, `/api/courses/${encodeURIComponent(slug)}`)
      assert.equal(options.method, 'GET')
      assert.deepEqual(options.headers, { Accept: 'application/json' })
      assert.equal(options.body, undefined)
      assert.equal(options.redirect, 'error')
      return Response.json(success({ ...expected, private: true, units: [{ ...unit, private: true, lessons: [{ ...lesson, content: 'No copiar' }] }] }))
    })
    assert.deepEqual(await courseService.getCourseBySlug(slug), success(expected))
    assert.equal(fetch.mock.callCount(), 1)
  })
}

for (const slug of ['', 'HTML', ' html', 'html ', 'html\n', 'html\r', 'html--css', '-html', 'html-',
  'a'.repeat(151), '../auth/me', 'html/css', 'html?query=1', 'html#hash', '%68tml', 'https://example.com',
  '//example.com', 'javascript:alert(1)', 'html\\css', null, ['html'], 1]) {
  test(`slug inválido ${JSON.stringify(slug)}: rechazo antes de fetch`, async t => {
    const fetch = t.mock.method(globalThis, 'fetch', () => { throw new Error('No debe consultar') })
    await assert.rejects(courseService.getCourseBySlug(slug), { kind: 'validation' })
    assert.equal(fetch.mock.callCount(), 0)
  })
}

const badItems = [null, [], {},
  ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null].map(id => ({ ...lesson, id })),
  ...['', ' \n ', 12, null].map(title => ({ ...lesson, title })),
  ...[0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '1', null].map(position => ({ ...lesson, position })),
]
const invalidDetails = [
  ...invalidEnvelopes, success([]), success(null),
  ...invalidCourses.map(course => success(isObject(course) ? { ...course, units: [] } : course)),
  success({ ...detail, slug: 'otro-curso' }),
  ...[null, {}, undefined].map(units => success({ ...detail, units })),
  ...badItems.map(item => success({ ...detail, units: [isObject(item) ? { ...item, lessons: [] } : item] })),
  ...badItems.map(item => success({ ...detail, units: [{ ...unit, lessons: [item] }] })),
  ...[null, {}, undefined].map(lessons => success({ ...detail, units: [{ ...unit, lessons }] })),
  success({ ...detail, units: [unit, { ...unit, position: 4 }] }),
  success({ ...detail, units: [unit, { ...unit, id: 31 }] }),
  success({ ...detail, units: [{ ...unit, lessons: [lesson, { ...lesson, position: 4 }] }] }),
  success({ ...detail, units: [{ ...unit, lessons: [lesson, { ...lesson, id: 92 }] }] }),
]
function isObject(value) { return value !== null && typeof value === 'object' && !Array.isArray(value) }
for (const [index, body] of invalidDetails.entries()) {
  test(`detalle inválido ${index + 1}: rechazo completo sin reintento`, async t => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(body))
    await assert.rejects(courseService.getCourseBySlug(sample.slug), { kind: 'response' })
    assert.equal(fetch.mock.callCount(), 1)
  })
}

test('detalle ordena por posición, acepta huecos, descripciones null y colecciones vacías', async t => {
  const first = { ...unit, id: 200, position: 1, lessons: [] }
  const firstLesson = { ...lesson, id: 900, position: 1 }
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(success({ ...detail, description: null,
    units: [{ ...unit, lessons: [lesson, firstLesson] }, first] })))
  assert.deepEqual((await courseService.getCourseBySlug(sample.slug)).data, {
    ...detail, description: null, units: [first, { ...unit, lessons: [firstLesson, lesson] }],
  })
  fetch.mock.mockImplementation(async () => Response.json(success({ ...detail, units: [] })))
  assert.deepEqual((await courseService.getCourseBySlug(sample.slug)).data.units, [])
})

test('IDs de lección son únicos entre unidades; posiciones iguales con padres distintos son válidas', async t => {
  const second = { ...unit, id: 31, position: 4, lessons: [{ ...lesson }] }
  const fetch = t.mock.method(globalThis, 'fetch', async () =>
    Response.json(success({ ...detail, units: [unit, second] })))
  const catalog = store()
  await catalog.loadCourseDetail(sample.slug)
  assert.equal(catalog.detailStatus, 'error')
  assert.equal(catalog.detailError.kind, 'response')
  assert.equal(catalog.detail, null, 'No publicar un detalle con identidades ambiguas')
  assert.equal(fetch.mock.callCount(), 1)

  const valid = { ...detail, units: [unit, { ...second, lessons: [{ ...lesson, id: 92 }] }] }
  fetch.mock.mockImplementation(async () => Response.json(success(valid)))
  await catalog.reloadCourseDetail(sample.slug)
  assert.equal(catalog.detailStatus, 'success')
  assert.deepEqual(catalog.detail, valid)
  assert.equal(catalog.detailError, null)
  assert.equal(fetch.mock.callCount(), 2)
})

for (const [label, reply, kind, status, attempts] of [
  ['red', () => { throw new TypeError('INTERNAL_TRACE') }, 'connection', null, 2],
  ...[400, 404, 500, 503].map(status => [String(status), () => Response.json({}, { status }), status === 400 ? 'validation' : status === 404 ? 'not-found' : 'server', status, status === 503 ? 2 : 1]),
  ['JSON', () => new Response('<html>INTERNAL_TRACE</html>'), 'response', null, 1],
  ['contrato', () => Response.json(success({ ...detail, units: [null] })), 'response', null, 1],
]) {
  test(`detalle store: ${label}, error controlado y recuperación manual`, async t => {
    const fetch = t.mock.method(globalThis, 'fetch', reply)
    const catalog = store()
    await catalog.loadCourseDetail(sample.slug)
    assert.equal(catalog.detail, null)
    assert.equal(catalog.detailStatus, 'error')
    assert.equal(catalog.detailLoading, false)
    assert.equal(catalog.detailError.kind, kind)
    assert.equal(catalog.detailError.status, status)
    assert.ok(!catalog.detailError.message.includes('INTERNAL_TRACE'))
    assert.equal(fetch.mock.callCount(), attempts)
    fetch.mock.mockImplementation(async () => Response.json(success(detail)))
    await catalog.reloadCourseDetail(sample.slug)
    assert.equal(catalog.detailStatus, 'success')
    assert.equal(catalog.detailError, null)
    assert.deepEqual(catalog.detail, detail)
    assert.equal(fetch.mock.callCount(), attempts + 1)
  })
}

test('detalle: estado inicial, deduplicación, caché y separación del catálogo', async t => {
  const gate = deferred()
  const fetch = t.mock.method(globalThis, 'fetch', url => url === '/api/courses' ? Response.json(success([sample])) : gate.promise)
  const catalog = store()
  assert.equal(catalog.detail, null)
  assert.equal(catalog.detailSlug, null)
  assert.equal(catalog.detailStatus, 'idle')
  assert.equal(catalog.detailError, null)
  assert.equal(catalog.detailLoading, false)
  await catalog.loadCourses()
  const loads = [catalog.loadCourseDetail(sample.slug), catalog.loadCourseDetail(sample.slug), catalog.reloadCourseDetail(sample.slug)]
  assert.equal(catalog.detailLoading, true)
  assert.equal(fetch.mock.callCount(), 2)
  gate.resolve(Response.json(success(detail)))
  await Promise.all(loads)
  await catalog.loadCourseDetail(sample.slug)
  assert.equal(fetch.mock.callCount(), 2)
  assert.deepEqual(catalog.detail, detail)
  catalog.clearCourseDetail()
  assert.equal(catalog.detail, null)
  assert.equal(catalog.detailStatus, 'idle')
  assert.deepEqual(catalog.courses, [sample])
  assert.equal(catalog.status, 'success')
})

for (const lateStatus of [200, 404, 500]) {
  test(`cambio HTML → CSS: respuesta antigua ${lateStatus} no sobrescribe CSS ni su carga`, async t => {
    const html = deferred()
    const css = deferred()
    t.mock.method(globalThis, 'fetch', url => url.endsWith('/html') ? html.promise : css.promise)
    const catalog = store()
    const first = catalog.loadCourseDetail('html')
    const second = catalog.loadCourseDetail('css')
    assert.equal(catalog.detailSlug, 'css')
    assert.equal(catalog.detail, null)
    css.resolve(Response.json(success({ ...detail, slug: 'css' })))
    await second
    html.resolve(Response.json(success({ ...detail, slug: 'html' }), { status: lateStatus }))
    await first
    assert.equal(catalog.detail.slug, 'css')
    assert.equal(catalog.detailStatus, 'success')
    assert.equal(catalog.detailError, null)
  })
}

test('A → B → A agrupa GET pendiente; limpiar invalida respuestas sin resucitar el detalle', async t => {
  const html = deferred()
  const css = deferred()
  const fetch = t.mock.method(globalThis, 'fetch', url => url.endsWith('/html') ? html.promise : css.promise)
  const catalog = store()
  const loads = [catalog.loadCourseDetail('html'), catalog.loadCourseDetail('css'), catalog.loadCourseDetail('html')]
  assert.equal(fetch.mock.callCount(), 2)
  html.resolve(Response.json(success({ ...detail, slug: 'html' })))
  await loads[2]
  assert.equal(catalog.detail.slug, 'html')
  catalog.clearCourseDetail()
  css.resolve(Response.json(success({ ...detail, slug: 'css' })))
  await Promise.all(loads)
  assert.equal(catalog.detailStatus, 'idle')
  assert.equal(catalog.detail, null)
  assert.equal(catalog.detailError, null)
})

test('nuevo slug limpia error y datos anteriores mientras carga', async t => {
  const gate = deferred()
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status: 404 }))
  const catalog = store()
  await catalog.loadCourseDetail('no-existe')
  fetch.mock.mockImplementation(() => gate.promise)
  const loading = catalog.loadCourseDetail(sample.slug)
  assert.equal(catalog.detailError, null)
  assert.equal(catalog.detail, null)
  assert.equal(catalog.detailLoading, true)
  gate.resolve(Response.json(success(detail)))
  await loading
  const next = catalog.loadCourseDetail('css')
  assert.equal(catalog.detail, null)
  assert.equal(catalog.detailLoading, true)
  await next
  assert.equal(catalog.detailError.kind, 'response', 'rechaza un curso distinto del slug solicitado')
})
