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
const { lessonService } = await load('services/lesson.service')
const { progressService } = await load('services/progress.service')
const { useLessonStore } = await load('stores/lesson.store')
const { useProgressStore } = await load('stores/progress.store')
const { useAuthStore } = await load('stores/auth.store')
const { loginDestination } = await load('router/auth.guard')
const success = data => ({ success: true, data })
const question = { id: 31, prompt: 'Pregunta API', options: ['<body>', '<head>'] }
const lesson = { id: 7, title: 'Lección API', content: '<script>no ejecutar</script>\nTexto', course: { id: 2, title: 'HTML', slug: 'html' }, unit: { id: 3, title: 'Unidad' }, questions: [question] }
const counters = { attempts: 2, correctAnswers: 1, completedAt: '2026-11-03T21:00:00.000Z' }
const answer = { correct: true, completed: true, explanation: 'Explicación API', progress: counters }
const personal = { completedLessons: 1, totalLessons: 9, lessons: [{ lessonId: 7, courseSlug: 'html', ...counters }] }
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done }); return { resolve, promise } }
function setup(t, authenticated = true) {
  const pinia = createPinia(); setActivePinia(pinia); t.after(() => disposePinia(pinia))
  const auth = useAuthStore()
  const signIn = (id = 1) => { auth.user = { id, name: 'Test', email: 'test@example.com' }; auth.accessToken = `token-${id}`; auth.expiresAt = Date.now() + 900000; auth.status = 'authenticated' }
  if (authenticated) signIn()
  return { auth, signIn, store: useLessonStore(), progress: useProgressStore() }
}

