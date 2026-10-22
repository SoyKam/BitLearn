import type { AuthError, ErrorKind } from '../types/auth'

export class HttpError extends Error implements AuthError {
  constructor(public readonly kind: ErrorKind, message: string, public readonly status: number | null = null) {
    super(message)
    this.name = 'HttpError'
  }
}

function statusError(status: number): HttpError {
  switch (status) {
    case 400: return new HttpError('validation', 'No se pudo aceptar la solicitud. Revisa los datos; si persiste, comprueba el origen configurado del frontend.', status)
    case 401: return new HttpError('authentication', 'La sesión ya no es válida. Inicia sesión de nuevo.', status)
    case 409: return new HttpError('conflict', 'Ya existe una cuenta con ese correo electrónico.', status)
    case 429: return new HttpError('rate-limit', 'Demasiados intentos. Espera unos minutos antes de volver a intentarlo.', status)
    default: return new HttpError('server', 'El servicio no está disponible en este momento. Inténtalo más tarde.', status)
  }
}

export function controlledError(error: unknown): AuthError {
  if (error instanceof HttpError) return { kind: error.kind, message: error.message, status: error.status }
  return { kind: 'connection', message: 'No se pudo conectar con el servidor. Comprueba tu conexión e inténtalo de nuevo.', status: null }
}

export function invalidResponse(): never {
  throw new HttpError('response', 'El servidor devolvió una respuesta inesperada. Inténtalo de nuevo.')
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

interface RequestOptions {
  method?: 'GET' | 'POST'
  body?: unknown
  accessToken?: string
}

// La conversión recibe unknown: un tipo genérico por sí solo no valida JSON.
export async function request<T>(path: `/api/${string}`, decode: (value: unknown) => T, options: RequestOptions = {}): Promise<T> {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8000)
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (options.body !== undefined) headers['Content-Type'] = 'application/json'
  if (options.accessToken) headers.Authorization = `Bearer ${options.accessToken}`
  try {
    const response = await fetch(path, {
      method: options.method ?? 'GET', headers,
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
      credentials: 'same-origin', cache: 'no-store', redirect: 'error', signal: controller.signal,
    })
    // No reflejar mensajes arbitrarios, trazas ni cuerpos de error del servidor.
    if (!response.ok) throw statusError(response.status)
    let data: unknown
    try { data = await response.json() } catch {
      if (controller.signal.aborted) throw new HttpError('connection', 'La solicitud tardó demasiado. Inténtalo de nuevo.')
      return invalidResponse()
    }
    return decode(data)
  } catch (error) {
    if (error instanceof HttpError) throw error
    throw new HttpError('connection', 'No se pudo conectar con el servidor. Comprueba tu conexión e inténtalo de nuevo.')
  } finally {
    clearTimeout(timeout)
  }
}
