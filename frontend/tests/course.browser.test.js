import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'

let server
let browser
let origin
// Datos exclusivos de las pruebas: toda /api se intercepta y nunca llega a PostgreSQL.
const courses = [
  { id: 43, title: 'Curso recibido de la API', slug: 'curso-recibido', description: 'Descripción servida por la API de prueba.' },
  { id: 8, title: 'Otro curso', slug: 'otro-curso', description: null },
  { id: 25, title: 'Texto seguro', slug: 'texto-seguro', description: '<img src=x onerror="window.catalogXss=true">' },
]
const success = data => ({ success: true, data })
const deferred = () => {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

before(async () => {
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  await server.listen()
  origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
})
after(async () => { await browser?.close(); await server?.close() })

async function setup(t, reply = () => ({ body: success(courses) })) {
  const context = await browser.newContext()
  t.after(() => context.close())
  const calls = []
  const errors = []
  const handlers = {
    courses: reply,
    detail: slug => ({ body: success({ ...courses[0], slug, units: [] }) }),
  }
  await context.route('**/api/**', async route => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    calls.push({ path, method: req.method(), headers: req.headers() })
    let result
    if (path === '/api/courses') result = await handlers.courses()
    else if (path.startsWith('/api/courses/')) result = await handlers.detail(decodeURIComponent(path.slice('/api/courses/'.length)))
    else if (path === '/api/health') result = { body: { status: 'ok', database: 'connected' } }
    else if (path === '/api/auth/refresh') result = { status: 401 }
    else if (path === '/api/auth/login') result = { body: success({ user: { id: 1, name: 'Prueba', email: 'prueba@example.com' }, accessToken: 'test-access', expiresIn: 900 }) }
    else if (path === '/api/auth/me') result = { body: success({ id: 1, name: 'Prueba', email: 'prueba@example.com' }) }
    else { await route.abort(); throw new Error(`Ruta inesperada: ${path}`) }
    if (result.abort) return route.abort('failed')
    await route.fulfill({ status: result.status ?? 200, contentType: 'application/json', body: result.raw ?? JSON.stringify(result.body ?? { message: 'INTERNAL_TRACE' }) })
  })
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  page.on('pageerror', error => errors.push(error.message))
  t.after(() => assert.deepEqual(errors, []))
  return { page, context, calls, handlers }
}

async function openCatalog(page) {
  await page.goto(`${origin}/cursos`)
  await page.getByRole('heading', { name: 'Explora nuestros cursos' }).waitFor()
}
async function available(page) {
  await page.getByRole('status').filter({ hasText: 'Catálogo de cursos disponible.' }).waitFor()
}

test('ruta pública: carga anunciada, datos dinámicos, null, texto escapado y sin renovación de sesión', async t => {
  const gate = deferred()
  const { page, context, calls } = await setup(t, async () => { await gate.promise; return { body: success(courses) } })
  await context.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new Error('El catálogo no debe persistirse') }
    indexedDB.open = () => { throw new Error('El catálogo no debe persistirse') }
  })
  await openCatalog(page)
  await page.getByRole('status').filter({ hasText: 'Cargando cursos...' }).waitFor()
  assert.equal(await page.locator('article').count(), 0)
  assert.equal(await page.locator('[aria-busy="true"]').count(), 1)
  gate.resolve()
  await available(page)
  assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1)
  assert.equal(await page.getByRole('heading', { level: 2, name: 'Desarrollo Web' }).count(), 1)
  assert.deepEqual(await page.locator('article h3').allTextContents(), courses.map(course => course.title))
  assert.deepEqual(await page.locator('article p').allTextContents(), [courses[0].description, 'Descripción no disponible.', courses[2].description])
  assert.equal(await page.locator('article img, article script, article button').count(), 0)
  assert.deepEqual(await page.locator('article a').evaluateAll(links => links.map(link => link.getAttribute('href'))), courses.map(course => `/cursos/${course.slug}`))
  assert.equal(await page.evaluate(() => window.catalogXss), undefined)
  assert.deepEqual(calls.map(call => call.path), ['/api/courses'])
  assert.equal(calls[0].method, 'GET')
  assert.equal(calls[0].headers.authorization, undefined)
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0])
})

