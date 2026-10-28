import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { courseError, courseService } from '../services/course.service'
import type { Course, CourseError, CourseStatus } from '../types/course'

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

  return { catalog, status, error, initialized, loading, courses, isEmpty, loadCourses, reloadCourses }
})
