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
  const handlers = { dashboard: () => ({ data: stats }), retention: () => ({ data: projection }), due: () => ({ data: [card] }), history: () => ({ data: empty }), post: () => ({ data: result }), ...overrides }
  await context.route('**/api/**', async route => {
    const req = route.request(), url = new URL(req.url()), path = url.pathname
    calls.push({ path, method: req.method(), body: req.postDataJSON(), headers: req.headers() })
    const user = { id: userId, name: `Usuario ${userId}`, email: 'test@example.com' }
    let reply
    if (path === '/api/dashboard') reply = await handlers.dashboard(userId)
    else if (path === '/api/dashboard/retention') reply = await handlers.retention(userId)
    else if (path === '/api/reviews/due') reply = await handlers.due(userId)
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
  await page.goto(`${origin}/dashboard`)
  await page.waitForURL('**/iniciar-sesion?redirect=/dashboard')
  await page.getByLabel('Correo electrónico').fill('test@example.com')
  await page.getByLabel('Contraseña', { exact: true }).fill('ValidPassword123!')
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click()
  await page.waitForURL('**/dashboard')
  await page.getByRole('heading', { name: 'Mi dashboard' }).waitFor()
}

const stats={summary:{totalLessons:9,completedLessons:4,completionPercent:44.44,studiedFlashcards:2,dueReviews:3,totalReviews:12},
 courses:[{courseId:1,courseSlug:'html',courseTitle:'HTML',totalLessons:3,completedLessons:2,completionPercent:66.67}]}
const noData={asOf:'2026-11-04T12:00:00.000Z',modeledCards:0,averageRetentionNowPercent:null,nextScheduledReviewAt:null,points:[]}
const projection={...noData,modeledCards:2,averageRetentionNowPercent:80,nextScheduledReviewAt:'2026-11-05T12:00:00.000Z',
 points:[0,1,3,7,14,30].map((daysAhead,i)=>({daysAhead,estimatedRetentionPercent:80-i*10}))}
test('guard, JWT, indicadores, curso, gráfica, tabla, aviso, fecha, teclado y móvil',async t=>{
 const {page,calls}=await setup(t);await page.setViewportSize({width:360,height:800});await login(page)
 await page.getByText('4 de 9',{exact:true}).waitFor()
 await page.getByText('44.44 %',{exact:true}).waitFor()
 assert.equal(await page.locator('progress').getAttribute('value'),'66.67')
 await page.getByRole('img').waitFor();assert.equal(await page.locator('tbody tr').count(),6)
 await page.getByText(/No representa una medición real de tu memoria/).waitFor()
 await page.getByText(/Próxima revisión programada: 5 de noviembre de 2026/).waitFor()
 assert.ok(calls.filter(c=>c.path.startsWith('/api/dashboard')).every(c=>c.headers.authorization==='Bearer token-1'))
 const update=page.getByRole('button',{name:'Actualizar dashboard'});await update.focus();await page.keyboard.press('Enter')
 await page.getByText('4 de 9',{exact:true}).waitFor()
 assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true)
})
test('error, recuperación, vacío, logout y segundo usuario sin datos anteriores',async t=>{
 const {page,handlers}=await setup(t,{retention:()=>({status:503})});await login(page)
 await page.getByRole('alert').waitFor()
 handlers.retention=()=>({data:projection});await page.getByRole('button',{name:'Actualizar dashboard'}).click()
 await page.getByRole('img').waitFor()
 await page.getByRole('link',{name:'Mi perfil',exact:true}).click()
 await page.getByRole('button',{name:'Cerrar sesión'}).click();await page.waitForURL(origin+'/')
 handlers.retention=()=>({data:noData})
 handlers.dashboard=()=>({data:{summary:{totalLessons:9,completedLessons:0,completionPercent:0,studiedFlashcards:0,dueReviews:0,totalReviews:0},courses:[]}})
 await login(page);await page.getByText('Todavía no hay suficientes repasos para generar una proyección.').waitFor()
 assert.equal(await page.getByRole('img').count(),0);assert.equal(await page.getByText('4 de 9',{exact:true}).count(),0)
 await page.getByText('No hay una próxima revisión futura registrada.').waitFor()
 assert.deepEqual(await page.evaluate(()=>[localStorage.length,sessionStorage.length]),[0,0])
})
