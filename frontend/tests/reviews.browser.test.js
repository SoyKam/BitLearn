import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'
let server, browser, origin
const success = data => ({ success: true, data })
const card = { flashcardId: 5, lessonId: 3, lessonTitle: 'Estructura HTML', courseSlug: 'html', front: '¿Qué hace <div>?', back: '<a onclick="window.xss=true">Respuesta</a>', status: 'new', repetitions: 0, easeFactor: 2.5, intervalDays: 0, lastReviewAt: null, nextReviewAt: null }
const result = { reviewId: '100', flashcardId: 5, quality: 4, easeFactor: 2.5, intervalDays: 1, reviewedAt: '2026-11-04T12:00:00.000Z', nextReviewAt: '2026-11-05T12:00:00.000Z', replayed: false }
const item = { reviewId: '100', flashcardId: 5, courseSlug: 'html', lessonTitle: 'Estructura HTML', front: card.front, quality: 4, reviewedAt: result.reviewedAt, nextReviewAt: result.nextReviewAt, easeFactorBefore: 2.5, easeFactorAfter: 2.5, intervalBeforeDays: 0, intervalAfterDays: 1 }
const empty = { items: [], total: 0, limit: 20, offset: 0 }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { resolve, promise } }
before(async () => {
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  await server.listen(); origin = `http://127.0.0.1:${server.httpServer.address().port}`
  browser = await chromium.launch({ headless: true })
})
after(async () => { await browser?.close(); await server?.close() })
async function setup(t, overrides = {}) {
  const context = await browser.newContext(); t.after(() => context.close())
  let session = false, userId = 0
  const calls = [], errors = []
  const handlers = { due: () => ({ data: [card] }), history: () => ({ data: empty }), post: () => ({ data: result }), ...overrides }
  await context.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname
    calls.push({ path, method: req.method(), body: req.postDataJSON(), headers: req.headers() })
    const user = { id: userId, name: `Usuario ${userId}`, email: 'test@example.com' }
    let reply
    if (path === '/api/reviews/due') reply = await handlers.due(userId)
    else if (path === '/api/reviews/history') reply = await handlers.history(Number(url.searchParams.get('offset')))
    else if (path === '/api/reviews') reply = await handlers.post(req.postDataJSON())
    else if (path === '/api/auth/refresh') reply = session ? { data: { accessToken: 'renewed', expiresIn: 900 } } : { status: 401 }
    else if (path === '/api/auth/login') { session = true; userId++; reply = { data: { user: { ...user, id: userId }, accessToken: `token-${userId}`, expiresIn: 900 } } }
    else if (path === '/api/auth/me') reply = { data: user }
    else if (path === '/api/auth/logout') { session = false; reply = { body: { success: true, message: 'Sesión cerrada' } } }
    else if (path === '/api/health') reply = { body: { status: 'ok', database: 'connected' } }
    else if (path === '/api/progress') reply = { data: { completedLessons: 0, totalLessons: 9, lessons: [] } }
    else { await route.abort(); errors.push(`API inesperada: ${path}`); return }
    if (reply.abort) return route.abort('failed')
    await route.fulfill({ status: reply.status ?? 200, contentType: 'application/json', body: JSON.stringify(reply.body ?? success(reply.data)) })
  })
  const page = await context.newPage(); page.setDefaultTimeout(6000)
  page.on('pageerror', error => errors.push(error.message)); t.after(() => assert.deepEqual(errors, []))
  return { page, context, calls, handlers }
}
async function login(page) {
  await page.goto(`${origin}/repasos`)
  await page.waitForURL('**/iniciar-sesion?redirect=/repasos')
  await page.getByLabel('Correo electrónico').fill('test@example.com')
  await page.getByLabel('Contraseña', { exact: true }).fill('ValidPassword123!')
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click()
  await page.waitForURL('**/repasos')
  await page.getByRole('heading', { name: 'Centro de repasos' }).waitFor()
}
const posts = calls => calls.filter(c => c.path === '/api/reviews' && c.method === 'POST')

