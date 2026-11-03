import type { AnswerInput, AnswerResponse, LessonQuestion, LessonResponse } from '../types/lesson'
import { HttpError, invalidResponse, request } from './http.service'
import { courseSlug, dataOf, decodeLessonProgress, fields, lessonId, positiveId, textValue } from './learning.validation'

function decodeQuestion(value: unknown): LessonQuestion {
  const data = fields(value, ['id', 'prompt', 'options'])
  if (!positiveId(data.id) || !textValue(data.prompt) || !Array.isArray(data.options)
    || data.options.length < 2 || data.options.length > 6 || !data.options.every(textValue)) return invalidResponse()
  return { id: data.id, prompt: data.prompt, options: data.options.map(option => option) }
}
function decodeLesson(value: unknown, id: number): LessonResponse {
  const data = fields(dataOf(value), ['id', 'title', 'content', 'course', 'unit', 'questions'])
  const course = fields(data.course, ['id', 'title', 'slug'])
  const unit = fields(data.unit, ['id', 'title'])
  if (data.id !== id || !textValue(data.title) || !(typeof data.content === 'string' || data.content === null)
    || !positiveId(course.id) || !textValue(course.title) || !courseSlug(course.slug)
    || !positiveId(unit.id) || !textValue(unit.title) || !Array.isArray(data.questions)) return invalidResponse()
  const questions = data.questions.map(decodeQuestion)
  if (new Set(questions.map(question => question.id)).size !== questions.length) return invalidResponse()
  return { success: true, data: { id, title: data.title, content: data.content,
    course: { id: course.id, title: course.title, slug: course.slug }, unit: { id: unit.id, title: unit.title }, questions } }
}
function decodeAnswer(value: unknown): AnswerResponse {
  const data = fields(dataOf(value), ['correct', 'completed', 'explanation', 'progress'])
  const progress = decodeLessonProgress(data.progress)
  if (typeof data.correct !== 'boolean' || typeof data.completed !== 'boolean'
    || !(typeof data.explanation === 'string' || data.explanation === null)
    || data.completed !== (progress.completedAt !== null)) return invalidResponse()
  return { success: true, data: { correct: data.correct, completed: data.completed, explanation: data.explanation, progress } }
}
export const lessonService = {
  async getLessonById(value: unknown): Promise<LessonResponse> {
    const id = lessonId(value)
    try { return await request(`/api/lessons/${id}`, body => decodeLesson(body, id)) }
    catch (cause) {
      if (cause instanceof HttpError && (cause.kind === 'connection' || cause.status === 503)) {
        return request(`/api/lessons/${id}`, body => decodeLesson(body, id))
      }
      throw cause
    }
  },
  async submitAnswer(value: unknown, input: AnswerInput, accessToken: string): Promise<AnswerResponse> {
    const id = lessonId(value)
    if (!positiveId(input.questionId) || !Number.isInteger(input.optionIndex) || input.optionIndex < 0 || input.optionIndex > 5) {
      throw new HttpError('validation', 'Selecciona una opción válida.', 400)
    }
    if (!accessToken.trim()) throw new HttpError('authentication', 'Inicia sesión para responder.', 401)
    return request(`/api/lessons/${id}/answer`, decodeAnswer, { method: 'POST', accessToken,
      body: { questionId: input.questionId, optionIndex: input.optionIndex } })
  },
}
