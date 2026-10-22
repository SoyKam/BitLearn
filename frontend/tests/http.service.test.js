import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

const source = await readFile(new URL('../src/services/http.service.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
})
const { request, HttpError, isRecord, invalidResponse } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)
const decode = value => isRecord(value) && value.success === true ? value : invalidResponse()

for (const [status, kind] of [[400, 'validation'], [401, 'authentication'], [409, 'conflict'], [429, 'rate-limit'], [500, 'server']]) {
  test(`HTTP ${status}: error controlado, sin reflejar cuerpo ni reintentar`, async t => {
    const fetch = t.mock.method(globalThis, 'fetch', async () => Response.json({ message: 'INTERNAL_DATABASE_TRACE' }, { status }))
    await assert.rejects(request('/api/auth/login', decode, { method: 'POST' }), error => {
      assert.ok(error instanceof HttpError)
      assert.equal(error.kind, kind)
      assert.equal(error.status, status)
      assert.ok(!error.message.includes('INTERNAL_DATABASE_TRACE'))
      return true
    })
    assert.equal(fetch.mock.callCount(), 1)
  })
}

test('Fetch usa origen local, JSON, Bearer, no-store y bloquea redirecciones', async t => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, '/api/auth/me')
    assert.equal(options.credentials, 'same-origin')
    assert.equal(options.cache, 'no-store')
    assert.equal(options.redirect, 'error')
    assert.equal(options.headers.Authorization, 'Bearer fake-token')
    assert.equal(options.headers['Content-Type'], 'application/json')
    assert.equal(options.body, '{"test":true}')
    return Response.json({ success: true })
  })
  assert.deepEqual(await request('/api/auth/me', decode, { method: 'POST', body: { test: true }, accessToken: 'fake-token' }), { success: true })
})

test('red y JSON mal formado son errores diferentes', async t => {
  const fetch = t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('secret detail') })
  await assert.rejects(request('/api/auth/me', decode), { kind: 'connection' })
  fetch.mock.mockImplementation(async () => new Response('<html>trace</html>'))
  await assert.rejects(request('/api/auth/me', decode), { kind: 'response' })
  fetch.mock.mockImplementation(async () => Response.json(null))
  await assert.rejects(request('/api/auth/me', decode), { kind: 'response' })
})

for (const waitingForBody of [false, true]) {
  test(`HTTP cancela a 8 segundos esperando ${waitingForBody ? 'JSON' : 'cabeceras'} sin reintento`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let signal
    const fetch = t.mock.method(globalThis, 'fetch', async (_url, options) => {
      signal = options.signal
      const pending = new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }))
      return waitingForBody ? { ok: true, json: () => pending } : pending
    })
    const result = request('/api/auth/refresh', decode, { method: 'POST' })
    const rejected = assert.rejects(result, { kind: 'connection' })
    await Promise.resolve()
    t.mock.timers.tick(7999)
    assert.equal(signal.aborted, false)
    t.mock.timers.tick(1)
    await rejected
    assert.equal(signal.aborted, true)
    assert.equal(fetch.mock.callCount(), 1)
  })
}

test('HTTP libera el temporizador al terminar', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal
  t.mock.method(globalThis, 'fetch', async (_url, options) => { signal = options.signal; return Response.json({ success: true }) })
  await request('/api/auth/me', decode)
  t.mock.timers.tick(8000)
  assert.equal(signal.aborted, false)
})
