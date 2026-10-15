export type HealthStatus = 'connected' | 'database-unavailable' | 'connection-error'

export async function checkHealth(): Promise<HealthStatus> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)

  try {
    const response = await fetch('/api/health', {
      signal: controller.signal,
      cache: 'no-store',
    })
    const data: unknown = await response.json()

    // Validar el JSON recibido antes de interpretar el estado del servicio.
    if (typeof data !== 'object' || data === null ||
        !('status' in data) || !('database' in data)) {
      return 'connection-error'
    }

    if (response.status === 200 && data.status === 'ok' && data.database === 'connected') {
      return 'connected'
    }

    if (response.status === 503 && data.status === 'unavailable' && data.database === 'disconnected') {
      return 'database-unavailable'
    }

    return 'connection-error'
  } catch {
    // Incluye fallos de red, JSON inválido y el vencimiento del tiempo de espera.
    return 'connection-error'
  } finally {
    clearTimeout(timeout)
  }
}
