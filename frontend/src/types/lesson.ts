import type { ApiSuccess } from './auth'

export interface LessonCourse { id: number; title: string; slug: string }
export interface LessonUnit { id: number; title: string }
export interface LessonQuestion { id: number; prompt: string; options: string[] }
export interface LessonDetail {
  id: number
  title: string
  content: string | null
  course: LessonCourse
  unit: LessonUnit
  questions: LessonQuestion[]
}
export interface AnswerInput { questionId: number; optionIndex: number }
export interface LessonProgress { attempts: number; correctAnswers: number; completedAt: string | null }
export interface AnswerResult { correct: boolean; completed: boolean; explanation: string | null; progress: LessonProgress }
export type LessonResponse = ApiSuccess<LessonDetail>
export type AnswerResponse = ApiSuccess<AnswerResult>