test('catálogo vacío anunciado sin cursos ficticios ni error', async t => {
  const { page, calls } = await setup(t, () => ({ body: success([]) }))
  await openCatalog(page)
  await page.getByRole('status').filter({ hasText: 'Todavía no hay cursos disponibles.' }).waitFor()
  await page.getByText('Estamos preparando nuevos contenidos para BitLearn.').waitFor()
  assert.equal(await page.locator('article').count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Reintentar', exact: true }).count(), 0)
  assert.equal(calls.length, 1)
})

for (const [label, reply, message, attempts] of [
  ['red', { abort: true }, 'No se pudo conectar con el servidor. Comprueba tu conexión e inténtalo de nuevo.', 2],
  ['500', { status: 500 }, 'El catálogo no está disponible temporalmente. Inténtalo más tarde.', 1],
  ['503', { status: 503 }, 'El catálogo no está disponible temporalmente. Inténtalo más tarde.', 2],
  ['JSON mal formado', { raw: '<html>INTERNAL_TRACE</html>' }, 'No se pudo interpretar la información del catálogo.', 1],
  ['curso inválido', { body: success([{ ...courses[0], id: '43' }]) }, 'No se pudo interpretar la información del catálogo.', 1],
]) {
  test(`interfaz: ${label}, reintento por teclado y sin solicitudes simultáneas`, async t => {
    const { page, calls, handlers } = await setup(t, () => reply)
    await openCatalog(page)
    await page.getByRole('status').filter({ hasText: message }).waitFor()
    assert.equal(calls.length, attempts)
    assert.equal(await page.locator('article').count(), 0)
    assert.ok(!(await page.locator('main').innerText()).includes('Todavía no hay cursos'))
    assert.ok(!(await page.locator('main').innerText()).includes('INTERNAL_TRACE'))
    const gate = deferred()
    handlers.courses = async () => { await gate.promise; return { body: success(courses) } }
    const retry = page.getByRole('button', { name: 'Reintentar', exact: true })
    await retry.focus()
    assert.notEqual(await retry.evaluate(el => getComputedStyle(el).outlineStyle), 'none')
    await page.keyboard.press('Enter')
    await page.getByRole('status').filter({ hasText: 'Cargando cursos...' }).waitFor()
    assert.equal(await retry.isDisabled(), true)
    // Intentos de teclado repetidos y llamadas simultáneas reutilizan el GET activo.
    await page.keyboard.press('Enter')
    await page.evaluate(async () => {
      const { useCourseStore } = await import('/src/stores/course.store.ts')
      const catalog = useCourseStore()
      window.catalogPending = Promise.all([catalog.reloadCourses(), catalog.loadCourses(), catalog.reloadCourses()])
    })
    gate.resolve()
    await page.evaluate(() => window.catalogPending)
    await available(page)
    assert.equal(calls.length, attempts + 1)
  })
}

test('bienvenida y navegación SPA conservan catálogo en memoria y salud; recarga de página consulta otra vez', async t => {
  const { page, calls } = await setup(t)
  await page.goto(origin)
  await page.getByText('API operativa · PostgreSQL conectado').waitFor()
  await page.getByText(/BitLearn utilizará repetición espaciada SM-2/).waitFor()
  await page.getByRole('link', { name: 'Explorar cursos' }).click()
  await page.waitForURL('**/cursos')
  await available(page)
  await page.getByRole('link', { name: 'Regresar al inicio' }).click()
  await page.getByRole('heading', { name: 'BitLearn', exact: true }).waitFor()
  await page.getByRole('link', { name: 'Explorar cursos' }).click()
  await available(page)
  assert.equal(calls.filter(call => call.path === '/api/courses').length, 1)
  await page.reload()
  await available(page)
  assert.equal(calls.filter(call => call.path === '/api/courses').length, 2)
})

test('usuario autenticado puede explorar desde bienvenida sin enviar JWT ni renovar para el catálogo', async t => {
  const { page, calls } = await setup(t)
  await page.goto(`${origin}/iniciar-sesion`)
  await page.getByLabel('Correo electrónico', { exact: true }).fill('prueba@example.com')
  await page.getByLabel('Contraseña', { exact: true }).fill('UnaClaveDePrueba2026!')
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click()
  await page.waitForURL('**/perfil')
  await page.getByRole('link', { name: 'Regresar al inicio' }).click()
  await page.getByRole('link', { name: 'Ir a mi perfil' }).waitFor()
  calls.length = 0
  await page.getByRole('link', { name: 'Explorar cursos' }).click()
  await available(page)
  await page.getByRole('link', { name: 'Ir a mi perfil' }).waitFor()
  assert.deepEqual(calls.map(call => call.path), ['/api/courses'])
  assert.equal(calls[0].headers.authorization, undefined)
  await page.getByRole('link', { name: `Ver curso: ${courses[0].title}`, exact: true }).click()
  await detailAvailable(page)
  assert.deepEqual(calls.map(call => call.path), ['/api/courses', `/api/courses/${courses[0].slug}`])
  assert.equal(calls[1].headers.authorization, undefined)
  await page.getByRole('link', { name: 'Volver al catálogo' }).click()
  await page.getByRole('link', { name: 'Ir a mi perfil' }).click()
  await page.getByRole('heading', { name: 'Mi perfil' }).waitFor()
})

test('cuadrícula adaptable, textos largos, teclado y anchos existentes conservados', async t => {
  const { page } = await setup(t, () => ({ body: success(courses.map(course => ({ ...course, description: 'palabralarga'.repeat(80) }))) }))
  await openCatalog(page)
  await available(page)
  for (const [width, columns] of [[320, 1], [768, 2], [1280, 3]]) {
    await page.setViewportSize({ width, height: 900 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.equal(await page.locator('.course-grid').evaluate(el => getComputedStyle(el).gridTemplateColumns.split(' ').length), columns)
    const cards = await page.locator('article').evaluateAll(elements => elements.map(el => ({ top: el.getBoundingClientRect().top, height: el.getBoundingClientRect().height })))
    if (columns === 3) {
      assert.equal(new Set(cards.map(card => card.top)).size, 1)
      assert.equal(new Set(cards.map(card => card.height)).size, 1)
    }
  }
  await page.getByRole('link', { name: 'BitLearn', exact: true }).focus()
  await page.keyboard.press('Tab')
  assert.equal(await page.getByRole('link', { name: 'Regresar al inicio' }).evaluate(el => el === document.activeElement), true)
  await page.keyboard.press('Enter')
  await page.getByRole('heading', { name: 'BitLearn', exact: true }).waitFor()
  assert.ok((await page.locator('main').boundingBox()).width <= 736)
  await page.getByRole('link', { name: 'Crear cuenta', exact: true }).click()
  await page.getByRole('heading', { name: 'Crea tu cuenta' }).waitFor()
  assert.ok((await page.locator('main').boundingBox()).width <= 480)
})

const webCourses = ['html', 'css', 'javascript'].map((slug, index) => ({
  id: index + 20, slug, title: `Curso ${slug}`, description: `Descripción ${slug} desde la API`,
}))
const detailFor = course => ({ ...course, units: [
  { id: 7, title: 'Segunda unidad', position: 4, lessons: [] },
  { id: 91, title: 'Primera unidad', position: 2, lessons: [
    { id: 3, title: 'Última lección', position: 5 },
    { id: 180, title: 'Primera lección', position: 1 },
  ] },
] })
async function detailAvailable(page) {
  await page.getByRole('status').filter({ hasText: 'Información del curso disponible.' }).waitFor()
}
async function navigate(page, slug) {
  await page.evaluate(async slug => {
    const { default: router } = await import('/src/router/index.ts')
    await router.push({ name: 'course-detail', params: { slug } })
  }, slug)
}

test('tarjetas HTML/CSS/JavaScript: teclado, detalle desde API, orden por posición y regreso SPA', async t => {
  const { page, context, calls, handlers } = await setup(t, () => ({ body: success(webCourses) }))
  handlers.detail = slug => ({ body: success(detailFor(webCourses.find(course => course.slug === slug))) })
  await context.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new Error('El detalle no debe persistirse') }
    indexedDB.open = () => { throw new Error('El detalle no debe persistirse') }
  })
  await openCatalog(page)
  await available(page)
  await page.evaluate(() => { window.spaMarker = 'conservado' })
  for (const course of webCourses) {
    const link = page.getByRole('link', { name: `Ver curso: ${course.title}`, exact: true })
    await link.focus()
    // Tras volver con un clic, activar la modalidad de teclado antes de
    // comprobar :focus-visible (focus() por sí solo conserva la del ratón).
    await page.keyboard.press('Shift+Tab')
    await page.keyboard.press('Tab')
    assert.equal(await link.evaluate(el => el === document.activeElement), true)
    assert.notEqual(await link.evaluate(el => getComputedStyle(el).outlineStyle), 'none')
    await page.keyboard.press('Enter')
    await page.waitForURL(`**/cursos/${course.slug}`)
    await detailAvailable(page)
    assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), course.title)
    await page.getByText(course.description, { exact: true }).waitFor()
    assert.deepEqual(await page.locator('article h3').allTextContents(), ['Unidad 2 — Primera unidad', 'Unidad 4 — Segunda unidad'])
    assert.deepEqual((await page.locator('.course-lessons li').allTextContents()).map(text => text.trim()), ['Lección 1: Primera lección', 'Lección 5: Última lección'])
    assert.deepEqual(await page.locator('.course-lessons li').evaluateAll(items => items.map(item => item.value)), [1, 5])
    await page.getByText('Esta unidad todavía no tiene lecciones disponibles.').waitFor()
    assert.equal(await page.locator('article button, article a').count(), 0)
    await page.getByRole('link', { name: 'Volver al catálogo' }).click()
    await available(page)
  }
  assert.equal(await page.evaluate(() => window.spaMarker), 'conservado')
  assert.deepEqual(calls.map(call => call.path), ['/api/courses', '/api/courses/html', '/api/courses/css', '/api/courses/javascript'])
  assert.ok(calls.every(call => call.method === 'GET' && !call.headers.authorization))
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, ''])
})

