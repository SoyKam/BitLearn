export type FlashcardStatus = 'new' | 'due'
export interface DueFlashcard {
  flashcardId: number
  lessonId: number
  lessonTitle: string
  courseSlug: string
  front: string
  back: string
  status: FlashcardStatus
  repetitions: number
  easeFactor: number
  intervalDays: number
  lastReviewAt: string | null
  nextReviewAt: string | null
}
export interface ReviewInput { flashcardId: number; quality: number; requestId: string }
export interface ReviewResult {
  reviewId: string
  flashcardId: number
  quality: number
  easeFactor: number
  intervalDays: number
  reviewedAt: string
  nextReviewAt: string
  replayed: boolean
}
export interface ReviewHistoryItem {
  reviewId: string
  flashcardId: number
  courseSlug: string
  lessonTitle: string
  front: string
  quality: number
  reviewedAt: string
  easeFactorBefore: number
  easeFactorAfter: number
  intervalBeforeDays: number
  intervalAfterDays: number
  nextReviewAt: string
}
export interface ReviewHistoryPage { items: ReviewHistoryItem[]; total: number; limit: number; offset: number }
export interface ReviewError { message: string; status: number | null }
export const reviewGrades = [
  { quality: 1, label: 'Otra vez', description: 'No recordé la respuesta.' },
  { quality: 3, label: 'Difícil', description: 'La recordé con mucho esfuerzo.' },
  { quality: 4, label: 'Bien', description: 'La recordé con algo de esfuerzo.' },
  { quality: 5, label: 'Fácil', description: 'La recordé sin dificultad.' },
] as const
export function qualityLabel(quality: number): string {
  return reviewGrades.find(grade => grade.quality === quality)?.label ?? `Calificación ${quality}`
}
