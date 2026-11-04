import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import { useAuthStore } from './auth.store'
import { dashboardService, type Dashboard, type Retention } from '../services/dashboard.service'
import { HttpError } from '../services/http.service'
export const useDashboardStore = defineStore('dashboard', () => {
  const auth = useAuthStore()
  const statistics = ref<Dashboard | null>(null)
  const retention = ref<Retention | null>(null)
  const ownerId = ref<number | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const isEmpty = computed(() => retention.value?.modeledCards === 0)
  let generation = 0
  function clearDashboard() {
    generation++
    statistics.value = null; retention.value = null; ownerId.value = null
    loading.value = false; error.value = null
  }
  watch(() => auth.isAuthenticated ? auth.user?.id : null, clearDashboard, { flush: 'sync' })
  async function loadDashboard() {
    if (!auth.isAuthenticated || loading.value) return
    clearDashboard()
    const version = generation
    const id = auth.user?.id
    const valid = () => version === generation && auth.isAuthenticated && auth.user?.id === id
    ownerId.value = id ?? null; loading.value = true
    async function get<T>(query: (token: string) => Promise<T>): Promise<T | undefined> {
      let token = auth.accessToken ?? ''
      if (auth.expiresAt <= Date.now() + 5000) token = await auth.refreshSession()
      if (!valid()) return
      try { return await query(token) } catch (cause) {
        if (!valid()) return
        if (!(cause instanceof HttpError) || cause.status !== 401) throw cause
        token = await auth.refreshSession(token)
        if (valid()) return query(token)
      }
    }
    try {
      const [stats, projection] = await Promise.all([get(dashboardService.getDashboard), get(dashboardService.getRetention)])
      if (valid() && stats && projection) { statistics.value = stats; retention.value = projection }
    } catch (cause) {
      if (valid()) error.value = cause instanceof HttpError && cause.status === 401
        ? 'La sesión ya no es válida. Inicia sesión de nuevo.'
        : 'No se pudo cargar el dashboard. Comprueba tu conexión o inténtalo más tarde.'
    } finally { if (valid()) loading.value = false }
  }
  return { statistics, retention, ownerId, loading, error, isEmpty, clearDashboard, loadDashboard, reloadDashboard: loadDashboard }
})