test('detalle público directo sin unidades: null y sin cursos ficticios', async t => {
  const { page, calls, handlers } = await setup(t)
  handlers.detail = () => ({ body: success({ ...webCourses[0], description: null, units: [] }) })
  await page.goto(`${origin}/cursos/html`)
  await detailAvailable(page)
  await page.getByText('Este curso todavía no tiene unidades disponibles.').waitFor()
  await page.getByText('Descripción no disponible.').waitFor()
  assert.equal(await page.locator('article').count(), 0)
  assert.equal(await page.getByRole('button').count(), 0)
  assert.deepEqual(calls.map(call => call.path), ['/api/courses/html'])
})

for (const [label, reply, message, attempts] of [
  ['conexión', { abort: true }, 'No se pudo conectar con el servidor.', 2],
  ['500', { status: 500 }, 'No se pudo cargar el curso. Inténtalo de nuevo.', 1],
  ['503', { status: 503 }, 'No se pudo cargar el curso. Inténtalo de nuevo.', 2],
  ['JSON', { raw: '<html>INTERNAL_TRACE</html>' }, 'No se pudo interpretar la información del curso.', 1],
  ['unidad inválida', { body: success({ ...webCourses[0], units: [null] }) }, 'No se pudo interpretar la información del curso.', 1],
]) {
  test(`detalle ${label}: mensaje, reintento accesible y carga sin datos anteriores`, async t => {
    const { page, handlers, calls } = await setup(t)
    handlers.detail = () => reply
    await page.goto(`${origin}/cursos/html`)
    await page.getByRole('status').filter({ hasText: message }).waitFor()
    assert.equal(calls.length, attempts)
    assert.equal(await page.locator('article').count(), 0)
    assert.ok(!(await page.locator('main').innerText()).includes('INTERNAL_TRACE'))
    const gate = deferred()
    handlers.detail = async () => { await gate.promise; return { body: success(detailFor(webCourses[0])) } }
    const retry = page.getByRole('button', { name: 'Reintentar', exact: true })
    await retry.focus()
    await page.keyboard.press('Enter')
    await page.getByRole('status').filter({ hasText: 'Cargando información del curso...' }).waitFor()
    assert.equal(await retry.isDisabled(), true)
    assert.equal(await page.locator('[aria-busy="true"]').count(), 1)
    await page.keyboard.press('Enter')
    await page.evaluate(async () => {
      const { useCourseStore } = await import('/src/stores/course.store.ts')
      const catalog = useCourseStore()
      window.detailPending = Promise.all([catalog.loadCourseDetail('html'), catalog.reloadCourseDetail('html')])
    })
    gate.resolve()
    await page.evaluate(() => window.detailPending)
    await detailAvailable(page)
    assert.equal(calls.length, attempts + 1)
  })
}

