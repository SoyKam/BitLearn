import type { Course, CourseDetailError, CourseDetailResponse, CourseError, CourseLesson, CourseUnit, CoursesResponse } from '../types/course'
import { HttpError, invalidResponse, isRecord, request } from './http.service'

function isCourseSlug(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 150
    && /^[a-z0-9]+(-[a-z0-9]+)*$/.test(value) && !/\s/u.test(value)
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
}

function decodeCourse(value: unknown): Course {
  if (!isRecord(value)
    || !isPositiveInteger(value.id)
    || typeof value.title !== 'string' || !value.title.trim()
    || !isCourseSlug(value.slug)
    || (typeof value.description !== 'string' && value.description !== null)) return invalidResponse()

  // Proyectar únicamente el contrato público; nunca copiar campos adicionales.
  return { id: value.id, title: value.title, slug: value.slug, description: value.description }
}

function decodeCourses(value: unknown): CoursesResponse {
  if (!isRecord(value) || value.success !== true || !Array.isArray(value.data)) return invalidResponse()
  const data = value.data.map(decodeCourse)
  // Una identidad repetida no debe perder datos al normalizar la colección.
  if (new Set(data.map(course => course.id)).size !== data.length
    || new Set(data.map(course => course.slug)).size !== data.length) return invalidResponse()
  return { success: true, data }
}

function decodeLesson(value: unknown): CourseLesson {
  if (!isRecord(value) || !isPositiveInteger(value.id)
    || typeof value.title !== 'string' || !value.title.trim()
    || !isPositiveInteger(value.position)) return invalidResponse()
  return { id: value.id, title: value.title, position: value.position }
}

function orderedCollection<T extends { id: number; position: number }>(items: T[]): T[] {
  if (new Set(items.map(item => item.id)).size !== items.length
    || new Set(items.map(item => item.position)).size !== items.length) return invalidResponse()
  return items.sort((a, b) => a.position - b.position)
}

function decodeUnit(value: unknown): CourseUnit {
  const unit = decodeLesson(value)
  if (!isRecord(value) || !Array.isArray(value.lessons)) return invalidResponse()
  return { ...unit, lessons: orderedCollection(value.lessons.map(decodeLesson)) }
}

function decodeCourseDetail(value: unknown, slug: string): CourseDetailResponse {
  if (!isRecord(value) || value.success !== true || !isRecord(value.data)
    || !Array.isArray(value.data.units)) return invalidResponse()
  const course = decodeCourse(value.data)
  if (course.slug !== slug) return invalidResponse()
  return { success: true, data: { ...course, units: orderedCollection(value.data.units.map(decodeUnit)) } }
}

export function courseDetailError(cause: unknown): CourseDetailError {
  const status = cause instanceof HttpError ? cause.status : null
  if (status === 404) return { kind: 'not-found', status, message: 'Curso no encontrado.' }
  if (cause instanceof HttpError && cause.kind === 'validation') {
    return { kind: 'validation', status, message: 'Slug de curso inválido.' }
  }
  if (cause instanceof HttpError && cause.kind === 'response') {
    return { kind: 'response', status, message: 'No se pudo interpretar la información del curso.' }
  }
  if (!(cause instanceof HttpError) || cause.kind === 'connection') {
    return { kind: 'connection', status, message: 'No se pudo conectar con el servidor.' }
  }
  return { kind: 'server', status, message: 'No se pudo cargar el curso. Inténtalo de nuevo.' }
}

export function courseError(cause: unknown): CourseError {
  const status = cause instanceof HttpError ? cause.status : null
  if (cause instanceof HttpError && cause.kind === 'response') {
    return { kind: 'response', status, message: 'No se pudo interpretar la información del catálogo.' }
  }
  if (!(cause instanceof HttpError) || cause.kind === 'connection') {
    return { kind: 'connection', status, message: 'No se pudo conectar con el servidor. Comprueba tu conexión e inténtalo de nuevo.' }
  }
  return { kind: 'server', status, message: 'El catálogo no está disponible temporalmente. Inténtalo más tarde.' }
}

async function publicGet<T>(path: `/api/${string}`, decode: (value: unknown) => T): Promise<T> {
  try {
    return await request(path, decode)
  } catch (cause) {
    // Solo GET públicos: un reintento ante conexión/503, sin renovar sesión.
    if (cause instanceof HttpError && (cause.kind === 'connection' || cause.status === 503)) {
      return request(path, decode)
    }
    throw cause
  }
}

export const courseService = {
  listCourses(): Promise<CoursesResponse> {
    return publicGet('/api/courses', decodeCourses)
  },
  async getCourseBySlug(slug: string): Promise<CourseDetailResponse> {
    if (!isCourseSlug(slug)) throw new HttpError('validation', 'Slug de curso inválido.')
    return publicGet(`/api/courses/${encodeURIComponent(slug)}`, value => decodeCourseDetail(value, slug))
  },
}
