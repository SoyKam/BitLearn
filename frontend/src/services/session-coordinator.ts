import { HttpError, isRecord } from './http.service'

export interface TokenSnapshot { accessToken: string; expiresAt: number }
type SessionEvent = 'signed-out' | 'changed'
interface Callbacks {
  snapshot: () => TokenSnapshot | null
  invalidate: (event: SessionEvent) => void
}
interface Environment {
  locks: Pick<LockManager, 'request'> | undefined
  channel: BroadcastChannel | null
}

function browserEnvironment(): Environment {
  if (typeof window === 'undefined') return { locks: undefined, channel: null }
  let channel: BroadcastChannel | null = null
  try {
    if (typeof BroadcastChannel !== 'undefined') channel = new BroadcastChannel('bitlearn-session-v1')
  } catch { /* Navegadores que deshabilitan la comunicación entre pestañas. */ }
  return { locks: navigator.locks, channel }
}

export function createSessionCoordinator(callbacks: Callbacks, environment = browserEnvironment()) {
  const { locks, channel } = environment
  const pending = new Map<string, (value: TokenSnapshot | null) => void>()

  channel?.addEventListener('message', (event: MessageEvent<unknown>) => {
    const data = event.data
    if (!isRecord(data)) return
    if (data.type === 'signed-out' || data.type === 'changed') {
      callbacks.invalidate(data.type)
      return
    }
    if (data.type === 'request' && typeof data.id === 'string') {
      const snapshot = callbacks.snapshot()
      if (snapshot && snapshot.expiresAt > Date.now() + 5000 && snapshot.accessToken !== data.rejectedToken) {
        channel.postMessage({ type: 'token', id: data.id, ...snapshot })
      }
    }
    if (data.type === 'token' && typeof data.id === 'string' && typeof data.accessToken === 'string'
      && data.accessToken.length > 0 && typeof data.expiresAt === 'number'
      && data.expiresAt > Date.now() + 5000 && data.expiresAt <= Date.now() + 900000) {
      pending.get(data.id)?.({ accessToken: data.accessToken, expiresAt: data.expiresAt })
    }
  })

  return {
    // Login, refresh y logout comparten el bloqueo porque todos cambian la cookie.
    async exclusive<T>(operation: () => Promise<T>): Promise<T> {
      if (!locks) return operation()
      const controller = new AbortController()
      const timeout = setTimeout(() => controller.abort(), 12000)
      try {
        return await locks.request('bitlearn-auth-cookie-v1', { signal: controller.signal }, async () => {
          clearTimeout(timeout)
          return operation()
        })
      } catch (error) {
        if (controller.signal.aborted) throw new HttpError('connection', 'Otra pestaña está comprobando la sesión. Inténtalo de nuevo.')
        throw error
      } finally { clearTimeout(timeout) }
    },
    // Consultar a los pares DESPUÉS de adquirir el bloqueo evita perder un
    // broadcast anterior. El JWT solo viaja en memoria; la cookie nunca se lee.
    peerToken(rejectedToken: string | null): Promise<TokenSnapshot | null> {
      if (!locks || !channel) return Promise.resolve(null)
      return new Promise(resolve => {
        const id = crypto.randomUUID()
        const timeout = setTimeout(() => finish(null), 150)
        const finish = (value: TokenSnapshot | null) => {
          clearTimeout(timeout)
          pending.delete(id)
          resolve(value?.accessToken === rejectedToken ? null : value)
        }
        pending.set(id, finish)
        channel.postMessage({ type: 'request', id, rejectedToken })
      })
    },
    invalidate(event: SessionEvent) { channel?.postMessage({ type: event }) },
    close() {
      for (const finish of pending.values()) finish(null)
      channel?.close()
    },
  }
}
