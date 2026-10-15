import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import ts from 'typescript'

// Usar el compilador existente para probar el servicio sin añadir dependencias.
const source = await readFile(new URL('../src/services/health.service.ts', import.meta.url), 'utf8')
const { outputText } = ts.transpileModule(source, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
})
const { checkHealth } = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`)

const connected = { status: 'ok', database: 'connected' }
const disconnected = { status: 'unavailable', database: 'disconnected' }

for (const [name, status, body, expected] of [
  ['200 válido', 200, connected, 'connected'],
  ['503 válido', 503, disconnected, 'database-unavailable'],
  ['200 con cuerpo de 503', 200, disconnected, 'connection-error'],
  ['503 con cuerpo de 200', 503, connected, 'connection-error'],
  ['500 inesperado', 500, connected, 'connection-error'],
  ['objeto incompleto', 200, { status: 'ok' }, 'connection-error'],
  ['valores inesperados', 503, { status: 'error', database: false }, 'connection-error'],
  ['JSON nulo', 200, null, 'connection-error'],
  ['JSON array', 200, [], 'connection-error'],
  ['JSON primitivo', 200, 'ok', 'connection-error'],
]) {
  test(name, async (t) => {
    const request = t.mock.method(globalThis, 'fetch', async (url, options) => {
      assert.equal(url, '/api/health')
      assert.equal(options.cache, 'no-store')
      assert.ok(options.signal instanceof AbortSignal)
      return Response.json(body, { status })
    })
    assert.equal(await checkHealth(), expected)
    assert.equal(request.mock.callCount(), 1)
  })
}

test('JSON inválido termina con error de conexión', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('<html>Error</html>'))
  assert.equal(await checkHealth(), 'connection-error')
})

test('fallo de red sin reintentos automáticos y recuperación en una nueva consulta', async (t) => {
  const request = t.mock.method(globalThis, 'fetch', async () => {
    throw new TypeError('Failed to fetch')
  })
  assert.equal(await checkHealth(), 'connection-error')
  assert.equal(request.mock.callCount(), 1)
  request.mock.mockImplementation(async () => Response.json(connected))
  assert.equal(await checkHealth(), 'connected')
  assert.equal(request.mock.callCount(), 2)
})

for (const waitingForBody of [false, true]) {
  test(`cancela a los 8 segundos esperando ${waitingForBody ? 'el JSON' : 'la respuesta'}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    let signal
    t.mock.method(globalThis, 'fetch', async (_url, options) => {
      signal = options.signal
      const pending = new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      return waitingForBody ? { status: 200, json: () => pending } : pending
    })
    const result = checkHealth()
    await Promise.resolve()
    t.mock.timers.tick(7999)
    assert.equal(signal.aborted, false)
    t.mock.timers.tick(1)
    assert.equal(await result, 'connection-error')
    assert.equal(signal.aborted, true)
  })
}

test('libera el temporizador después de recibir una respuesta', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal
  t.mock.method(globalThis, 'fetch', async (_url, options) => {
    signal = options.signal
    return Response.json(connected)
  })
  assert.equal(await checkHealth(), 'connected')
  t.mock.timers.tick(8000)
  assert.equal(signal.aborted, false)
})
