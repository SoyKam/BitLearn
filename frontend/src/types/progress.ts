import type { ApiSuccess } from './auth'
import type { LessonProgress } from './lesson'

export interface ProgressLesson extends LessonProgress { lessonId: number; courseSlug: string }
export interface PersonalProgress { completedLessons: number; totalLessons: number; lessons: ProgressLesson[] }
export type ProgressResponse = ApiSuccess<PersonalProgress>
