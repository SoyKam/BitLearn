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
