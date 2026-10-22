import assert from 'node:assert/strict'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { chromium } from 'playwright'
import { createServer } from 'vite'

// Navegador real + API interceptada. Ninguna solicitud llega al backend/DB.
let server
let browser
let origin
const user = { id: 1, name: 'Juan Pérez', email: 'juan@example.com', created_at: '2026-10-01T12:00:00.000Z' }
const credentials = { email: user.email, password: '  MiClaveSegura2026!  ' }
const success = data => ({ success: true, data })
const token = value => ({ accessToken: value, expiresIn: 900 })

before(async () => {
  server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), server: { host: '127.0.0.1', port: 0 }, logLevel: 'error' })
  await server.listen()
  origin = `http://127.0.0.1:${server.httpServer.address().port}`
  // Instalar una vez con npx playwright install chromium. Si falta, falla: no se omite.
  browser = await chromium.launch({ headless: true })
})
after(async () => { await browser?.close(); await server?.close() })

async function setup(t, overrides = {}) {
  const context = await browser.newContext()
  t.after(() => context.close())
  const calls = []
  const errors = []
  const state = { session: false, rotations: 0 }
  const handlers = {
    health: () => ({ body: { status: 'ok', database: 'connected' } }),
    register: () => ({ status: 201, body: success(user) }),
    login: () => { state.session = true; return { body: success({ user, ...token('access-login') }), cookie: 'initial' } },
    refresh: () => state.session
      ? { body: success(token(`access-refresh-${++state.rotations}`)), cookie: `rotated-${state.rotations}` }
      : { status: 401 },
    me: () => ({ body: success(user) }),
    logout: () => { state.session = false; return { body: { success: true, message: 'Sesión cerrada correctamente.' }, cookie: '' } },
    ...overrides,
  }
  await context.route('**/api/**', async route => {
    const req = route.request()
    const url = new URL(req.url())
    const action = url.pathname.split('/').at(-1)
    const call = { action, method: req.method(), body: req.postDataJSON(), headers: req.headers(), url: url.pathname }
    calls.push(call)
    if (!handlers[action]) { await route.abort(); throw new Error(`API no interceptada: ${url.pathname}`) }
    const reply = await handlers[action](call, state)
    if (reply.abort) return route.abort('failed')
    await route.fulfill({
      status: reply.status ?? 200,
      contentType: reply.contentType ?? 'application/json',
      headers: { 'Cache-Control': 'no-store', ...(reply.cookie !== undefined ? { 'Set-Cookie': `bitlearn_refresh=${reply.cookie}; Path=/api/auth; HttpOnly; SameSite=Strict${reply.cookie ? '' : '; Max-Age=0'}` } : {}) },
      body: reply.raw ?? JSON.stringify(reply.body ?? { success: false, message: 'INTERNAL_TRACE_DO_NOT_SHOW' }),
    })
  })
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)))
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  t.after(() => assert.deepEqual(errors, [], 'sin excepciones del navegador'))
  return { context, page, calls, state, handlers }
}

async function store(page, operation, argument) {
  return page.evaluate(async ({ operation, argument }) => {
    const { useAuthStore } = await import('/src/stores/auth.store.ts')
    const auth = useAuthStore()
    if (operation === 'state') return JSON.parse(JSON.stringify(auth.$state))
    return auth[operation](argument)
  }, { operation, argument })
}
async function ready(page, path = '/') {
  await page.goto(`${origin}${path}`)
  await page.evaluate(async () => {
    const { useAuthStore } = await import('/src/stores/auth.store.ts')
    window.__authForTest = useAuthStore()
  })
  await page.waitForFunction(() => window.__authForTest.initialized && !window.__authForTest.loading)
  await page.locator('main').waitFor()
}
async function login(page) {
  await ready(page, '/iniciar-sesion')
  await page.getByLabel('Correo electrónico', { exact: true }).fill(credentials.email)
  await page.getByLabel('Contraseña', { exact: true }).fill(credentials.password)
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click()
  await page.waitForURL(url => url.pathname === '/perfil')
  await page.getByRole('heading', { name: 'Mi perfil' }).waitFor()
}
async function fillRegister(page) {
  await page.getByLabel('Nombre', { exact: true }).fill(user.name)
  await page.getByLabel('Correo electrónico', { exact: true }).fill(user.email)
  await page.getByLabel('Contraseña', { exact: true }).fill(credentials.password)
  await page.getByLabel('Confirmar contraseña', { exact: true }).fill(credentials.password)
}

