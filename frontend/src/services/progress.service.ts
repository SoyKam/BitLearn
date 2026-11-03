import type { ProgressResponse } from '../types/progress'
import { HttpError, invalidResponse, request } from './http.service'
import { counter, courseSlug, dataOf, decodeLessonProgress, fields, positiveId } from './learning.validation'

function decodeProgress(value: unknown): ProgressResponse {
  const data = fields(dataOf(value), ['completedLessons', 'totalLessons', 'lessons'])
  if (!counter(data.completedLessons) || !counter(data.totalLessons) || !Array.isArray(data.lessons)) return invalidResponse()
  const lessons = data.lessons.map(value => {
    const item = fields(value, ['lessonId', 'courseSlug', 'attempts', 'correctAnswers', 'completedAt'])
    if (!positiveId(item.lessonId) || !courseSlug(item.courseSlug)) return invalidResponse()
    const progress = decodeLessonProgress({ attempts: item.attempts, correctAnswers: item.correctAnswers, completedAt: item.completedAt })
    return { lessonId: item.lessonId, courseSlug: item.courseSlug, ...progress }
  })
  if (new Set(lessons.map(item => item.lessonId)).size !== lessons.length || lessons.length > data.totalLessons
    || data.completedLessons !== lessons.filter(item => item.completedAt !== null).length) return invalidResponse()
  return { success: true, data: { completedLessons: data.completedLessons, totalLessons: data.totalLessons, lessons } }
}
export const progressService = {
  async getProgress(accessToken: string): Promise<ProgressResponse> {
    if (!accessToken.trim()) throw new HttpError('authentication', 'Inicia sesión para consultar tu progreso.', 401)
    return request('/api/progress', decodeProgress, { accessToken })
  },
}
