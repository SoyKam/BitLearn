export interface Course {
  id: number
  title: string
  slug: string
  description: string | null
}

export interface CoursesResponse { success: true; data: Course[] }
export interface CourseLesson {
  id: number
  title: string
  position: number
}

export interface CourseUnit {
  id: number
  title: string
  position: number
  lessons: CourseLesson[]
}

export interface CourseDetail extends Course { units: CourseUnit[] }
export interface CourseDetailResponse { success: true; data: CourseDetail }
export interface CourseDetailError {
  kind: CourseError['kind'] | 'validation' | 'not-found'
  message: string
  status: number | null
}

export type CourseStatus = 'idle' | 'loading' | 'success' | 'error'
export interface CourseError {
  kind: 'connection' | 'server' | 'response'
  message: string
  status: number | null
}
