import { computed, onScopeDispose, ref } from 'vue'
import { defineStore } from 'pinia'
import type { AuthError, AuthStatus, LoginInput, PublicUser, RegisterInput } from '../types/auth'
import { authService } from '../services/auth.service'
import { controlledError, HttpError } from '../services/http.service'
import { createSessionCoordinator } from '../services/session-coordinator'

export const useAuthStore = defineStore('auth', () => {
  const user = ref<PublicUser | null>(null)
  const accessToken = ref<string | null>(null)
  const expiresAt = ref(0)
  const status = ref<AuthStatus>('unchecked')
  const initialized = ref(false)
  const error = ref<AuthError | null>(null)
  const notice = ref<string | null>(null)
  const logoutUnconfirmed = ref(false)
  const activeRequests = ref(0)
  const loading = computed(() => activeRequests.value > 0)
  const isAuthenticated = computed(() => status.value === 'authenticated' && !!accessToken.value && !!user.value)
  let generation = 0
  let mutationPending = false
  let refreshFlight: Promise<string> | null = null
  let profileFlight: Promise<boolean> | null = null
  let restoreFlight: Promise<boolean> | null = null

  const coordinator = createSessionCoordinator({
    snapshot: () => accessToken.value ? { accessToken: accessToken.value, expiresAt: expiresAt.value } : null,
    invalidate: event => {
      clearSession()
      if (event === 'changed') { status.value = 'unchecked'; initialized.value = false }
      notice.value = event === 'signed-out' ? 'La sesión se cerró en otra pestaña.' : 'La sesión cambió en otra pestaña. Vuelve a comprobarla.'
    },
  })
  onScopeDispose(() => coordinator.close())

  function clearSession() {
    generation++
    accessToken.value = null
    expiresAt.value = 0
    user.value = null
    status.value = 'anonymous'
    initialized.value = true
    error.value = null
  }

  function ensureCurrent(version: number) {
    if (version !== generation) throw new HttpError('authentication', 'La sesión cambió. Vuelve a iniciar sesión.', 401)
  }

  function sessionFailure(cause: unknown, version: number) {
    if (version !== generation) return
    const failure = controlledError(cause)
    if (failure.status === 401) {
      clearSession()
      coordinator.invalidate('signed-out')
    } else {
      user.value = null
      status.value = 'unavailable'
      initialized.value = true
    }
    error.value = failure
  }

  async function register(input: RegisterInput): Promise<boolean> {
    if (mutationPending) return false
    mutationPending = true
    activeRequests.value++
    error.value = null
    try {
      await authService.register(input)
      notice.value = 'Tu cuenta fue creada. Inicia sesión para continuar.'
      return true
    } catch (cause) { error.value = controlledError(cause); return false }
    finally { mutationPending = false; activeRequests.value-- }
  }

  async function login(input: LoginInput): Promise<boolean> {
    if (mutationPending) return false
    mutationPending = true
    clearSession()
    const version = generation
    activeRequests.value++
    notice.value = null
    logoutUnconfirmed.value = false
    try {
      return await coordinator.exclusive(async () => {
        ensureCurrent(version)
        const result = await authService.login(input)
        ensureCurrent(version)
        accessToken.value = result.data.accessToken
        expiresAt.value = Date.now() + result.data.expiresIn * 1000
        user.value = result.data.user
        status.value = 'authenticated'
        coordinator.invalidate('changed')
        return true
      })
    } catch (cause) {
      if (version === generation) {
        const failure = controlledError(cause)
        error.value = failure.status === 401 ? { ...failure, message: 'Correo o contraseña incorrectos.' } : failure
      }
      return false
    } finally { mutationPending = false; activeRequests.value-- }
  }

  function refreshSession(rejectedToken: string | null = null): Promise<string> {
    if (refreshFlight) return refreshFlight
    const version = generation
    activeRequests.value++
    refreshFlight = coordinator.exclusive(async () => {
      ensureCurrent(version)
      // Otra petición de esta pestaña puede haber renovado antes del 401 tardío.
      if (accessToken.value && accessToken.value !== rejectedToken && expiresAt.value > Date.now() + 5000) return accessToken.value
      const peer = await coordinator.peerToken(rejectedToken)
      ensureCurrent(version)
      if (peer) {
        accessToken.value = peer.accessToken
        expiresAt.value = peer.expiresAt
      } else {
        const result = await authService.refresh()
        ensureCurrent(version)
        accessToken.value = result.data.accessToken
        expiresAt.value = Date.now() + result.data.expiresIn * 1000
      }
      return accessToken.value
    }).catch(cause => {
      sessionFailure(cause, version)
      throw cause
    }).finally(() => { refreshFlight = null; activeRequests.value-- })
    return refreshFlight
  }

  function fetchProfile(): Promise<boolean> {
    if (profileFlight) return profileFlight
    const version = generation
    activeRequests.value++
    error.value = null
    profileFlight = (async () => {
      try {
        const hadToken = !!accessToken.value
        const token = accessToken.value ?? await refreshSession()
        ensureCurrent(version)
        let result
        try { result = await authService.me(token) } catch (cause) {
          // Solo GET /me puede repetirse, una vez; un token recién restaurado
          // rechazado no provoca una segunda renovación.
          if (!(cause instanceof HttpError) || cause.status !== 401 || !hadToken) throw cause
          const renewed = await refreshSession(token)
          ensureCurrent(version)
          result = await authService.me(renewed)
        }
        ensureCurrent(version)
        user.value = result.data
        status.value = 'authenticated'
        initialized.value = true
        return true
      } catch (cause) { sessionFailure(cause, version); return false }
      finally { profileFlight = null; activeRequests.value-- }
    })()
    return profileFlight
  }

  function restoreSession(retry = false): Promise<boolean> {
    if (restoreFlight) return restoreFlight
    if (initialized.value && !retry) return Promise.resolve(isAuthenticated.value)
    const firstCheck = !initialized.value
    restoreFlight = fetchProfile().then(restored => {
      // No tener cookie al visitar la aplicación por primera vez es normal.
      if (!restored && firstCheck && error.value?.status === 401) error.value = null
      return restored
    }).finally(() => { restoreFlight = null })
    return restoreFlight
  }

  async function logout(): Promise<boolean> {
    if (mutationPending) return false
    mutationPending = true
    clearSession() // Impedir que respuestas anteriores vuelvan a abrir la interfaz.
    activeRequests.value++
    notice.value = null
    try {
      await coordinator.exclusive(async () => {
        coordinator.invalidate('signed-out')
        await authService.logout()
      })
      notice.value = 'Sesión cerrada correctamente.'
      logoutUnconfirmed.value = false
      return true
    } catch {
      logoutUnconfirmed.value = true
      notice.value = 'Se cerró la sesión en esta pestaña, pero no se pudo confirmar la revocación remota. Reintenta el cierre de sesión.'
      return false
    } finally { mutationPending = false; activeRequests.value-- }
  }

  return { user, accessToken, expiresAt, status, initialized, error, notice, logoutUnconfirmed, activeRequests, loading, isAuthenticated,
    register, login, refreshSession, restoreSession, fetchProfile, logout, clearSession }
})
