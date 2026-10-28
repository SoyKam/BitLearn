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
  const handlers = { courses: reply }
  await context.route('**/api/**', async route => {
    const req = route.request()
    const path = new URL(req.url()).pathname
    calls.push({ path, method: req.method(), headers: req.headers() })
    let result
    if (path === '/api/courses') result = await handlers.courses()
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
  assert.equal(await page.locator('article img, article script, article a, article button').count(), 0)
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
