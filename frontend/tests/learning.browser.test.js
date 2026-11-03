import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'

let server, browser, origin
const success = data => ({ success: true, data })
const user = { id: 1, name: 'Estudiante', email: 'estudiante@example.com' }
const question = { id: 31, prompt: '¿Qué etiqueta usar?', options: ['<head>', '<body>'] }
const lesson = { id: 7, title: 'Estructura HTML', content: '<img src="https://example.com/private" onerror="window.xss=true">\n<script>window.xss=true</script>', course: { id: 2, title: 'HTML', slug: 'html' }, unit: { id: 3, title: 'Fundamentos' }, questions: [question] }
const progress = { completedLessons: 1, totalLessons: 9, lessons: [{ lessonId: 7, courseSlug: 'html', attempts: 2, correctAnswers: 1, completedAt: '2026-11-03T21:00:00.000Z' }] }
const answer = { correct: true, completed: true, explanation: 'Explicación del servidor', progress: { attempts: 2, correctAnswers: 1, completedAt: '2026-11-03T21:00:00.000Z' } }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { resolve, promise } }
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
})
after(async () => { await browser?.close(); await server?.close() })
async function setup(t, overrides = {}) {
  const context = await browser.newContext(); t.after(() => context.close())
  const calls = [], errors = []
  let session = false
  const handlers = {
    lesson: () => ({ body: success(lesson) }), answer: () => ({ body: success(answer) }),
    progress: () => ({ body: success(progress) }),
    ...overrides,
  }
  await context.route('**/api/**', async route => {
    const req = route.request(), path = new URL(req.url()).pathname
    calls.push({ path, method: req.method(), body: req.postDataJSON(), headers: req.headers() })
    let reply
    if (/\/lessons\/\d+\/answer$/.test(path)) reply = await handlers.answer()
    else if (/\/lessons\/\d+$/.test(path)) reply = await handlers.lesson(path)
    else if (path === '/api/progress') reply = await handlers.progress()
    else if (path === '/api/auth/refresh') reply = session ? { body: success({ accessToken: 'renewed', expiresIn: 900 }) } : { status: 401 }
    else if (path === '/api/auth/login') { session = true; reply = { body: success({ user, accessToken: 'token', expiresIn: 900 }) } }
    else if (path === '/api/auth/me') reply = { body: success(user) }
    else if (path === '/api/auth/logout') { session = false; reply = { body: { success: true, message: 'Sesión cerrada' } } }
    else if (path === '/api/health') reply = { body: { status: 'ok', database: 'connected' } }
    else if (path === '/api/courses/html') reply = { body: success({ ...lesson.course, description: null, units: [{ ...lesson.unit, position: 1, lessons: [{ id: 7, title: lesson.title, position: 1 }] }] }) }
    else { await route.abort(); throw Error(`API inesperada: ${path}`) }
    if (reply.abort) return route.abort('failed')
    await route.fulfill({ status: reply.status ?? 200, contentType: 'application/json', body: JSON.stringify(reply.body ?? {}) })
  })
  const page = await context.newPage(); page.setDefaultTimeout(5000)
  page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []))
  return { page, context, calls, handlers }
}
async function login(page) {
  await page.getByRole('link', { name: 'Inicia sesión para responder' }).click()
  await page.getByLabel('Correo electrónico').fill(user.email)
  await page.getByLabel('Contraseña', { exact: true }).fill('ValidPassword123!')
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click()
  await page.waitForURL('**/lecciones/7')
  await page.getByRole('radio', { name: '<body>', exact: true }).waitFor()
}

