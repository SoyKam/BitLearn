import { request, invalidResponse, HttpError } from './http.service'
import { fields, dataOf, counter, positiveId, textValue, courseSlug } from './learning.validation'
const percent = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 100
const date = (v: unknown): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v
function progress(d: Record<string, unknown>) {
  if (!counter(d.totalLessons) || !counter(d.completedLessons) || d.completedLessons > d.totalLessons || !percent(d.completionPercent)) return invalidResponse()
  return { totalLessons: d.totalLessons, completedLessons: d.completedLessons, completionPercent: d.completionPercent }
}
export function decodeDashboard(value: unknown) {
  const d = fields(dataOf(value), ['summary', 'courses'])
  const s = fields(d.summary, ['totalLessons', 'completedLessons', 'completionPercent', 'studiedFlashcards', 'dueReviews', 'totalReviews'])
  if (!counter(s.studiedFlashcards) || !counter(s.dueReviews) || !counter(s.totalReviews) || !Array.isArray(d.courses)) return invalidResponse()
  const courses = d.courses.map(value => {
    const c = fields(value, ['courseId', 'courseSlug', 'courseTitle', 'totalLessons', 'completedLessons', 'completionPercent'])
    if (!positiveId(c.courseId) || !courseSlug(c.courseSlug) || !textValue(c.courseTitle)) return invalidResponse()
    return { ...progress(c), courseId: c.courseId, courseSlug: c.courseSlug, courseTitle: c.courseTitle }
  })
  if (new Set(courses.map(c => c.courseId)).size !== courses.length) return invalidResponse()
  return { summary: { ...progress(s), studiedFlashcards: s.studiedFlashcards, dueReviews: s.dueReviews, totalReviews: s.totalReviews }, courses }
}
export function decodeRetention(value: unknown) {
  const d = fields(dataOf(value), ['asOf', 'modeledCards', 'averageRetentionNowPercent', 'nextScheduledReviewAt', 'points'])
  if (!date(d.asOf) || !counter(d.modeledCards) || !(d.averageRetentionNowPercent === null || percent(d.averageRetentionNowPercent))
    || !(d.nextScheduledReviewAt === null || date(d.nextScheduledReviewAt)) || !Array.isArray(d.points)) return invalidResponse()
  const horizons = [0, 1, 3, 7, 14, 30]
  const points = d.points.map((value, index) => {
    const p = fields(value, ['daysAhead', 'estimatedRetentionPercent'])
    if (p.daysAhead !== horizons[index] || typeof p.daysAhead !== 'number' || !percent(p.estimatedRetentionPercent)) return invalidResponse()
    return { daysAhead: p.daysAhead, estimatedRetentionPercent: p.estimatedRetentionPercent }
  })
  if (d.modeledCards === 0 ? points.length !== 0 || d.averageRetentionNowPercent !== null || d.nextScheduledReviewAt !== null
    : points.length !== 6 || d.averageRetentionNowPercent !== points[0]?.estimatedRetentionPercent) return invalidResponse()
  if (d.nextScheduledReviewAt !== null && d.nextScheduledReviewAt <= d.asOf) return invalidResponse()
  if (points.some((p, i) => i > 0 && p.estimatedRetentionPercent > (points[i - 1]?.estimatedRetentionPercent ?? 100))) return invalidResponse()
  return { asOf: d.asOf, modeledCards: d.modeledCards, averageRetentionNowPercent: d.averageRetentionNowPercent, nextScheduledReviewAt: d.nextScheduledReviewAt, points }
}
export type Dashboard = ReturnType<typeof decodeDashboard>
export type Retention = ReturnType<typeof decodeRetention>
// Solo estos GET idempotentes: un reintento ante conexión o indisponibilidad.
async function get<T>(path: `/api/${string}`, decode: (value: unknown) => T, accessToken: string): Promise<T> {
  try { return await request(path, decode, { accessToken }) } catch (cause) {
    if (!(cause instanceof HttpError) || !(cause.kind === 'connection' || cause.status === 503)) throw cause
    return request(path, decode, { accessToken })
  }
}
export const dashboardService = {
  getDashboard: (accessToken: string) => get('/api/dashboard', decodeDashboard, accessToken),
  getRetention: (accessToken: string) => get('/api/dashboard/retention', decodeRetention, accessToken),
}
