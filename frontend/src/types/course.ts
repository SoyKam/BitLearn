export interface Course {
  id: number
  title: string
  slug: string
  description: string | null
}

export interface CoursesResponse { success: true; data: Course[] }
export type CourseStatus = 'idle' | 'loading' | 'success' | 'error'
export interface CourseError {
  kind: 'connection' | 'server' | 'response'
  message: string
  status: number | null
}
