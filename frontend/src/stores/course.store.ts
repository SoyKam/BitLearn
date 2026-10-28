import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { courseDetailError, courseError, courseService } from '../services/course.service'
import type { Course, CourseDetail, CourseDetailError, CourseDetailResponse, CourseError, CourseStatus } from '../types/course'

export const useCourseStore = defineStore('courses', () => {
  const catalog = ref<{ byId: Record<number, Course>; allIds: number[] }>({ byId: {}, allIds: [] })
  const status = ref<CourseStatus>('idle')
  const error = ref<CourseError | null>(null)
  const initialized = ref(false)
  const loading = computed(() => status.value === 'loading')
  const courses = computed(() => catalog.value.allIds.flatMap(id => {
    const course = catalog.value.byId[id]
    return course ? [course] : []
  }))
  const isEmpty = computed(() => status.value === 'success' && courses.value.length === 0)
  let flight: Promise<void> | null = null

  function fetchCourses(): Promise<void> {
    // Carga y recarga comparten la consulta activa. Al serializarlas, ninguna
    // respuesta anterior puede llegar después de una recarga más reciente.
    if (flight) return flight
    status.value = 'loading'
    error.value = null
    flight = (async () => {
      try {
        const { data } = await courseService.listCourses()
        const byId: Record<number, Course> = {}
        for (const course of data) byId[course.id] = course
        catalog.value = { byId, allIds: data.map(course => course.id) }
        status.value = 'success'
      } catch (cause) {
        error.value = courseError(cause)
        status.value = 'error'
      } finally {
        initialized.value = true
        flight = null
      }
    })()
    return flight
  }

  function loadCourses(): Promise<void> {
    if (flight) return flight
    if (status.value === 'success') return Promise.resolve()
    return fetchCourses()
  }

  function reloadCourses(): Promise<void> { return fetchCourses() }

  const detail = ref<CourseDetail | null>(null)
  const detailSlug = ref<string | null>(null)
  const detailStatus = ref<CourseStatus>('idle')
  const detailError = ref<CourseDetailError | null>(null)
  const detailLoading = computed(() => detailStatus.value === 'loading')
  let detailVersion = 0
  let detailFlight: Promise<void> | null = null
  const pendingDetails = new Map<string, Promise<CourseDetailResponse>>()

  function fetchCourseDetail(slug: string): Promise<void> {
    if (detailSlug.value === slug && detailFlight) return detailFlight
    const version = ++detailVersion
    detailSlug.value = slug
    detail.value = null
    detailError.value = null
    detailStatus.value = 'loading'
    // También reutiliza el GET si se navega A → B → A mientras A sigue pendiente.
    let pending = pendingDetails.get(slug)
    if (!pending) {
      pending = courseService.getCourseBySlug(slug).finally(() => pendingDetails.delete(slug))
      pendingDetails.set(slug, pending)
    }
    detailFlight = (async () => {
      try {
        const { data } = await pending
        if (version !== detailVersion) return
        detail.value = data
        detailStatus.value = 'success'
      } catch (cause) {
        if (version !== detailVersion) return
        detailError.value = courseDetailError(cause)
        detailStatus.value = 'error'
      } finally {
        if (version === detailVersion) detailFlight = null
      }
    })()
    return detailFlight
  }

  function loadCourseDetail(slug: string): Promise<void> {
    // Caché solo del detalle actual, en memoria y hasta salir de la vista.
    if (detailSlug.value === slug && detailStatus.value === 'success') return Promise.resolve()
    return fetchCourseDetail(slug)
  }

  function reloadCourseDetail(slug: string): Promise<void> { return fetchCourseDetail(slug) }

  function clearCourseDetail(): void {
    ++detailVersion
    detailFlight = null
    detail.value = null
    detailSlug.value = null
    detailError.value = null
    detailStatus.value = 'idle'
  }

  return {
    catalog, status, error, initialized, loading, courses, isEmpty, loadCourses, reloadCourses,
    detail, detailSlug, detailStatus, detailError, detailLoading,
    loadCourseDetail, reloadCourseDetail, clearCourseDetail,
  }
})