test('registro real: campos vacíos, confirmación, envío único, contrato y redirección sin login automático', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { page, calls } = await setup(t, { register: async () => { await gate; return { status: 201, body: success(user) } } })
  await ready(page, '/registro')
  await page.getByRole('button', { name: 'Crear cuenta', exact: true }).click()
  assert.equal(await page.locator('[aria-invalid="true"]').count(), 4)
  assert.equal(calls.filter(c => c.action === 'register').length, 0)
  await fillRegister(page)
  await page.getByLabel('Confirmar contraseña').fill('otra contraseña')
  await page.getByRole('button', { name: 'Crear cuenta', exact: true }).click()
  await page.getByText('Las contraseñas no coinciden.').waitFor()
  await page.getByLabel('Confirmar contraseña').fill(credentials.password)
  await page.getByRole('button', { name: 'Crear cuenta', exact: true }).click()
  assert.equal(await page.getByRole('button', { name: 'Creando cuenta…' }).isDisabled(), true)
  await page.locator('form').dispatchEvent('submit')
  release()
  await page.waitForURL('**/iniciar-sesion')
  await page.getByText('Tu cuenta fue creada. Inicia sesión para continuar.').waitFor()
  const registrations = calls.filter(c => c.action === 'register')
  assert.equal(registrations.length, 1)
  assert.deepEqual(registrations[0].body, { name: user.name, ...credentials })
  assert.equal(calls.filter(c => c.action === 'login').length, 0)
  assert.equal((await store(page, 'state')).accessToken, null)
})

for (const [label, reply, message] of [
  ['409', { status: 409 }, 'Ya existe una cuenta con ese correo electrónico.'],
  ['red', { abort: true }, 'No se pudo conectar con el servidor.'],
  ['500', { status: 500 }, 'El servicio no está disponible'],
]) {
  test(`registro maneja ${label} y conserva campos`, async t => {
    const { page, calls } = await setup(t, { register: () => reply })
    await ready(page, '/registro')
    await fillRegister(page)
    await page.getByRole('button', { name: 'Crear cuenta', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: message }).waitFor()
    assert.equal(await page.getByLabel('Contraseña', { exact: true }).inputValue(), credentials.password)
    assert.equal(await page.getByLabel('Nombre', { exact: true }).inputValue(), user.name)
    assert.equal(calls.filter(c => c.action === 'register').length, 1)
    assert.ok(!(await page.locator('body').innerText()).includes('INTERNAL_TRACE'))
  })
}

test('login, perfil y JWT solo en memoria; contraseña ausente del estado y cookie HttpOnly', async t => {
  const { page, context, calls } = await setup(t)
  await context.addInitScript(() => {
    Storage.prototype.setItem = () => { throw new Error('No se permite persistir autenticación') }
    indexedDB.open = () => { throw new Error('No se permite persistir autenticación') }
  })
  await login(page)
  await page.getByText(user.name, { exact: true }).waitFor()
  await page.getByText(user.email, { exact: true }).waitFor()
  await page.getByText('1 de octubre de 2026').waitFor()
  const state = await store(page, 'state')
  assert.equal(state.accessToken, 'access-login')
  assert.equal(state.status, 'authenticated')
  assert.ok(!JSON.stringify(state).includes(credentials.password))
  assert.ok(!Object.keys(state).some(key => /password|refreshToken|confirmation/i.test(key)))
  assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length, document.cookie]), [0, 0, ''])
  assert.equal((await context.cookies()).find(c => c.name === 'bitlearn_refresh').httpOnly, true)
  assert.equal(calls.find(c => c.action === 'me').headers.authorization, 'Bearer access-login')
  assert.deepEqual(calls.find(c => c.action === 'login').body, credentials)
  assert.equal(new URL(page.url()).search, '')
})