test('guard, login, frente/reverso, teclado, doble clic, confirmación SM-2 y recarga', async t => {
  const gate = deferred()
  const { page, calls, handlers } = await setup(t, { post: async () => { await gate.promise; return { data: result } } })
  await login(page)
  await page.getByRole('heading', { name: 'Tarjetas disponibles en esta sesión: 1' }).waitFor()
  assert.equal(await page.getByText(card.front, { exact: true }).count(), 1)
  assert.equal(await page.getByText(card.back, { exact: true }).count(), 0)
  for (const name of ['Otra vez', 'Difícil', 'Bien', 'Fácil']) assert.equal(await page.getByRole('button', { name, exact: true }).isDisabled(), true)
  const reveal = page.getByRole('button', { name: 'Mostrar respuesta' })
  await page.keyboard.press('Tab'); await reveal.focus()
  assert.notEqual(await reveal.evaluate(el => getComputedStyle(el).outlineStyle), 'none')
  await page.keyboard.press('Enter'); await page.getByText(card.back, { exact: true }).waitFor()
  assert.equal(await page.locator('.study-card a, .study-card script').count(), 0)
  assert.equal(await page.evaluate(() => window.xss), undefined)
  await page.getByRole('button', { name: 'Bien', exact: true }).evaluate(el => { el.click(); el.click() })
  await page.getByText('Confirmando repaso…').waitFor()
  assert.equal(await page.getByRole('button', { name: 'Bien', exact: true }).isDisabled(), true)
  assert.equal(posts(calls).length, 1); assert.equal(posts(calls)[0].body.quality, 4)
  assert.deepEqual(Object.keys(posts(calls)[0].body).sort(), ['flashcardId', 'quality', 'requestId'])
  assert.equal(posts(calls)[0].headers.authorization, 'Bearer token-1')
  handlers.due = () => ({ data: [] }); handlers.history = () => ({ data: { ...empty, total: 1, items: [item] } })
  gate.resolve(); await page.getByRole('heading', { name: 'Repaso registrado correctamente.' }).waitFor()
  await page.getByText('Factor de facilidad: 2.50', { exact: true }).waitFor()
  await page.getByText('Próximo intervalo: 1 día', { exact: true }).waitFor()
  await page.getByText(/Siguiente revisión: 5 de noviembre de 2026/).waitFor()
  await page.getByText('No tienes repasos pendientes por ahora.').waitFor()
  await page.getByText('Detalles del repaso', { exact: true }).click()
  await page.getByText('Factor anterior: 2.50 · Factor posterior: 2.50', { exact: true }).waitFor()
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0])
})
test('conexión perdida, navegación interna y confirmación explícita conservan UUID', async t => {
  const { page, calls, handlers } = await setup(t, { post: () => ({ abort: true }) })
  await login(page); await page.getByRole('button', { name: 'Mostrar respuesta' }).click(); await page.getByRole('button', { name: 'Bien', exact: true }).click()
  await page.getByText('No pudimos confirmar el resultado de este repaso.', { exact: true }).waitFor()
  assert.equal(posts(calls).length, 1); assert.equal(await page.getByRole('heading', { name: 'Repaso registrado correctamente.' }).count(), 0)
  assert.equal(await page.getByRole('button', { name: 'Fácil', exact: true }).isDisabled(), true)
  await page.getByRole('link', { name: 'Mi progreso', exact: true }).click()
  await page.getByRole('link', { name: 'Mis repasos', exact: true }).click()
  await page.getByText('No pudimos confirmar el resultado de este repaso.', { exact: true }).waitFor()
  handlers.post = () => ({ data: { ...result, replayed: true } }); handlers.due = () => ({ data: [] })
  await page.getByRole('button', { name: 'Reintentar confirmación' }).click()
  await page.getByText('Confirmación recuperada del repaso original.').waitFor()
  assert.equal(posts(calls).length, 2); assert.deepEqual(posts(calls)[0].body, posts(calls)[1].body)
  assert.equal(await page.getByRole('heading', { name: 'Repaso registrado correctamente.' }).count(), 1)
})
for (const [status, message] of [[401, 'La sesión ya no es válida.'], [403, 'Completa la lección'], [409, 'La tarjeta ya no está pendiente'], [429, 'Demasiadas solicitudes.'], [503, 'El servicio de repasos no está disponible']]) {
  test(`HTTP ${status}: mensaje controlado y ausencia de reenvío automático`, async t => {
    const { page, calls, handlers } = await setup(t, { post: () => ({ status, body: { message: 'secret SQL correo' } }) })
    await login(page); await page.getByRole('button', { name: 'Mostrar respuesta' }).click(); await page.getByRole('button', { name: 'Bien', exact: true }).click()
    await page.getByText(message, { exact: false }).waitFor()
    assert.equal(posts(calls).length, 1); assert.doesNotMatch(await page.locator('main').textContent(), /secret|SQL|correo/)
    if (status === 401 || status === 503) {
      await page.getByText('No pudimos confirmar el resultado de este repaso.', { exact: true }).waitFor()
      handlers.post = () => ({ data: result }); handlers.due = () => ({ data: [] })
      await page.getByRole('button', { name: 'Reintentar confirmación' }).click()
      await page.getByRole('heading', { name: 'Repaso registrado correctamente.' }).waitFor()
      assert.deepEqual(posts(calls)[0].body, posts(calls)[1].body)
    }
  })
}
test('historial vacío, paginación con registros, página vacía posterior y móvil', async t => {
  const { page, handlers } = await setup(t, { due: () => ({ data: [] }) })
  await page.setViewportSize({ width: 360, height: 800 }); await login(page)
  await page.getByText('Todavía no has realizado repasos.').waitFor()
  handlers.history = offset => ({ data: { ...empty, total: 21, offset, items: offset === 0 ? Array.from({ length: 20 }, (_, i) => ({ ...item, reviewId: String(100 - i) })) : [{ ...item, reviewId: '80' }] } })
  await page.getByRole('button', { name: 'Actualizar historial' }).click(); await page.getByText('Página 1 · 21 repasos').waitFor()
  await page.getByRole('button', { name: 'Página siguiente' }).click(); await page.getByText('Página 2 · 21 repasos').waitFor()
  handlers.history = offset => ({ data: { ...empty, total: 1, offset, items: offset === 0 ? [item] : [] } })
  await page.getByRole('button', { name: 'Actualizar historial' }).click(); await page.getByText('No hay repasos en esta página.').waitFor()
  assert.equal(await page.getByRole('button', { name: 'Página anterior' }).isEnabled(), true)
  await page.getByRole('button', { name: 'Página anterior' }).click(); await page.getByText('Página 1 · 1 repasos').waitFor()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
})
test('error GET y recuperación; botones y respuesta extensa no desbordan en móvil', async t => {
  const { page, handlers } = await setup(t, { due: () => ({ abort: true }) })
  await page.setViewportSize({ width: 320, height: 800 }); await login(page)
  await page.getByRole('button', { name: 'Reintentar pendientes' }).waitFor()
  handlers.due = () => ({ data: [{ ...card, back: 'a'.repeat(500) }] })
  await page.getByRole('button', { name: 'Reintentar pendientes' }).click(); await page.getByRole('button', { name: 'Mostrar respuesta' }).click()
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
})
test('logout y usuario B: sin tarjetas, historial ni resultado de A', async t => {
  const { page, handlers } = await setup(t)
  await login(page); await page.getByRole('button', { name: 'Mostrar respuesta' }).click(); await page.getByRole('button', { name: 'Bien', exact: true }).click()
  await page.getByRole('heading', { name: 'Repaso registrado correctamente.' }).waitFor()
  await page.getByRole('link', { name: 'Mi perfil', exact: true }).click(); await page.getByRole('button', { name: 'Cerrar sesión' }).click(); await page.waitForURL(`${origin}/`)
  handlers.due = id => ({ data: id === 2 ? [] : [card] })
  await login(page); await page.getByText('No tienes repasos pendientes por ahora.').waitFor()
  assert.equal(await page.getByText(card.front, { exact: true }).count(), 0)
  assert.equal(await page.getByRole('heading', { name: 'Repaso registrado correctamente.' }).count(), 0)
  await page.getByText('Todavía no has realizado repasos.').waitFor()
})
for (const [name, quality] of [['Otra vez', 1], ['Difícil', 3], ['Fácil', 5]]) {
  test(`calificación ${name} envía calidad ${quality}`, async t => {
    const { page, calls } = await setup(t, { post: input => ({ data: { ...result, quality: input.quality } }) })
    await login(page); await page.getByRole('button', { name: 'Mostrar respuesta' }).click()
    await page.getByRole('button', { name, exact: true }).click()
    await page.getByText(`Calificación: ${name}`, { exact: true }).waitFor()
    assert.equal(posts(calls)[0].body.quality, quality)
  })
}
test('GET historial con error permite reintentar sin crear repasos', async t => {
  const { page, calls, handlers } = await setup(t, { history: () => ({ status: 503 }) })
  await login(page); await page.getByRole('button', { name: 'Reintentar historial' }).waitFor()
  handlers.history = () => ({ data: empty }); await page.getByRole('button', { name: 'Reintentar historial' }).click()
  await page.getByText('Todavía no has realizado repasos.').waitFor(); assert.equal(posts(calls).length, 0)
})
