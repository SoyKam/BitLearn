import type { ApiSuccess, LoginData, LoginInput, LogoutResponse, PublicUser, RegisterInput, TokenData } from '../types/auth'
import { invalidResponse, isRecord, request } from './http.service'

function dataOf(value: unknown): Record<string, unknown> {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)) return invalidResponse()
  return value.data
}

function publicUser(value: unknown): PublicUser {
  if (!isRecord(value) || !Number.isSafeInteger(value.id) || typeof value.id !== 'number' || value.id < 1
    || typeof value.name !== 'string' || !value.name.trim() || typeof value.email !== 'string' || !value.email.trim()
    || (value.created_at !== undefined && (typeof value.created_at !== 'string' || !Number.isFinite(Date.parse(value.created_at))))) return invalidResponse()
  // Proyectar solo campos públicos, incluso si el servidor envía propiedades extra.
  return { id: value.id, name: value.name, email: value.email,
    ...(typeof value.created_at === 'string' ? { created_at: value.created_at } : {}) }
}

function tokenData(value: Record<string, unknown>): TokenData {
  if (typeof value.accessToken !== 'string' || !value.accessToken.trim()
    || typeof value.expiresIn !== 'number' || !Number.isInteger(value.expiresIn) || value.expiresIn <= 0 || value.expiresIn > 900) return invalidResponse()
  return { accessToken: value.accessToken, expiresIn: value.expiresIn }
}

export const authService = {
  register(input: RegisterInput): Promise<ApiSuccess<PublicUser>> {
    return request('/api/auth/register', value => ({ success: true, data: publicUser(dataOf(value)) }), {
      method: 'POST', body: { name: input.name.trim(), email: input.email.trim().toLowerCase(), password: input.password },
    })
  },
  login(input: LoginInput): Promise<ApiSuccess<LoginData>> {
    return request('/api/auth/login', value => {
      const data = dataOf(value)
      return { success: true, data: { ...tokenData(data), user: publicUser(data.user) } }
    }, { method: 'POST', body: { email: input.email.trim().toLowerCase(), password: input.password } })
  },
  refresh(): Promise<ApiSuccess<TokenData>> {
    return request('/api/auth/refresh', value => ({ success: true, data: tokenData(dataOf(value)) }), { method: 'POST' })
  },
  me(accessToken: string): Promise<ApiSuccess<PublicUser>> {
    return request('/api/auth/me', value => ({ success: true, data: publicUser(dataOf(value)) }), { accessToken })
  },
  logout(): Promise<LogoutResponse> {
    return request('/api/auth/logout', value => {
      if (!isRecord(value) || value.success !== true || typeof value.message !== 'string') return invalidResponse()
      return { success: true, message: 'Sesión cerrada correctamente.' }
    }, { method: 'POST' })
  },
}