for (const [status, message] of [[401, 'Correo o contraseña incorrectos.'], [429, 'Demasiados intentos.'], [400, 'No se pudo aceptar la solicitud.']]) {
  test(`login controla HTTP ${status} sin renovar ni revelar detalles`, async t => {
    const { page, calls } = await setup(t, { login: () => ({ status }) })
    await ready(page, '/iniciar-sesion')
    const refreshes = calls.filter(c => c.action === 'refresh').length
    await page.getByLabel('Correo electrónico', { exact: true }).fill(credentials.email)
    await page.getByLabel('Contraseña', { exact: true }).fill(credentials.password)
    await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: message }).waitFor()
    assert.equal(calls.filter(c => c.action === 'refresh').length, refreshes)
    assert.equal((await store(page, 'state')).accessToken, null)
  })
}

test('login controla error de red y mantiene la contraseña local para reintentar', async t => {
  const { page } = await setup(t, { login: () => ({ abort: true }) })
  await ready(page, '/iniciar-sesion')
  await page.getByLabel('Correo electrónico', { exact: true }).fill(credentials.email)
  await page.getByLabel('Contraseña', { exact: true }).fill(credentials.password)
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click()
  await page.getByRole('alert').filter({ hasText: 'No se pudo conectar' }).waitFor()
  assert.equal(await page.getByLabel('Contraseña', { exact: true }).inputValue(), credentials.password)
})

test('recarga del perfil recupera sesión con refresh y consulta /me', async t => {
  const { page, calls } = await setup(t)
  await login(page)
  calls.length = 0
  await page.reload()
  await page.getByRole('heading', { name: 'Mi perfil' }).waitFor()
  assert.deepEqual(calls.map(c => c.action), ['refresh', 'me'])
  assert.equal(calls[0].body, null)
  assert.ok(calls[0].headers.cookie.includes('bitlearn_refresh=initial'))
  assert.equal((await store(page, 'state')).accessToken, 'access-refresh-1')
})

test('401 protegido renueva y repite GET una sola vez; refresh single-flight', async t => {
  const { page, calls, handlers } = await setup(t)
  await login(page)
  calls.length = 0
  handlers.me = call => call.headers.authorization === 'Bearer access-login' ? { status: 401 } : { body: success(user) }
  assert.equal(await store(page, 'fetchProfile'), true)
  assert.deepEqual(calls.map(c => c.action), ['me', 'refresh', 'me'])
  calls.length = 0
  const results = await page.evaluate(async () => {
    const { useAuthStore } = await import('/src/stores/auth.store.ts')
    const auth = useAuthStore()
    const rejected = auth.accessToken
    return Promise.all([auth.refreshSession(rejected), auth.refreshSession(rejected), auth.refreshSession(rejected)])
  })
  assert.equal(new Set(results).size, 1)
  assert.equal(calls.filter(c => c.action === 'refresh').length, 1)
})

test('sesión rechazada y segundo 401 no generan bucles y limpian Pinia', async t => {
  const { page, calls, handlers } = await setup(t)
  await login(page)
  calls.length = 0
  handlers.me = () => ({ status: 401 })
  await store(page, 'fetchProfile')
  await page.waitForURL(url => url.pathname === '/iniciar-sesion' && url.searchParams.get('redirect') === '/perfil')
  assert.deepEqual(calls.map(c => c.action), ['me', 'refresh', 'me'])
  const state = await store(page, 'state')
  assert.equal(state.user, null)
  assert.equal(state.accessToken, null)
  assert.equal(state.status, 'anonymous')
  await page.getByRole('link', { name: 'Crear una cuenta' }).click()
  assert.equal(calls.filter(c => c.action === 'refresh').length, 1)
})

test('refresh inválido tras expirar: un intento, sin reintentar /me', async t => {
  const { page, calls, handlers } = await setup(t)
  await login(page)
  calls.length = 0
  handlers.me = () => ({ status: 401 })
  handlers.refresh = () => ({ status: 401 })
  assert.equal(await store(page, 'fetchProfile'), false)
  assert.deepEqual(calls.map(c => c.action), ['me', 'refresh'])
  assert.equal((await store(page, 'state')).accessToken, null)
})