for (const status of [400, 404]) {
  test(`detalle HTTP ${status}: informa sin redirigir y permite volver`, async t => {
    const { page, handlers, calls } = await setup(t)
    handlers.detail = () => ({ status })
    await page.goto(`${origin}/cursos/no-existe`)
    await page.getByRole('status').filter({ hasText: status === 404 ? 'Curso no encontrado.' : 'Slug de curso inválido.' }).waitFor()
    assert.equal(new URL(page.url()).pathname, '/cursos/no-existe')
    assert.equal(await page.getByRole('heading', { level: 1 }).count(), 1)
    assert.equal(await page.getByRole('button').count(), 0)
    assert.equal(calls.length, 1)
    await page.getByRole('link', { name: 'Volver al catálogo' }).click()
    await available(page)
  })
}

for (const slug of ['HTML', 'html\n', 'a'.repeat(151), 'https://example.com', '../auth/me', 'javascript:alert(1)']) {
  test(`detalle slug inválido ${JSON.stringify(slug)}: cero consultas y recuperación al cambiar parámetro`, async t => {
    const { page, calls, handlers } = await setup(t)
    await page.goto(`${origin}/cursos/${encodeURIComponent(slug)}`)
    await page.getByRole('status').filter({ hasText: 'Slug de curso inválido.' }).waitFor()
    assert.equal(calls.length, 0)
    await page.getByRole('link', { name: 'Volver al catálogo' }).waitFor()
    handlers.detail = () => ({ body: success(detailFor(webCourses[1])) })
    await navigate(page, 'css')
    await detailAvailable(page)
    assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), webCourses[1].title)
    assert.deepEqual(calls.map(call => call.path), ['/api/courses/css'])
  })
}

