import { computed, ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { DueFlashcard, ReviewError, ReviewHistoryPage, ReviewInput, ReviewResult } from '../types/review'
import { createReviewRequestId, reviewError, reviewService } from '../services/review.service'
import { HttpError } from '../services/http.service'
import { useAuthStore } from './auth.store'

export const useReviewStore = defineStore('reviews', () => {
  const auth = useAuthStore()
  const ownerId = ref<number | null>(null)
  const collection = ref<{ byId: Record<number, DueFlashcard>; allIds: number[] }>({ byId: {}, allIds: [] })
  const due = computed(() => collection.value.allIds.flatMap(id => collection.value.byId[id] ?? []))
  const selectedId = ref<number | null>(null)
  const selected = computed(() => selectedId.value === null ? null : collection.value.byId[selectedId.value] ?? null)
  const revealed = ref(false)
  const loading = ref(false)
  const loaded = ref(false)
  const loadError = ref<ReviewError | null>(null)
  const submitting = ref(false)
  const result = ref<ReviewResult | null>(null)
  const submitError = ref<ReviewError | null>(null)
  const pending = ref<ReviewInput | null>(null)
  const uncertain = ref(false)
  const history = ref<ReviewHistoryPage>({ items: [], total: 0, limit: 20, offset: 0 })
  const historyLoading = ref(false)
  const historyLoaded = ref(false)
  const historyError = ref<ReviewError | null>(null)
  let generation = 0
  let historyVersion = 0
  let dueFlight: Promise<void> | null = null
  let historyFlight: Promise<void> | null = null
  let rejectedToken: string | null = null

  function clearReviews() {
    generation++; historyVersion++
    dueFlight = historyFlight = null
    rejectedToken = null
    ownerId.value = selectedId.value = null
    collection.value = { byId: {}, allIds: [] }
    revealed.value = loading.value = loaded.value = submitting.value = uncertain.value = false
    loadError.value = submitError.value = historyError.value = null
    result.value = pending.value = null
    history.value = { items: [], total: 0, limit: 20, offset: 0 }
    historyLoading.value = historyLoaded.value = false
  }
  watch(() => auth.isAuthenticated ? auth.user?.id : null, clearReviews, { flush: 'sync' })
  function context() {
    const version = generation
    const id = auth.user?.id
    ownerId.value = id ?? null
    return () => version === generation && auth.isAuthenticated && auth.user?.id === id
  }
  async function get<T>(query: (token: string) => Promise<T>, valid: () => boolean): Promise<T | undefined> {
    let token = auth.accessToken ?? ''
    if (auth.expiresAt <= Date.now() + 5000) token = await auth.refreshSession()
    if (!valid()) return
    try { return await query(token) }
    catch (cause) {
      if (!valid()) return
      if (!(cause instanceof HttpError) || cause.status !== 401) throw cause
      token = await auth.refreshSession(token)
      if (valid()) return query(token) // Un único reintento GET después de renovar.
    }
  }
  function loadDueReviews(): Promise<void> {
    if (dueFlight) return dueFlight
    if (!auth.isAuthenticated || pending.value || submitting.value) return Promise.resolve()
    const valid = context()
    loading.value = true; loadError.value = null
    dueFlight = (async () => {
      try {
        const items = await get(token => reviewService.getDueReviews(token), valid)
        if (!valid() || !items) return
        const byId: Record<number, DueFlashcard> = {}
        for (const item of items) byId[item.flashcardId] = item
        collection.value = { byId, allIds: items.map(item => item.flashcardId) }
        selectedId.value = items[0]?.flashcardId ?? null
        revealed.value = false
        loaded.value = true
      } catch (cause) { if (valid()) loadError.value = reviewError(cause) }
      finally { if (valid()) { loading.value = false; dueFlight = null } }
    })()
    return dueFlight
  }
  function loadHistory(offset = history.value.offset): Promise<void> {
    if (historyFlight) return historyFlight
    if (!auth.isAuthenticated || !Number.isInteger(offset) || offset < 0 || offset > 10000) return Promise.resolve()
    const sessionValid = context()
    const version = ++historyVersion
    const valid = () => sessionValid() && version === historyVersion
    historyLoading.value = true; historyError.value = null
    historyFlight = (async () => {
      try {
        const page = await get(token => reviewService.getReviewHistory(token, 20, offset), valid)
        if (valid() && page) { history.value = page; historyLoaded.value = true }
      } catch (cause) { if (valid()) historyError.value = reviewError(cause) }
      finally { if (valid()) { historyLoading.value = false; historyFlight = null } }
    })()
    return historyFlight
  }
  function selectFlashcard(id: number) {
    if (pending.value || submitting.value || loading.value || !collection.value.byId[id]) return
    selectedId.value = id; revealed.value = false; submitError.value = null
  }
  function revealAnswer() { if (selected.value && !submitting.value && !pending.value) revealed.value = true }
  async function sendPending() {
    if (submitting.value || !pending.value || !auth.isAuthenticated) return
    const input = { ...pending.value }
    const valid = context()
    const wasUncertain = uncertain.value
    submitting.value = true; submitError.value = null
    let sent = false
    let confirmed = false
    let token = auth.accessToken ?? ''
    try {
      if (rejectedToken !== null || auth.expiresAt <= Date.now() + 5000) token = await auth.refreshSession(rejectedToken)
      if (!valid()) return
      rejectedToken = null
      sent = true
      const response = await reviewService.submitReview(token, input)
      if (!valid()) return
      result.value = response
      pending.value = null; uncertain.value = false
      confirmed = true
      // Invalidar cualquier historial anterior a la escritura confirmada.
      historyVersion++; historyFlight = null; historyLoading.value = false; historyLoaded.value = false
      history.value = { items: [], total: 0, limit: 20, offset: 0 }
    } catch (cause) {
      if (!valid()) return
      const failure = reviewError(cause)
      const ambiguous = sent && (!(cause instanceof HttpError) || cause.status === null || cause.status === 401 || (cause.status ?? 0) >= 500)
      uncertain.value = wasUncertain || ambiguous
      if (sent && failure.status === 401) rejectedToken = token
      if (!uncertain.value) pending.value = null
      submitError.value = failure
    } finally { if (valid()) submitting.value = false }
    if (confirmed && valid()) await Promise.all([loadDueReviews(), loadHistory(0)])
  }
  async function submitReview(quality: number) {
    if (!auth.isAuthenticated || !selected.value || !revealed.value || pending.value || submitting.value || loading.value || loadError.value
      || ![1, 3, 4, 5].includes(quality)) return
    try {
      const requestId = createReviewRequestId()
      pending.value = { flashcardId: selected.value.flashcardId, quality, requestId }
      result.value = null
      await sendPending()
    } catch (cause) {
      submitError.value = { status: null, message: cause instanceof HttpError ? cause.message : 'No se pudo preparar el repaso.' }
    }
  }
  function retryConfirmation() { return sendPending() }
  // La navegación Vue conserva el intento en memoria; solo la sesión lo elimina.
  return { ownerId, collection, due, selectedId, selected, revealed, loading, loaded, loadError, submitting, result,
    submitError, pending, uncertain, history, historyLoading, historyLoaded, historyError,
    clearReviews, loadDueReviews, reloadDueReviews: loadDueReviews, loadHistory, selectFlashcard, revealAnswer, submitReview, retryConfirmation }
})
