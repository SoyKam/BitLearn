import type { DueFlashcard, ReviewError, ReviewHistoryItem, ReviewHistoryPage, ReviewInput, ReviewResult } from '../types/review'
import { HttpError, invalidResponse, request } from './http.service'
import { counter, courseSlug, dataOf, fields, positiveId, textValue } from './learning.validation'

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
function date(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)
    && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value
}
function factor(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value >= 1.3 && value <= 9999.9999 }
function quality(value: unknown): value is number { return counter(value) && value <= 5 }
function reviewId(value: unknown): value is string { return typeof value === 'string' && /^[1-9][0-9]*$/.test(value) }
function decodeDue(value: unknown): DueFlashcard {
  const d = fields(value, ['flashcardId', 'lessonId', 'lessonTitle', 'courseSlug', 'front', 'back', 'status', 'repetitions', 'easeFactor', 'intervalDays', 'lastReviewAt', 'nextReviewAt'])
  if (!positiveId(d.flashcardId) || !positiveId(d.lessonId) || !textValue(d.lessonTitle) || !courseSlug(d.courseSlug)
    || !textValue(d.front) || !textValue(d.back) || (d.status !== 'new' && d.status !== 'due')
    || !counter(d.repetitions) || !factor(d.easeFactor) || !counter(d.intervalDays)
    || !(d.lastReviewAt === null || date(d.lastReviewAt)) || !(d.nextReviewAt === null || date(d.nextReviewAt))) return invalidResponse()
  if (d.status === 'new' ? d.repetitions !== 0 || d.easeFactor !== 2.5 || d.intervalDays !== 0 || d.lastReviewAt !== null || d.nextReviewAt !== null
    : d.lastReviewAt === null || d.nextReviewAt === null || d.intervalDays < 1 || d.nextReviewAt < d.lastReviewAt) return invalidResponse()
  return { flashcardId: d.flashcardId, lessonId: d.lessonId, lessonTitle: d.lessonTitle, courseSlug: d.courseSlug,
    front: d.front, back: d.back, status: d.status, repetitions: d.repetitions, easeFactor: d.easeFactor,
    intervalDays: d.intervalDays, lastReviewAt: d.lastReviewAt, nextReviewAt: d.nextReviewAt }
}
function decodeResult(value: unknown, input: ReviewInput): ReviewResult {
  const d = fields(dataOf(value), ['reviewId', 'flashcardId', 'quality', 'easeFactor', 'intervalDays', 'reviewedAt', 'nextReviewAt', 'replayed'])
  if (!reviewId(d.reviewId) || !positiveId(d.flashcardId) || d.flashcardId !== input.flashcardId || !quality(d.quality)
    || d.quality !== input.quality || !factor(d.easeFactor) || !counter(d.intervalDays) || !date(d.reviewedAt)
    || !date(d.nextReviewAt) || d.nextReviewAt < d.reviewedAt || typeof d.replayed !== 'boolean') return invalidResponse()
  return { reviewId: d.reviewId, flashcardId: d.flashcardId, quality: d.quality, easeFactor: d.easeFactor,
    intervalDays: d.intervalDays, reviewedAt: d.reviewedAt, nextReviewAt: d.nextReviewAt, replayed: d.replayed }
}
function decodeHistoryItem(value: unknown): ReviewHistoryItem {
  const d = fields(value, ['reviewId', 'flashcardId', 'courseSlug', 'lessonTitle', 'front', 'quality', 'reviewedAt', 'easeFactorBefore', 'easeFactorAfter', 'intervalBeforeDays', 'intervalAfterDays', 'nextReviewAt'])
  if (!reviewId(d.reviewId) || !positiveId(d.flashcardId) || !courseSlug(d.courseSlug) || !textValue(d.lessonTitle)
    || !textValue(d.front) || !quality(d.quality) || !date(d.reviewedAt) || !date(d.nextReviewAt) || d.nextReviewAt < d.reviewedAt
    || !factor(d.easeFactorBefore) || !factor(d.easeFactorAfter) || !counter(d.intervalBeforeDays) || !counter(d.intervalAfterDays)) return invalidResponse()
  return { reviewId: d.reviewId, flashcardId: d.flashcardId, courseSlug: d.courseSlug, lessonTitle: d.lessonTitle,
    front: d.front, quality: d.quality, reviewedAt: d.reviewedAt, easeFactorBefore: d.easeFactorBefore,
    easeFactorAfter: d.easeFactorAfter, intervalBeforeDays: d.intervalBeforeDays, intervalAfterDays: d.intervalAfterDays, nextReviewAt: d.nextReviewAt }
}
export function reviewError(cause: unknown): ReviewError {
  const status = cause instanceof HttpError ? cause.status : null
  const messages: Record<number, string> = {
    400: 'Solicitud de repaso inválida.', 401: 'La sesión ya no es válida. Inicia sesión de nuevo.',
    403: 'Completa la lección antes de repasar esta tarjeta.', 404: 'Esta flashcard ya no existe.',
    409: 'La tarjeta ya no está pendiente o existe un conflicto con esta operación. Consulta tu historial.',
    429: 'Demasiadas solicitudes. Espera unos minutos antes de reintentar.',
    500: 'No se pudo procesar el repaso. Inténtalo más tarde.', 503: 'El servicio de repasos no está disponible temporalmente.',
  }
  return { status, message: (status !== null ? messages[status] : null)
    ?? (cause instanceof HttpError && cause.kind === 'response' ? 'La respuesta de repasos no es válida.' : 'No se pudo conectar con el servidor. Comprueba tu conexión.') }
}
export function createReviewRequestId(): string {
  if (typeof globalThis.crypto?.randomUUID !== 'function') throw new HttpError('validation', 'Utiliza una conexión HTTPS o localhost para registrar repasos.')
  return globalThis.crypto.randomUUID()
}
function parameters(token: string, limit: number, offset = 0) {
  if (!token.trim()) throw new HttpError('authentication', 'Inicia sesión para repasar.', 401)
  if (!positiveId(limit) || limit > 100 || !counter(offset) || offset > 10000) throw new HttpError('validation', 'Paginación inválida.', 400)
}
export const reviewService = {
  async getDueReviews(accessToken: string, limit = 50): Promise<DueFlashcard[]> {
    parameters(accessToken, limit)
    return request(`/api/reviews/due?limit=${limit}`, value => {
      const data = dataOf(value)
      if (!Array.isArray(data) || data.length > limit) return invalidResponse()
      const items = data.map(decodeDue)
      if (new Set(items.map(item => item.flashcardId)).size !== items.length) return invalidResponse()
      return items
    }, { accessToken })
  },
  async getReviewHistory(accessToken: string, limit = 20, offset = 0): Promise<ReviewHistoryPage> {
    parameters(accessToken, limit, offset)
    return request(`/api/reviews/history?limit=${limit}&offset=${offset}`, value => {
      const d = fields(dataOf(value), ['items', 'total', 'limit', 'offset'])
      if (!Array.isArray(d.items) || !counter(d.total) || d.limit !== limit || d.offset !== offset
        || d.items.length !== Math.min(limit, Math.max(0, d.total - offset))) return invalidResponse()
      const items = d.items.map(decodeHistoryItem)
      if (new Set(items.map(item => item.reviewId)).size !== items.length || items.some((item, i) => {
        const previous = items[i - 1]
        return previous && (previous.reviewedAt < item.reviewedAt || (previous.reviewedAt === item.reviewedAt && BigInt(previous.reviewId) <= BigInt(item.reviewId)))
      })) return invalidResponse()
      return { items, total: d.total, limit, offset }
    }, { accessToken })
  },
  async submitReview(accessToken: string, input: ReviewInput): Promise<ReviewResult> {
    parameters(accessToken, 1)
    if (!positiveId(input.flashcardId) || !quality(input.quality) || !uuid.test(input.requestId)) throw new HttpError('validation', 'Datos de repaso inválidos.', 400)
    return request('/api/reviews', value => decodeResult(value, input), { accessToken, method: 'POST',
      body: { flashcardId: input.flashcardId, quality: input.quality, requestId: input.requestId } })
  },
}