test('GET público decimal canónico, contenido null y sin cookies modificadas ni JWT', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/lessons/7'); assert.equal(options.method, 'GET')
    assert.equal(options.headers.Authorization, undefined); assert.equal(options.body, undefined)
    return Response.json(success({ ...lesson, content: null }))
  })
  assert.deepEqual((await lessonService.getLessonById('007')).data, { ...lesson, content: null })
})
for (const id of [0, -1, 1.5, 2147483648, '', '1e2', '7\n', ' 7', '../7', 'https://evil.com', ['7'], null]) {
  test(`ID inválido ${JSON.stringify(id)} sin red`, async t => {
    const fetch = t.mock.method(globalThis, 'fetch', () => { throw Error('No llamar') })
    await assert.rejects(lessonService.getLessonById(id), { kind: 'validation' })
    assert.equal(fetch.mock.callCount(), 0)
  })
}
for (const body of [null, { success: false }, success({ ...lesson, id: 8 }), success({ ...lesson, content: 3 }),
  success({ ...lesson, title: ' ' }), success({ ...lesson, course: { ...lesson.course, slug: '../html' } }),
  success({ ...lesson, questions: [question, question] }),
  ...[[], ['a'], ['a', ''], Array(7).fill('a')].map(options => success({ ...lesson, questions: [{ ...question, options }] })),
  success({ ...lesson, questions: [{ ...question, correct_option_index: 0 }] }),
  success({ ...lesson, userId: 3 }), success({ ...lesson, unit: null })]) {
  test('rechaza contrato de lección inválido o sensible', async t => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(body))
    await assert.rejects(lessonService.getLessonById(7), { kind: 'response' }); assert.equal(fetch.mock.callCount(), 1)
  })
}
for (const status of [400, 404, 500, 503]) {
  test(`GET HTTP ${status} controlado y reintento limitado`, async t => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({}, { status }))
    const { store } = setup(t); await store.loadLesson(7)
    assert.equal(store.error.status, status); assert.equal(store.lesson, null)
    assert.equal(fetch.mock.callCount(), status === 503 ? 2 : 1)
    fetch.mock.mockImplementation(async () => Response.json(success(lesson)))
    await store.reloadLesson(7); assert.equal(store.lesson.title, lesson.title); assert.equal(store.error, null)
  })
}
test('GET red: dos intentos y recuperación manual', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('SECRET') })
  const { store } = setup(t); await store.loadLesson(7)
  assert.equal(store.error.kind, 'connection'); assert.equal(fetch.mock.callCount(), 2)
  assert.ok(!store.error.message.includes('SECRET'))
})
test('POST incluye solo pregunta/opción y Bearer; nunca repite errores', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/lessons/7/answer'); assert.equal(options.method, 'POST')
    assert.equal(options.headers.Authorization, 'Bearer token')
    assert.deepEqual(JSON.parse(options.body), { questionId: 31, optionIndex: 0 })
    return Response.json(success(answer))
  })
  assert.deepEqual((await lessonService.submitAnswer(7, { questionId: 31, optionIndex: 0, userId: 99, correct: true }, 'token')).data, answer)
  for (const status of [400, 401, 404, 429, 500, 503]) {
    fetch.mock.mockImplementation(async () => Response.json({}, { status }))
    const before = fetch.mock.callCount()
    await assert.rejects(lessonService.submitAnswer(7, { questionId: 31, optionIndex: 0 }, 'token'), { status })
    assert.equal(fetch.mock.callCount(), before + 1)
  }
})
test('validación de respuesta seleccionada y autenticación impiden POST', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json(success(lesson)))
  const { store, signIn } = setup(t, false); await store.loadLesson(7)
  await store.submitAnswer({ questionId: 31, optionIndex: 0 }); assert.equal(store.answerError.status, 401)
  signIn()
  for (const input of [{ questionId: 99, optionIndex: 0 }, { questionId: 31, optionIndex: 2 }, { questionId: 31, optionIndex: -1 }, { questionId: 31, optionIndex: 0.5 }]) {
    await store.submitAnswer(input); assert.equal(store.answerError.status, 400)
  }
  assert.equal(fetch.mock.callCount(), 1)
})
test('estado inicial, deduplicación A → B → A, caché y descarte tras clear', async t => {
  const a = deferred(), b = deferred()
  const fetch = t.mock.method(globalThis, 'fetch', url => url.endsWith('/7') ? a.promise : b.promise)
  const { store } = setup(t)
  assert.equal(store.lesson, null); assert.equal(store.loading, false); assert.equal(store.error, null)
  const first = store.loadLesson(7), duplicate = store.loadLesson(7), second = store.loadLesson(8), third = store.loadLesson(7)
  assert.equal(fetch.mock.callCount(), 2); assert.equal(store.lesson, null)
  a.resolve(Response.json(success(lesson))); await Promise.all([first, duplicate, third])
  await store.loadLesson(7); assert.equal(fetch.mock.callCount(), 2)
  store.clearLesson(); b.resolve(Response.json(success({ ...lesson, id: 8 }))); await second
  assert.equal(store.lesson, null); assert.equal(store.loading, false)
})
test('respuesta antigua no sobrescribe la lección nueva', async t => {
  const old = deferred()
  t.mock.method(globalThis, 'fetch', url => url.endsWith('/7') ? old.promise : Response.json(success({ ...lesson, id: 8 })))
  const { store } = setup(t); const first = store.loadLesson(7); await store.loadLesson(8)
  old.resolve(Response.json(success(lesson))); await first; assert.equal(store.lesson.id, 8)
})
for (const correct of [true, false]) {
  test(`evaluación ${correct}: doble clic, solo confirmación y recarga de progreso`, async t => {
    const gate = deferred(); let posts = 0, gets = 0
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (options.method === 'POST') { posts++; return gate.promise }
      if (url === '/api/progress') { gets++; return Response.json(success(personal)) }
      return Response.json(success(lesson))
    })
    const { store, progress } = setup(t); await store.loadLesson(7)
    const first = store.submitAnswer({ questionId: 31, optionIndex: 0 }); await store.submitAnswer({ questionId: 31, optionIndex: 0 })
    assert.equal(posts, 1); assert.equal(store.submitting, true); assert.equal(store.result, null)
    gate.resolve(Response.json(success({ ...answer, correct }))); await first; await progress.loadProgress()
    assert.equal(store.result.correct, correct); assert.equal(progress.completedLessons, 1); assert.equal(gets, 1)
  })
}
for (const failure of ['network', 'invalid', 429]) {
  test(`POST ${failure}: sin reenvío y sin confirmación inventada`, async t => {
    let posts = 0
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      if (options.method !== 'POST') return Response.json(success(lesson))
      posts++
      if (failure === 'network') throw new TypeError('secret')
      return failure === 'invalid' ? Response.json({}) : Response.json({}, { status: failure })
    })
    const { store } = setup(t); await store.loadLesson(7); await store.submitAnswer({ questionId: 31, optionIndex: 0 })
    assert.equal(posts, 1); assert.equal(store.result, null); assert.equal(store.submitting, false)
    assert.equal(store.uncertain, failure !== 429)
    if (store.uncertain) { await store.submitAnswer({ questionId: 31, optionIndex: 0 }); assert.equal(posts, 1); assert.match(store.answerError.message, /No se pudo confirmar/) }
    else assert.equal(store.answerError.status, 429)
  })
}
for (const recovered of [true, false]) {
  test(`POST 401 recuperación ${recovered} sin repetir escritura`, async t => {
    let posts = 0, refreshes = 0
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (url === '/api/auth/refresh') { refreshes++; return recovered ? Response.json(success({ accessToken: 'fresh', expiresIn: 900 })) : Response.json({}, { status: 401 }) }
      if (options.method === 'POST') { posts++; return Response.json({}, { status: 401 }) }
      return Response.json(success(lesson))
    })
    const { store, auth } = setup(t); await store.loadLesson(7); await store.submitAnswer({ questionId: 31, optionIndex: 0 })
    assert.equal(posts, 1); assert.equal(refreshes, 1); assert.equal(store.result, null)
    assert.equal(auth.isAuthenticated, recovered)
    if (recovered) assert.match(store.answerError.message, /Sesión renovada/)
  })
}
test('GET progreso: contrato, JWT, vacío y rechazo de duplicados/contadores', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/progress'); assert.equal(options.headers.Authorization, 'Bearer token')
    return Response.json(success(personal))
  })
  assert.deepEqual((await progressService.getProgress('token')).data, personal)
  for (const data of [{ ...personal, lessons: [...personal.lessons, ...personal.lessons] }, { ...personal, completedLessons: 2 }, { ...personal, totalLessons: -1 }, { ...personal, userId: 1 }, { ...personal, lessons: [{ ...personal.lessons[0], correctAnswers: 9 }] }]) {
    fetch.mock.mockImplementation(async () => Response.json(success(data)))
    await assert.rejects(progressService.getProgress('token'), { kind: 'response' })
  }
  fetch.mock.mockImplementation(async () => Response.json(success({ completedLessons: 0, totalLessons: 9, lessons: [] })))
  assert.deepEqual((await progressService.getProgress('token')).data.lessons, [])
})
test('logout/cambio de usuario descarta progreso y evaluación en vuelo', async t => {
  const evaluation = deferred(), oldProgress = deferred()
  t.mock.method(globalThis, 'fetch', (url, options) => {
    if (options.method === 'POST') return evaluation.promise
    if (url === '/api/progress') return options.headers.Authorization === 'Bearer token-1' ? oldProgress.promise : Response.json(success({ completedLessons: 0, totalLessons: 9, lessons: [] }))
    return Response.json(success(lesson))
  })
  const { store, progress, auth, signIn } = setup(t)
  await store.loadLesson(7); const oldGet = progress.loadProgress(); const oldPost = store.submitAnswer({ questionId: 31, optionIndex: 0 })
  auth.clearSession(); assert.equal(progress.ownerId, null); assert.equal(store.result, null)
  signIn(2); await progress.loadProgress(); assert.equal(progress.ownerId, 2)
  oldProgress.resolve(Response.json(success(personal))); evaluation.resolve(Response.json(success(answer)))
  await Promise.all([oldGet, oldPost]); assert.equal(progress.ownerId, 2); assert.equal(progress.isEmpty, true); assert.equal(store.result, null)
})
test('navegación durante POST descarta resultado de la pregunta anterior', async t => {
  const gate = deferred()
  t.mock.method(globalThis, 'fetch', (url, options) => options.method === 'POST' ? gate.promise : Response.json(success({ ...lesson, id: Number(url.split('/').at(-1)) })))
  const { store } = setup(t); await store.loadLesson(7); const post = store.submitAnswer({ questionId: 31, optionIndex: 0 }); await store.loadLesson(8)
  gate.resolve(Response.json(success(answer))); await post; assert.equal(store.result, null); assert.equal(store.questionId, null)
})
test('destinos de login seguros con lista cerrada', () => {
  for (const path of ['/perfil', '/mi-progreso', '/lecciones/2147483647']) assert.equal(loginDestination(path), path)
  for (const path of ['//evil.test', 'https://evil.test', '/lecciones/0', '/lecciones/2147483648', '/lecciones/1\n', '/lecciones/1?next=https://evil.test', ['/mi-progreso']]) assert.equal(loginDestination(path), '/perfil')
})