test('logout confirma servidor, elimina cookie, limpia estado y redirige', async t => {
  const { page, context, calls } = await setup(t)
  await login(page)
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click()
  await page.waitForURL(`${origin}/`)
  await page.getByText('Sesión cerrada correctamente.').waitFor()
  assert.equal((await store(page, 'state')).accessToken, null)
  assert.equal((await store(page, 'state')).user, null)
  assert.equal(calls.filter(c => c.action === 'logout').length, 1)
  assert.equal((await context.cookies()).filter(c => c.name === 'bitlearn_refresh').length, 0)
})

test('logout fallido avisa que no confirmó revocación, permite reintento y no restaura automáticamente', async t => {
  const { page, calls, handlers } = await setup(t, { logout: () => ({ abort: true }) })
  await login(page)
  const refreshes = calls.filter(c => c.action === 'refresh').length
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click()
  await page.waitForURL(`${origin}/`)
  await page.getByText(/no se pudo confirmar la revocación remota/).waitFor()
  assert.equal((await store(page, 'state')).accessToken, null)
  assert.equal(calls.filter(c => c.action === 'refresh').length, refreshes)
  handlers.logout = () => ({ body: { success: true, message: 'ok' }, cookie: '' })
  await page.getByRole('button', { name: 'Reintentar cierre de sesión' }).click()
  await page.getByText('Sesión cerrada correctamente.').waitFor()
})

test('guards esperan refresh antes de mostrar perfil y conservan destino seguro', async t => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const { page, calls } = await setup(t, { refresh: async () => { await gate; return { status: 401 } } })
  await page.goto(`${origin}/perfil`)
  await page.getByText('Comprobando sesión…').waitFor()
  assert.equal(await page.getByRole('heading', { name: 'Mi perfil' }).count(), 0)
  release()
  await page.waitForURL(url => url.pathname === '/iniciar-sesion' && url.searchParams.get('redirect') === '/perfil')
  assert.equal(calls.filter(c => c.action === 'refresh').length, 1)
  await page.getByRole('link', { name: 'Regresar al inicio' }).click()
  await page.getByRole('heading', { name: 'BitLearn', exact: true }).waitFor()
})

test('error temporal de restauración permite reintento explícito sin asumir sesión expirada', async t => {
  const { page, handlers, calls } = await setup(t, { refresh: () => ({ abort: true }) })
  await ready(page, '/perfil')
  assert.equal((await store(page, 'state')).status, 'unavailable')
  assert.equal(calls.filter(c => c.action === 'refresh').length, 1)
  handlers.refresh = () => ({ body: success(token('recovered')) })
  await page.getByRole('button', { name: 'Reintentar sesión' }).click()
  await page.waitForURL(url => url.pathname === '/perfil')
  assert.equal((await store(page, 'state')).status, 'authenticated')
})

test('invitados autenticados vuelven al perfil y se rechazan redirecciones externas', async t => {
  const { page } = await setup(t)
  await ready(page, '/iniciar-sesion?redirect=https://evil.example')
  await page.getByLabel('Correo electrónico', { exact: true }).fill(credentials.email)
  await page.getByLabel('Contraseña', { exact: true }).fill(credentials.password)
  await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click()
  await page.waitForURL(url => url.pathname === '/perfil')
  await page.goto(`${origin}/registro`)
  await page.waitForURL(url => url.pathname === '/perfil')
  const destinations = await page.evaluate(async () => {
    const { loginDestination } = await import('/src/router/auth.guard.ts')
    return ['//evil.example', 'javascript:alert(1)', '/\\evil.example', '/perfil?token=secret', ['/perfil'], null, '/perfil'].map(loginDestination)
  })
  assert.deepEqual(destinations, Array(7).fill('/perfil'))
})

