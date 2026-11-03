import { HttpError, invalidResponse, isRecord } from './http.service'
import type { LessonProgress } from '../types/lesson'

export function positiveId(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647
}
export function lessonId(value: unknown): number {
  const id = typeof value === 'string' && value.length <= 10 && /^[0-9]+$/.test(value) && !/\s/u.test(value) ? Number(value) : value
  if (!positiveId(id)) throw new HttpError('validation', 'Identificador de lección inválido.', 400)
  return id
}
export function textValue(value: unknown): value is string { return typeof value === 'string' && !!value.trim() }
export function courseSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 150 && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value) && !/\s/u.test(value)
}
export function counter(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 }
// Contratos cerrados: rechazar también soluciones o datos privados inesperados.
export function fields(value: unknown, keys: string[]): Record<string, unknown> {
  if (!isRecord(value) || Object.keys(value).some(key => !keys.includes(key)) || keys.some(key => !(key in value))) return invalidResponse()
  return value
}
export function dataOf(value: unknown): unknown {
  const envelope = fields(value, ['success', 'data'])
  if (envelope.success !== true) return invalidResponse()
  return envelope.data
}
export function decodeLessonProgress(value: unknown): LessonProgress {
  const data = fields(value, ['attempts', 'correctAnswers', 'completedAt'])
  if (!counter(data.attempts) || !counter(data.correctAnswers) || data.correctAnswers > data.attempts
    || !(data.completedAt === null || (typeof data.completedAt === 'string'
      && /^\d{4}-\d{2}-\d{2}T/.test(data.completedAt) && Number.isFinite(Date.parse(data.completedAt))))) return invalidResponse()
  return { attempts: data.attempts, correctAnswers: data.correctAnswers, completedAt: data.completedAt }
}