test('cambio rápido de slug conserva CSS tras llegar HTML tarde; cambiar de nuevo oculta CSS', async t => {
  const { page, handlers, calls } = await setup(t)
  const html = deferred()
  const javascript = deferred()
  handlers.detail = async slug => {
    if (slug === 'html') await html.promise
    if (slug === 'javascript') await javascript.promise
    return { body: success(detailFor(webCourses.find(course => course.slug === slug))) }
  }
  await page.goto(`${origin}/cursos/html`)
  await page.getByRole('status').filter({ hasText: 'Cargando información del curso...' }).waitFor()
  await page.evaluate(async () => {
    const { useCourseStore } = await import('/src/stores/course.store.ts')
    window.htmlPending = useCourseStore().loadCourseDetail('html')
    window.spaMarker = 'conservado'
  })
  await navigate(page, 'css')
  await detailAvailable(page)
  html.resolve()
  await page.evaluate(() => window.htmlPending)
  assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), webCourses[1].title)
  await navigate(page, 'javascript')
  await page.getByRole('status').filter({ hasText: 'Cargando información del curso...' }).waitFor()
  assert.equal(await page.getByText(webCourses[1].description, { exact: true }).count(), 0)
  assert.equal(await page.locator('article').count(), 0)
  javascript.resolve()
  await detailAvailable(page)
  assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), webCourses[2].title)
  assert.equal(await page.evaluate(() => window.spaMarker), 'conservado')
  assert.deepEqual(calls.map(call => call.path), ['/api/courses/html', '/api/courses/css', '/api/courses/javascript'])
})

test('detalle: texto seguro en todos los niveles y diseño móvil sin desbordes', async t => {
  const { page, handlers } = await setup(t)
  const unsafe = '<img src=x onerror="window.detailXss=true">'
  const long = 'palabralarga'.repeat(70)
  handlers.detail = () => ({ body: success({ ...webCourses[0], title: unsafe, description: long,
    units: [{ id: 1, title: unsafe, position: 1, lessons: [{ id: 1, title: unsafe + long, position: 1 }] }],
  }) })
  await page.goto(`${origin}/cursos/html`)
  await detailAvailable(page)
  assert.equal(await page.getByRole('heading', { level: 1 }).textContent(), unsafe)
  assert.equal(await page.locator('main img, main script').count(), 0)
  assert.equal(await page.evaluate(() => window.detailXss), undefined)
  for (const width of [320, 768, 1280]) {
    await page.setViewportSize({ width, height: 900 })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  }
  await page.getByRole('link', { name: 'BitLearn', exact: true }).focus()
  await page.keyboard.press('Tab')
  const back = page.getByRole('link', { name: 'Volver al catálogo' })
  assert.equal(await back.evaluate(el => el === document.activeElement), true)
  assert.notEqual(await back.evaluate(el => getComputedStyle(el).outlineStyle), 'none')
})