test('bienvenida conserva contenido, estado de salud y reintento; diseño móvil sin desbordes', async t => {
  const { page, handlers } = await setup(t, { health: () => ({ status: 503, body: { status: 'unavailable', database: 'disconnected' } }) })
  await page.setViewportSize({ width: 360, height: 800 })
  await ready(page)
  for (const text of ['Aprende código, domina tu futuro.', 'Aprender hoy. Recordar mañana.', 'API disponible · PostgreSQL desconectado']) await page.getByText(text, { exact: true }).waitFor()
  await page.getByText(/BitLearn utilizará repetición espaciada SM-2/).waitFor()
  handlers.health = () => ({ body: { status: 'ok', database: 'connected' } })
  await page.getByRole('button', { name: 'Reintentar conexión' }).click()
  await page.getByText('API operativa · PostgreSQL conectado').waitFor()
  assert.equal(await page.getByRole('button', { name: 'Reintentar conexión' }).count(), 0)
  for (const path of ['/registro', '/iniciar-sesion']) {
    await ready(page, path)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    const input = page.getByLabel('Contraseña', { exact: true })
    assert.equal(await input.getAttribute('autocomplete'), path === '/registro' ? 'new-password' : 'current-password')
    await input.focus()
    assert.notEqual(await input.evaluate(el => getComputedStyle(el).outlineStyle), 'none')
  }
})

test('dos pestañas comparten renovación y una pestaña nueva recupera JWT del par bajo bloqueo', async t => {
  const { page, context, state, calls } = await setup(t)
  state.session = true
  const second = await context.newPage()
  await Promise.all([ready(page, '/perfil'), ready(second, '/perfil')])
  assert.equal(calls.filter(c => c.action === 'refresh').length, 1)
  assert.equal(calls.filter(c => c.action === 'me').length, 2)
  assert.equal((await store(page, 'state')).accessToken, (await store(second, 'state')).accessToken)
  const third = await context.newPage()
  await ready(third, '/perfil')
  assert.equal(calls.filter(c => c.action === 'refresh').length, 1)
  await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click()
  await second.waitForURL(url => url.pathname === '/iniciar-sesion' && url.searchParams.get('redirect') === '/perfil')
  await third.waitForURL(url => url.pathname === '/iniciar-sesion' && url.searchParams.get('redirect') === '/perfil')
  assert.equal((await store(second, 'state')).accessToken, null)
  assert.equal((await store(third, 'state')).user, null)
})

test('refresh tardío después de logout no resucita la sesión', async t => {
  let release
  let started
  const gate = new Promise(resolve => { release = resolve })
  const entered = new Promise(resolve => { started = resolve })
  const { page, handlers } = await setup(t)
  await login(page)
  handlers.refresh = async () => { started(); await gate; return { body: success(token('late-token')) } }
  const refreshing = page.evaluate(async () => {
    const { useAuthStore } = await import('/src/stores/auth.store.ts')
    const auth = useAuthStore()
    try { await auth.refreshSession(auth.accessToken) } catch { /* invalidado */ }
  })
  await entered
  const closing = store(page, 'logout')
  await page.waitForFunction(() => window.__authForTest.accessToken === null)
  release()
  await Promise.all([refreshing, closing])
  const state = await store(page, 'state')
  assert.equal(state.accessToken, null)
  assert.equal(state.status, 'anonymous')
})

test('dos 401 simultáneos en pestañas distintas comparten un único refresh', async t => {
  const { page, context, state, calls, handlers } = await setup(t)
  state.session = true
  const second = await context.newPage()
  await Promise.all([ready(page, '/perfil'), ready(second, '/perfil')])
  const previous = (await store(page, 'state')).accessToken
  calls.length = 0
  handlers.me = call => call.headers.authorization === `Bearer ${previous}` ? { status: 401 } : { body: success(user) }
  assert.deepEqual(await Promise.all([store(page, 'fetchProfile'), store(second, 'fetchProfile')]), [true, true])
  assert.equal(calls.filter(c => c.action === 'refresh').length, 1)
  assert.equal(calls.filter(c => c.action === 'me').length, 4)
  assert.equal((await store(page, 'state')).accessToken, (await store(second, 'state')).accessToken)
})

