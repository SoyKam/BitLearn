export interface PublicUser {
  id: number
  name: string
  email: string
  created_at?: string
}

export interface LoginInput { email: string; password: string }
export interface RegisterInput extends LoginInput { name: string }
export interface RegisterForm extends RegisterInput { confirmation: string }
export interface TokenData { accessToken: string; expiresIn: number }
export interface LoginData extends TokenData { user: PublicUser }
export interface ApiSuccess<T> { success: true; data: T }
export interface LogoutResponse { success: true; message: string }
export type AuthStatus = 'unchecked' | 'authenticated' | 'anonymous' | 'unavailable'
export type ErrorKind = 'validation' | 'authentication' | 'conflict' | 'rate-limit' | 'connection' | 'server' | 'response'
export interface AuthError { kind: ErrorKind; message: string; status: number | null }
export type FieldErrors = Partial<Record<keyof RegisterForm, string>>
