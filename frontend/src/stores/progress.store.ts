import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { AuthError } from '../types/auth'
import type { ProgressLesson } from '../types/progress'
import { controlledError, HttpError } from '../services/http.service'
import { progressService } from '../services/progress.service'
import { useAuthStore } from './auth.store'

export const useProgressStore = defineStore('progress', () => {
  const auth = useAuthStore()
  const ownerId = ref<number | null>(null)
  const collection = ref<{ byId: Record<number, ProgressLesson>; allIds: number[] }>({ byId: {}, allIds: [] })
  const completedLessons = ref(0)
  const totalLessons = ref(0)
  const loading = ref(false)
  const loaded = ref(false)
  const error = ref<AuthError | null>(null)
  const lessons = computed(() => collection.value.allIds.flatMap(id => collection.value.byId[id] ?? []))
  const isEmpty = computed(() => loaded.value && lessons.value.length === 0)
  let version = 0
  let flight: Promise<void> | null = null

  function clearProgress() {
    version++
    flight = null
    ownerId.value = null
    collection.value = { byId: {}, allIds: [] }
    completedLessons.value = totalLessons.value = 0
    loading.value = loaded.value = false
    error.value = null
  }
  watch(() => auth.isAuthenticated ? auth.user?.id : null, clearProgress, { flush: 'sync' })

  function loadProgress(force = false): Promise<void> {
    if (flight) return flight
    if (loaded.value && !force) return Promise.resolve()
    if (!auth.isAuthenticated || !auth.user) { clearProgress(); return Promise.resolve() }
    const current = ++version
    const userId = auth.user.id
    ownerId.value = userId
    loading.value = true
    loaded.value = false
    error.value = null
    const valid = () => current === version && auth.isAuthenticated && auth.user?.id === userId
    flight = (async () => {
      try {
        let token = auth.accessToken ?? ''
        if (auth.expiresAt <= Date.now() + 5000) token = await auth.refreshSession()
        if (!valid()) return
        let result
        try { result = await progressService.getProgress(token) }
        catch (cause) {
          if (!valid()) return
          if (cause instanceof HttpError && cause.status === 401) token = await auth.refreshSession(token)
          else if (!(cause instanceof HttpError) || (cause.kind !== 'connection' && cause.status !== 503)) throw cause
          if (!valid()) return
          result = await progressService.getProgress(token) // Un solo reintento, únicamente GET.
        }
        if (!valid()) return
        const byId: Record<number, ProgressLesson> = {}
        for (const item of result.data.lessons) byId[item.lessonId] = item
        collection.value = { byId, allIds: result.data.lessons.map(item => item.lessonId) }
        completedLessons.value = result.data.completedLessons
        totalLessons.value = result.data.totalLessons
        loaded.value = true
      } catch (cause) {
        if (valid()) error.value = controlledError(cause)
      } finally {
        if (current === version) { loading.value = false; flight = null }
      }
    })()
    return flight
  }
  function reloadProgress() { return loadProgress(true) }
  return { ownerId, collection, completedLessons, totalLessons, lessons, loading, loaded, error, isEmpty,
    clearProgress, loadProgress, reloadProgress }
})