test('lectura pública, HTML como texto, curso/unidad, navegación y formulario accesible', async t => {
  const { page, calls } = await setup(t)
  await page.goto(`${origin}/cursos/html`)
  await page.getByRole('link', { name: 'Lección 1: Estructura HTML' }).click()
  await page.getByRole('heading', { level: 1, name: lesson.title }).waitFor()
  await page.getByText('Curso: HTML · Unidad: Fundamentos').waitFor()
  assert.equal(await page.locator('#content-title + p').textContent(), lesson.content)
  assert.equal(await page.locator('main img, main script').count(), 0)
  assert.equal(await page.evaluate(() => window.xss), undefined)
  assert.equal(await page.getByRole('radio').count(), 2)
  assert.equal(await page.getByRole('button', { name: 'Enviar respuesta' }).isDisabled(), true)
  assert.equal(calls.some(call => call.path.startsWith('/api/auth')), false)
  assert.equal(calls.some(call => call.method === 'POST'), false)
  await page.getByRole('link', { name: 'Volver al curso y explorar lecciones' }).click()
  await page.waitForURL('**/cursos/html')
})
test('login retorna a lección, selección por teclado, doble clic, feedback y progreso confirmado', async t => {
  const gate = deferred()
  const { page, calls } = await setup(t, { answer: async () => { await gate.promise; return { body: success(answer) } } })
  await page.goto(`${origin}/lecciones/7`); await login(page)
  const submit = page.getByRole('button', { name: 'Enviar respuesta' })
  assert.equal(await submit.isDisabled(), true)
  const radio = page.getByRole('radio', { name: '<body>', exact: true }); await radio.focus(); await page.keyboard.press('Space')
  assert.notEqual(await radio.evaluate(el => getComputedStyle(el).outlineStyle), 'none')
  await submit.click(); await page.getByText('Confirmando respuesta…').waitFor()
  assert.equal(await page.getByRole('button', { name: 'Enviando…' }).isDisabled(), true)
  assert.equal(await page.getByText('¡Respuesta correcta!').count(), 0)
  const posts = calls.filter(call => call.path.endsWith('/answer'))
  assert.equal(posts.length, 1); assert.deepEqual(posts[0].body, { questionId: 31, optionIndex: 1 }); assert.equal(posts[0].headers.authorization, 'Bearer token')
  gate.resolve(); await page.getByText('¡Respuesta correcta!').waitFor(); await page.getByText('Lección completada.', { exact: true }).waitFor()
  await page.getByRole('link', { name: 'Mi progreso', exact: true }).click()
  await page.getByRole('heading', { name: 'Lecciones completadas: 1 de 9' }).waitFor()
  await page.getByText('Intentos: 2', { exact: true }).waitFor(); await page.getByText('Respuestas correctas: 1', { exact: true }).waitFor()
  assert.ok(calls.filter(call => call.path === '/api/progress').every(call => !!call.headers.authorization))
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0])
  await page.getByRole('link', { name: 'Mi perfil' }).click(); await page.getByRole('button', { name: 'Cerrar sesión' }).click()
  await page.waitForURL(`${origin}/`); await page.goto(`${origin}/mi-progreso`)
  await page.waitForURL('**/iniciar-sesion?redirect=/mi-progreso')
  assert.equal(await page.getByText('Intentos: 2', { exact: true }).count(), 0)
})
test('respuesta incorrecta y error ambiguo: no repetir ni afirmar guardado', async t => {
  const { page, handlers, calls } = await setup(t, { answer: () => ({ body: success({ ...answer, correct: false, completed: false, progress: { attempts: 1, correctAnswers: 0, completedAt: null } }) }) })
  await page.goto(`${origin}/lecciones/7`); await login(page)
  await page.getByRole('radio', { name: '<head>', exact: true }).check()
  await page.getByRole('button', { name: 'Enviar respuesta' }).click()
  await page.getByText('Respuesta incorrecta. Puedes revisar la explicación y volver a intentarlo.').waitFor()
  await page.getByText('Explicación del servidor').waitFor()
  handlers.answer = () => ({ abort: true })
  await page.getByRole('button', { name: 'Enviar respuesta' }).click()
  await page.getByText(/No se pudo confirmar el resultado/).waitFor()
  assert.equal(await page.getByRole('button', { name: 'Enviar respuesta' }).isDisabled(), true)
  assert.equal(calls.filter(call => call.path.endsWith('/answer')).length, 2)
  await page.getByRole('link', { name: 'Consultar mi progreso antes de responder de nuevo' }).waitFor()
  assert.equal(await page.getByText('Explicación del servidor').count(), 0)
})
test('lección sin preguntas/contenido, errores y reintento GET', async t => {
  const { page, handlers } = await setup(t, { lesson: () => ({ status: 500 }) })
  await page.goto(`${origin}/lecciones/7`)
  await page.getByRole('button', { name: 'Reintentar' }).waitFor()
  assert.equal(await page.getByText('Lección no encontrada.').count(), 0)
  handlers.lesson = () => ({ body: success({ ...lesson, content: null, questions: [] }) })
  await page.getByRole('button', { name: 'Reintentar' }).click()
  await page.getByText('Esta lección todavía no tiene actividades disponibles.').waitFor()
  await page.getByText('Esta lección todavía no tiene contenido disponible.').waitFor()
  assert.equal(await page.getByRole('button', { name: 'Enviar respuesta' }).count(), 0)
  assert.equal(await page.getByText('Lección completada.').count(), 0)
})
test('progreso privado vacío, error y recuperación, diseño móvil', async t => {
  const { page, handlers } = await setup(t, { progress: () => ({ body: success({ completedLessons: 0, totalLessons: 9, lessons: [] }) }) })
  await page.setViewportSize({ width: 360, height: 800 })
  await page.goto(`${origin}/mi-progreso`); await page.waitForURL('**/iniciar-sesion?redirect=/mi-progreso')
  await page.getByLabel('Correo electrónico').fill(user.email); await page.getByLabel('Contraseña', { exact: true }).fill('ValidPassword123!')
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click()
  await page.getByText('Todavía no tienes actividad registrada. Explora un curso para comenzar.').waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
  handlers.progress = () => ({ status: 500 })
  await page.getByRole('button', { name: 'Actualizar progreso' }).click(); await page.getByRole('button', { name: 'Reintentar' }).waitFor()
  handlers.progress = () => ({ body: success(progress) })
  await page.getByRole('button', { name: 'Reintentar' }).click(); await page.getByText('Intentos: 2', { exact: true }).waitFor()
})
