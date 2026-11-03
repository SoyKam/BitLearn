import { ref, watch } from 'vue'
import { defineStore } from 'pinia'
import type { AuthError } from '../types/auth'
import type { AnswerInput, AnswerResult, LessonDetail, LessonResponse } from '../types/lesson'
import { lessonService } from '../services/lesson.service'
import { controlledError, HttpError } from '../services/http.service'
import { lessonId } from '../services/learning.validation'
import { useAuthStore } from './auth.store'
import { useProgressStore } from './progress.store'

export const useLessonStore = defineStore('lesson', () => {
  const auth = useAuthStore()
  const progress = useProgressStore()
  const lesson = ref<LessonDetail | null>(null)
  const currentId = ref<number | null>(null)
  const loading = ref(false)
  const error = ref<AuthError | null>(null)
  const submitting = ref(false)
  const result = ref<AnswerResult | null>(null)
  const questionId = ref<number | null>(null)
  const answerError = ref<AuthError | null>(null)
  const uncertain = ref(false)
  let version = 0
  let evaluationVersion = 0
  let flight: Promise<void> | null = null
  const pending = new Map<number, Promise<LessonResponse>>()

  function clearEvaluation() {
    evaluationVersion++
    result.value = null
    questionId.value = null
    answerError.value = null
    uncertain.value = false
  }
  watch(() => auth.isAuthenticated ? auth.user?.id : null, clearEvaluation, { flush: 'sync' })
  function clearLesson() {
    version++
    flight = null
    lesson.value = null
    currentId.value = null
    error.value = null
    loading.value = false
    clearEvaluation()
  }
  function loadLesson(value: unknown, force = false): Promise<void> {
    let id: number
    try { id = lessonId(value) }
    catch (cause) { clearLesson(); error.value = controlledError(cause); return Promise.resolve() }
    if (currentId.value === id) {
      if (flight) return flight
      if (lesson.value && !force) return Promise.resolve()
    }
    clearLesson()
    const current = version
    currentId.value = id
    loading.value = true
    let request = pending.get(id)
    if (!request) {
      request = lessonService.getLessonById(id).finally(() => pending.delete(id))
      pending.set(id, request)
    }
    flight = (async () => {
      try {
        const response = await request
        if (current === version) lesson.value = response.data
      } catch (cause) {
        if (current === version) error.value = cause instanceof HttpError && cause.status === 404
          ? { kind: 'server', status: 404, message: 'Lección no encontrada.' } : controlledError(cause)
      } finally { if (current === version) { loading.value = false; flight = null } }
    })()
    return flight
  }
  function reloadLesson(value: unknown) { return loadLesson(value, true) }
  function allowAnotherAttempt() { uncertain.value = false; answerError.value = null }

  async function submitAnswer(input: AnswerInput): Promise<void> {
    if (submitting.value || uncertain.value) return
    clearEvaluation()
    questionId.value = input.questionId
    if (!auth.isAuthenticated || !auth.user) {
      answerError.value = { kind: 'authentication', status: 401, message: 'Inicia sesión para responder.' }
      return
    }
    const question = lesson.value?.questions.find(item => item.id === input.questionId)
    if (!lesson.value || !question || !Number.isInteger(input.optionIndex) || input.optionIndex < 0 || input.optionIndex >= question.options.length) {
      answerError.value = { kind: 'validation', status: 400, message: 'Selecciona una opción válida de esta lección.' }
      return
    }
    const id = lesson.value.id
    const userId = auth.user.id
    const current = evaluationVersion
    const valid = () => current === evaluationVersion && auth.isAuthenticated && auth.user?.id === userId
    submitting.value = true // Antes de cualquier await: también bloquea durante el refresh.
    let sent = false
    let token = auth.accessToken ?? ''
    try {
      if (auth.expiresAt <= Date.now() + 5000) token = await auth.refreshSession()
      if (!valid()) return
      sent = true
      const response = await lessonService.submitAnswer(id, input, token)
      if (!valid()) return
      result.value = response.data
      progress.clearProgress() // Invalida GET anteriores a la escritura confirmada.
      void progress.loadProgress()
    } catch (cause) {
      if (!valid()) return
      const failure = controlledError(cause)
      if (sent && failure.status === 401) {
        try {
          await auth.refreshSession(token)
          if (valid()) answerError.value = { ...failure, message: 'Sesión renovada. La respuesta no se ha reenviado; puedes enviarla de nuevo.' }
        } catch {
          if (valid()) answerError.value = { ...failure, message: 'No se pudo recuperar la sesión. Inicia sesión de nuevo.' }
        }
      } else if (sent && (failure.kind === 'connection' || failure.kind === 'response' || failure.kind === 'server')) {
        uncertain.value = true
        answerError.value = { ...failure, message: 'No se pudo confirmar el resultado. Consulta tu progreso antes de volver a responder; un nuevo envío podría contar otro intento.' }
      } else answerError.value = failure.status === 404
        ? { ...failure, message: 'La lección o la pregunta ya no está disponible.' } : failure
    } finally { submitting.value = false }
  }
  return { lesson, currentId, loading, error, submitting, result, questionId, answerError, uncertain,
    loadLesson, reloadLesson, clearLesson, submitAnswer, allowAnotherAttempt }
})
