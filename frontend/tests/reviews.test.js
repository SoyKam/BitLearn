import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { createPinia, setActivePinia, disposePinia } from 'pinia'
import ts from 'typescript'

const modules = new Map()
async function moduleUrl(url) {
  if (modules.has(url.href)) return modules.get(url.href)
  const source = await readFile(url, 'utf8')
  let { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext } })
  for (const match of [...outputText.matchAll(/from '([^']+)'/g)]) {
    const specifier = match[1]
    const target = specifier.startsWith('.') ? await moduleUrl(new URL(`${specifier}.ts`, url)) : import.meta.resolve(specifier)
    outputText = outputText.replaceAll(`from '${specifier}'`, `from '${target}'`)
  }
  const result = `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
  modules.set(url.href, result)
  return result
}
const load = async path => import(await moduleUrl(new URL(`../src/${path}.ts`, import.meta.url)))
const { reviewService, createReviewRequestId, reviewError } = await load('services/review.service')
const { useReviewStore } = await load('stores/review.store')
const { useAuthStore } = await load('stores/auth.store')
const { HttpError } = await load('services/http.service')
const { loginDestination } = await load('router/auth.guard')
const success = data => ({ success: true, data })
const card = { flashcardId: 5, lessonId: 3, lessonTitle: 'HTML', courseSlug: 'html', front: '<div>', back: '<a>Respuesta</a>', status: 'new', repetitions: 0, easeFactor: 2.5, intervalDays: 0, lastReviewAt: null, nextReviewAt: null }
const result = { reviewId: '9007199254740993', flashcardId: 5, quality: 4, easeFactor: 2.5, intervalDays: 1, reviewedAt: '2026-11-04T12:00:00.000Z', nextReviewAt: '2026-11-05T12:00:00.000Z', replayed: false }
const item = { reviewId: result.reviewId, flashcardId: 5, courseSlug: 'html', lessonTitle: 'HTML', front: '<div>', quality: 4, reviewedAt: result.reviewedAt, nextReviewAt: result.nextReviewAt, easeFactorBefore: 2.5, easeFactorAfter: 2.5, intervalBeforeDays: 0, intervalAfterDays: 1 }
const empty = { items: [], total: 0, limit: 20, offset: 0 }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { resolve, promise } }
function setup(t) {
  const pinia = createPinia(); setActivePinia(pinia); t.after(() => disposePinia(pinia))
  const auth = useAuthStore()
  const signIn = (id = 1) => { auth.user = { id, name: 'Test', email: 'test@example.com' }; auth.accessToken = `token-${id}`; auth.expiresAt = Date.now() + 900000; auth.status = 'authenticated' }
  signIn()
  return { auth, signIn, store: useReviewStore() }
}
function api(t, overrides = {}) {
  const handlers = { due: () => [card], history: () => empty, post: () => result, ...overrides }
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push({ url, ...options })
    const data = await (url.includes('/due') ? handlers.due() : url.includes('/history') ? handlers.history(url) : handlers.post(JSON.parse(options.body)))
    return data instanceof Response ? data : Response.json(success(data))
  })
  return { handlers, calls }
}
test('servicios: rutas relativas, JWT, UUID v4, cuerpo público y contratos reales', async t => {
  const { calls } = api(t, { history: () => ({ ...empty, total: 1, items: [item] }) })
  assert.deepEqual(await reviewService.getDueReviews('jwt'), [card])
  assert.equal((await reviewService.getReviewHistory('jwt')).items[0].reviewId, result.reviewId)
  const requestId = createReviewRequestId()
  assert.match(requestId, /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/)
  assert.deepEqual(await reviewService.submitReview('jwt', { flashcardId: 5, quality: 4, requestId, userId: 99 }), result)
  assert.deepEqual(calls.map(c => c.url), ['/api/reviews/due?limit=50', '/api/reviews/history?limit=20&offset=0', '/api/reviews'])
  assert.ok(calls.every(c => c.headers.Authorization === 'Bearer jwt' && c.credentials === 'same-origin'))
  assert.deepEqual(JSON.parse(calls[2].body), { flashcardId: 5, quality: 4, requestId })
})
for (const change of [{ flashcardId: 0 }, { lessonId: 1.5 }, { lessonTitle: '' }, { courseSlug: '../x' }, { front: null }, { back: '' }, { status: 'other' }, { repetitions: -1 }, { easeFactor: 1.2 }, { intervalDays: -1 }, { lastReviewAt: 'bad' }, { nextReviewAt: result.nextReviewAt }, { easeFactor: 2.6 }, { status: 'due' }, { userId: 7 }]) {
  test(`rechaza pendiente inválido ${JSON.stringify(change)}`, async t => {
    api(t, { due: () => [{ ...card, ...change }] })
    await assert.rejects(reviewService.getDueReviews('jwt'), { kind: 'response' })
  })
}
test('pendientes duplicados, vacío y estado persistido coherente', async t => {
  const { handlers } = api(t, { due: () => [card, card] })
  await assert.rejects(reviewService.getDueReviews('jwt'))
  handlers.due = () => []; assert.deepEqual(await reviewService.getDueReviews('jwt'), [])
  handlers.due = () => [{ ...card, status: 'due', repetitions: 0, intervalDays: 1, lastReviewAt: result.reviewedAt, nextReviewAt: result.nextReviewAt }]
  assert.equal((await reviewService.getDueReviews('jwt'))[0].status, 'due')
})
for (const change of [{ reviewId: 1 }, { reviewId: '0' }, { flashcardId: 6 }, { quality: 3 }, { quality: 6 }, { easeFactor: null }, { intervalDays: -1 }, { reviewedAt: '2026-02-30T12:00:00.000Z' }, { nextReviewAt: 'yesterday' }, { replayed: 1 }, { repetitions: 1 }]) {
  test(`rechaza resultado inválido ${JSON.stringify(change)}`, async t => {
    api(t, { post: () => ({ ...result, ...change }) })
    await assert.rejects(reviewService.submitReview('jwt', { flashcardId: 5, quality: 4, requestId: createReviewRequestId() }), { kind: 'response' })
  })
}
test('historial: rechaza paginación, duplicados, orden y campos inválidos', async t => {
  const { handlers } = api(t)
  for (const data of [{ ...empty, total: -1 }, { ...empty, limit: 10 }, { ...empty, offset: 20 }, { ...empty, total: 1 },
    { ...empty, total: 2, items: [item, item] }, { ...empty, total: 1, items: [{ ...item, easeFactorBefore: 1 }] },
    { ...empty, total: 1, items: [{ ...item, reviewedAt: 'bad' }] }, { ...empty, total: 1, items: [{ ...item, userId: 1 }] },
    { ...empty, total: 2, items: [{ ...item, reviewId: '1' }, item] }]) {
    handlers.history = () => data
    await assert.rejects(reviewService.getReviewHistory('jwt'), { kind: 'response' })
  }
})
for (const status of [400, 401, 403, 404, 409, 429, 500, 503]) {
  test(`HTTP ${status}: error de repasos controlado, sin reintento POST`, async t => {
    const { calls } = api(t, { post: () => new Response('secret SQL stack', { status }) })
    await assert.rejects(reviewService.submitReview('jwt', { flashcardId: 5, quality: 4, requestId: createReviewRequestId() }), cause => {
      assert.equal(reviewError(cause).status, status); assert.doesNotMatch(reviewError(cause).message, /correo|secret|SQL|stack/); return true
    })
    assert.equal(calls.length, 1)
  })
}
test('estado, deduplicación GET, selección y revelado', async t => {
  const gate = deferred(); const { calls } = api(t, { due: () => gate.promise })
  const { store } = setup(t)
  assert.equal(store.selected, null); assert.equal(store.loaded, false)
  const a = store.loadDueReviews(), b = store.loadDueReviews()
  assert.equal(store.loading, true); gate.resolve([card, { ...card, flashcardId: 6 }]); await Promise.all([a, b])
  assert.equal(calls.length, 1); assert.equal(store.selectedId, 5)
  await store.submitReview(4); assert.equal(calls.length, 1)
  store.revealAnswer(); assert.equal(store.revealed, true)
  store.selectFlashcard(6); assert.equal(store.selectedId, 6); assert.equal(store.revealed, false)
})
test('doble envío bloqueado, resultado confirmado, recarga y UUID nuevo por operación', async t => {
  const gate = deferred(); const { calls, handlers } = api(t, { post: () => gate.promise })
  const { store } = setup(t); await store.loadDueReviews(); store.revealAnswer()
  const first = store.submitReview(4); await store.submitReview(5)
  assert.equal(store.submitting, true); assert.equal(store.result, null)
  gate.resolve(result); await first
  assert.deepEqual(store.result, result); assert.equal(store.submitting, false)
  assert.equal(calls.filter(c => c.url.includes('/due')).length, 2)
  handlers.post = () => result; store.revealAnswer(); await store.submitReview(4)
  const posts = calls.filter(c => c.method === 'POST'); assert.equal(posts.length, 2)
  assert.notEqual(JSON.parse(posts[0].body).requestId, JSON.parse(posts[1].body).requestId)
})
test('respuesta perdida: mismo UUID/calidad/tarjeta, sin reenvío automático, replayed', async t => {
  const { calls, handlers } = api(t, { post: () => { throw Error('connection') } })
  const { store } = setup(t); await store.loadDueReviews(); store.revealAnswer(); await store.submitReview(4)
  assert.equal(store.uncertain, true); assert.equal(store.result, null)
  const original = { ...store.pending }; store.selectFlashcard(6); await store.submitReview(5); await store.loadDueReviews()
  assert.deepEqual(store.pending, original); assert.equal(calls.length, 2)
  handlers.post = () => ({ ...result, replayed: true }); await store.retryConfirmation()
  assert.equal(store.result.replayed, true); assert.equal(store.pending, null); assert.equal(store.uncertain, false)
  const posts = calls.filter(c => c.method === 'POST'); assert.equal(posts.length, 2); assert.equal(posts[0].body, posts[1].body)
})
test('fallo al actualizar pendientes conserva confirmación y solo reintenta GET', async t => {
  const { calls, handlers } = api(t)
  const { store } = setup(t); await store.loadDueReviews(); store.revealAnswer()
  handlers.due = () => { throw Error('offline') }; await store.submitReview(4)
  assert.deepEqual(store.result, result); assert.ok(store.loadError); assert.equal(store.uncertain, false)
  await store.submitReview(4); handlers.due = () => []; await store.reloadDueReviews()
  assert.equal(store.selected, null); assert.equal(calls.filter(c => c.method === 'POST').length, 1)
})
test('historial paginado, vacío fuera de página y deduplicación', async t => {
  const { calls } = api(t, { history: url => ({ ...empty, offset: Number(new URL(url, 'http://local').searchParams.get('offset')) }) })
  const { store } = setup(t); await Promise.all([store.loadHistory(20), store.loadHistory(20)])
  assert.equal(store.history.offset, 20); assert.deepEqual(store.history.items, []); assert.equal(calls.length, 1)
  await store.loadHistory(0); assert.equal(store.history.offset, 0)
})
test('logout y cambio de usuario invalidan GET antiguos y limpian todos los datos', async t => {
  const gate = deferred(); const { handlers } = api(t, { due: () => gate.promise, history: () => gate.promise })
  const { store, auth, signIn } = setup(t)
  const oldDue = store.loadDueReviews(), oldHistory = store.loadHistory()
  auth.clearSession(); signIn(2)
  handlers.due = () => []; handlers.history = () => empty
  await Promise.all([store.loadDueReviews(), store.loadHistory()]); gate.resolve([card]); await Promise.all([oldDue, oldHistory])
  assert.equal(store.ownerId, 2); assert.deepEqual(store.due, []); assert.deepEqual(store.history.items, []); assert.equal(store.result, null)
})
test('POST tardío de A no altera resultado ni bloqueo del POST de B', async t => {
  const a = deferred(), b = deferred(); const { handlers } = api(t, { post: () => a.promise })
  const { store, auth, signIn } = setup(t); await store.loadDueReviews(); store.revealAnswer(); const old = store.submitReview(4)
  auth.clearSession(); assert.equal(store.pending, null); signIn(2)
  await store.loadDueReviews(); store.revealAnswer(); handlers.post = () => b.promise; const current = store.submitReview(4)
  a.resolve(result); await old; assert.equal(store.submitting, true); assert.equal(store.result, null)
  b.resolve(result); await current; assert.equal(store.result.reviewId, result.reviewId)
})
test('GET 401 renueva una vez; POST 401 espera confirmación explícita con el mismo UUID', async t => {
  const { calls, handlers } = api(t, { due: () => new Response('{}', { status: 401 }) })
  const { store, auth } = setup(t)
  const refresh = t.mock.method(auth, 'refreshSession', async () => 'renewed')
  await store.loadDueReviews(); assert.equal(calls.length, 2); assert.equal(refresh.mock.callCount(), 1)
  handlers.due = () => [card]; await store.loadDueReviews(); store.revealAnswer()
  handlers.post = () => new Response('{}', { status: 401 }); await store.submitReview(4)
  assert.equal(refresh.mock.callCount(), 1); assert.equal(store.uncertain, true)
  handlers.post = () => result; await store.retryConfirmation()
  assert.equal(refresh.mock.callCount(), 2)
  const posts = calls.filter(c => c.method === 'POST'); assert.equal(posts.length, 2); assert.equal(posts[0].body, posts[1].body)
})
test('token próximo a expirar se renueva antes de enviar', async t => {
  api(t); const { store, auth } = setup(t); await store.loadDueReviews(); store.revealAnswer(); auth.expiresAt = 0
  const refresh = t.mock.method(auth, 'refreshSession', async () => { auth.expiresAt = Date.now() + 900000; return 'new' })
  await store.submitReview(4); assert.equal(refresh.mock.callCount(), 1)
})
test('UUID no disponible: no envía POST; destino de login cerrado', async t => {
  const { calls } = api(t); const { store } = setup(t); await store.loadDueReviews(); store.revealAnswer()
  t.mock.method(globalThis.crypto, 'randomUUID', () => { throw new HttpError('validation', 'Utiliza HTTPS.') })
  await store.submitReview(4); assert.match(store.submitError.message, /HTTPS/); assert.equal(calls.length, 1)
  assert.equal(loginDestination('/repasos'), '/repasos')
  for (const path of ['//evil.test/repasos', 'https://evil.test', '/repasos?next=evil', '/repasos/../admin']) assert.equal(loginDestination(path), '/perfil')
})
test('JSON ilegible tras POST mantiene operación incierta', async t => {
  const { calls } = api(t, { post: () => new Response('not-json', { status: 200 }) })
  const { store } = setup(t); await store.loadDueReviews(); store.revealAnswer(); await store.submitReview(4)
  assert.equal(store.uncertain, true); assert.equal(store.result, null); assert.ok(store.pending)
  assert.equal(calls.filter(c => c.method === 'POST').length, 1)
})
test('logout elimina historial, selección, resultado e intento incierto ya cargados', async t => {
  const { handlers } = api(t, { history: () => ({ ...empty, total: 1, items: [item] }) })
  const { store, auth } = setup(t); await store.loadDueReviews(); store.revealAnswer(); await store.submitReview(4)
  assert.ok(store.result); assert.equal(store.history.items.length, 1)
  store.revealAnswer(); handlers.post = () => { throw Error('offline') }; await store.submitReview(4)
  assert.ok(store.pending); auth.clearSession()
  assert.equal(store.ownerId, null); assert.equal(store.selected, null); assert.equal(store.result, null)
  assert.equal(store.pending, null); assert.deepEqual(store.due, []); assert.deepEqual(store.history.items, [])
  assert.equal(store.uncertain, false); assert.equal(store.submitError, null)
})
test('historial anterior al POST confirmado no puede sobrescribir el nuevo', async t => {
  const gate = deferred(); const { handlers } = api(t, { history: () => gate.promise })
  const { store } = setup(t); await store.loadDueReviews(); const oldHistory = store.loadHistory()
  handlers.history = () => ({ ...empty, total: 1, items: [item] }); store.revealAnswer(); await store.submitReview(4)
  gate.resolve(empty); await oldHistory; assert.equal(store.history.total, 1)
})
