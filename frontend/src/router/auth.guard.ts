import type { NavigationGuard } from 'vue-router'
import { useAuthStore } from '../stores/auth.store'

declare module 'vue-router' {
  interface RouteMeta { requiresAuth?: boolean; guestOnly?: boolean }
}

// Lista cerrada de destinos: no aceptar URLs externas, esquemas ni rutas arbitrarias.
export function loginDestination(value: unknown): string {
  if (value === '/perfil' || value === '/mi-progreso') return value
  if (typeof value === 'string' && /^\/lecciones\/[0-9]{1,10}$/.test(value) && !/\s/u.test(value)) {
    const id = Number(value.slice('/lecciones/'.length))
    if (id > 0 && id <= 2147483647) return `/lecciones/${id}`
  }
  return '/perfil'
}

export const authGuard: NavigationGuard = async to => {
  if (!to.meta.requiresAuth && !to.meta.guestOnly) return true
  const auth = useAuthStore()
  const knownSession = auth.isAuthenticated
  await auth.restoreSession()
  // Al volver al perfil se comprueba también la vigencia real en el backend.
  if (to.meta.requiresAuth && knownSession) await auth.fetchProfile()
  if (to.meta.requiresAuth && !auth.isAuthenticated) {
    return { name: 'login', query: { redirect: loginDestination(to.path) }, replace: true }
  }
  if (to.meta.guestOnly && auth.isAuthenticated) return { path: loginDestination(to.query.redirect), replace: true }
  return true
}