test('token expirado: renovación coordinada antes del único POST', async t => {
  const paths = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    paths.push(url)
    if (url === '/api/auth/refresh') return Response.json(success({ accessToken: 'fresh', expiresIn: 900 }))
    if (url.endsWith('/answer')) { assert.equal(options.headers.Authorization, 'Bearer fresh'); return Response.json(success(answer)) }
    return Response.json(success(url === '/api/progress' ? personal : lesson))
  })
  const { store, auth, progress } = setup(t); await store.loadLesson(7); auth.expiresAt = 0
  await store.submitAnswer({ questionId: 31, optionIndex: 0 }); await progress.loadProgress()
  assert.deepEqual(paths, ['/api/lessons/7', '/api/auth/refresh', '/api/lessons/7/answer', '/api/progress'])
})
for (const failure of [401, 503, 'network']) {
  test(`progreso ${failure}: recuperación acotada y JWT actualizado`, async t => {
    let gets = 0, refreshes = 0
    t.mock.method(globalThis, 'fetch', async (url, options) => {
      if (url === '/api/auth/refresh') { refreshes++; return Response.json(success({ accessToken: 'fresh', expiresIn: 900 })) }
      gets++
      if (gets === 1) {
        if (failure === 'network') throw new TypeError('secret')
        return Response.json({}, { status: failure })
      }
      assert.equal(options.headers.Authorization, failure === 401 ? 'Bearer fresh' : 'Bearer token-1')
      return Response.json(success(personal))
    })
    const { progress } = setup(t); await progress.loadProgress()
    assert.equal(gets, 2); assert.equal(refreshes, failure === 401 ? 1 : 0)
    assert.equal(progress.loaded, true); assert.equal(progress.completedLessons, 1)
  })
}
test('progreso cacheado: logout limpia datos sincrónicamente y B consulta de nuevo', async t => {
  t.mock.method(globalThis, 'fetch', async (_url, options) => Response.json(success(options.headers.Authorization === 'Bearer token-1' ? personal : { completedLessons: 0, totalLessons: 9, lessons: [] })))
  const { auth, progress, signIn } = setup(t); await progress.loadProgress()
  assert.equal(progress.lessons.length, 1)
  auth.clearSession(); assert.deepEqual(progress.lessons, []); assert.equal(progress.loaded, false)
  signIn(2); await progress.loadProgress(); assert.equal(progress.ownerId, 2); assert.equal(progress.isEmpty, true)
})
test('contrato de evaluación: rechazar booleanos, explicación, fecha y contadores inválidos', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({}))
  for (const data of [{ ...answer, correct: 'true' }, { ...answer, explanation: 3 }, { ...answer, completed: false },
    { ...answer, progress: { ...counters, completedAt: 'invalid' } }, { ...answer, progress: { ...counters, attempts: -1 } }, { ...answer, solution: 'secret' }]) {
    fetch.mock.mockImplementation(async () => Response.json(success(data)))
    await assert.rejects(lessonService.submitAnswer(7, { questionId: 31, optionIndex: 0 }, 'token'), { kind: 'response' })
  }
})