test('perfil controla error recuperable y agrupa consultas simultáneas', async t => {
  const { page, handlers, calls } = await setup(t)
  await login(page)
  handlers.me = () => ({ status: 500 })
  assert.equal(await store(page, 'fetchProfile'), false)
  await page.getByRole('alert').filter({ hasText: 'El servicio no está disponible' }).waitFor()
  assert.equal(await page.getByText(user.email, { exact: true }).count(), 0)
  handlers.me = () => ({ body: success(user) })
  await page.getByRole('button', { name: 'Reintentar perfil' }).click()
  await page.getByText(user.email, { exact: true }).waitFor()
  calls.length = 0
  const result = await page.evaluate(async () => {
    const { useAuthStore } = await import('/src/stores/auth.store.ts')
    const auth = useAuthStore()
    return Promise.all([auth.fetchProfile(), auth.fetchProfile(), auth.fetchProfile()])
  })
  assert.deepEqual(result, [true, true, true])
  assert.deepEqual(calls.map(c => c.action), ['me'])
})

test('registro y login anónimos no muestran error por la ausencia normal de cookie', async t => {
  const { page, calls } = await setup(t)
  await ready(page, '/registro')
  assert.equal(await page.getByRole('alert').count(), 0)
  await page.getByRole('link', { name: 'Ya tengo una cuenta' }).click()
  await page.getByRole('heading', { name: 'Inicia sesión' }).waitFor()
  assert.equal(await page.getByRole('alert').count(), 0)
  assert.equal(calls.filter(c => c.action === 'refresh').length, 1)
})

test('sin Web Locks/BroadcastChannel mantiene single-flight y rechazo seguro', async t => {
  const { context, page, state, calls } = await setup(t)
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'locks', { value: undefined })
    Object.defineProperty(window, 'BroadcastChannel', { value: undefined })
  })
  state.session = true
  await ready(page, '/perfil')
  calls.length = 0
  await page.evaluate(async () => {
    const { useAuthStore } = await import('/src/stores/auth.store.ts')
    const auth = useAuthStore()
    await Promise.all([auth.refreshSession(auth.accessToken), auth.refreshSession(auth.accessToken)])
  })
  assert.equal(calls.filter(c => c.action === 'refresh').length, 1)
})

for (const [label, reply] of [
  ['JSON inválido', { raw: '<html>internal trace</html>', contentType: 'text/html' }],
  ['usuario mal formado', { body: success({ user: { id: '1' }, ...token('bad') }) }],
  ['token ausente', { body: success({ user, expiresIn: 900 }) }],
  ['success falso', { body: { success: false, data: { user, ...token('bad') } } }],
]) {
  test(`respuesta de login inválida: ${label}`, async t => {
    const { page } = await setup(t, { login: () => reply })
    await ready(page, '/iniciar-sesion')
    assert.equal(await store(page, 'login', credentials), false)
    assert.equal((await store(page, 'state')).accessToken, null)
    assert.equal((await store(page, 'state')).error.kind, 'response')
  })
}

test('cliente HTTP usa same-origin, no-store, timeout y no reenvía errores internos', async t => {
  const { page } = await setup(t)
  await ready(page)
  const result = await page.evaluate(async () => {
    const { authService } = await import('/src/services/auth.service.ts')
    const original = window.fetch
    let observed
    window.fetch = async (url, options) => {
      observed = { url, credentials: options.credentials, cache: options.cache, redirect: options.redirect, hasSignal: options.signal instanceof AbortSignal, headers: options.headers }
      return Response.json({ success: true, data: { id: 1, name: 'Juan', email: 'juan@example.com', password_hash: 'never-copy', session: 'private' } })
    }
    try { return { observed: (await authService.me('access-test'), observed), user: (await authService.me('access-test')).data } }
    finally { window.fetch = original }
  })
  assert.deepEqual(result.observed, { url: '/api/auth/me', credentials: 'same-origin', cache: 'no-store', redirect: 'error', hasSignal: true, headers: { Accept: 'application/json', Authorization: 'Bearer access-test' } })
  assert.deepEqual(Object.keys(result.user).sort(), ['email', 'id', 'name'])
})
