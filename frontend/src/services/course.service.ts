import type { Course, CourseError, CoursesResponse } from '../types/course'
import { HttpError, invalidResponse, isRecord, request } from './http.service'

function decodeCourse(value: unknown): Course {
  if (!isRecord(value)
    || typeof value.id !== 'number' || !Number.isSafeInteger(value.id) || value.id < 1
    || typeof value.title !== 'string' || !value.title.trim()
    || typeof value.slug !== 'string' || value.slug.length > 150
    || !/^[a-z0-9]+(-[a-z0-9]+)*$/.test(value.slug) || /\s/u.test(value.slug)
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

export const courseService = {
  async listCourses(): Promise<CoursesResponse> {
    try {
      return await request('/api/courses', decodeCourses)
    } catch (cause) {
      // Solo este GET público se repite una vez ante fallos temporales.
      // El segundo fallo se propaga; no hay bucles ni cambios en autenticación.
      if (cause instanceof HttpError && (cause.kind === 'connection' || cause.status === 503)) {
        return request('/api/courses', decodeCourses)
      }
      throw cause
    }
  },
}
