const { calculateSm2, createInitialSm2State } = require('../domain/sm2');

class ReviewNotFoundError extends Error {}
class ReviewForbiddenError extends Error {}
class ReviewConflictError extends Error {}
class ReviewNotDueError extends Error {}
class ReviewsUnavailableError extends Error {}

function replay(review, input) {
  if (review.flashcardId !== input.flashcardId || review.quality !== input.quality) {
    throw new ReviewConflictError();
  }
  return { ...review, replayed: true };
}

function createReviewService(repository) {
  return {
    async due(userId, { limit = 50 } = {}) {
      const rows = await repository.findDue(userId, limit);
      return rows.map(row => ({
        flashcardId: row.flashcard_id, lessonId: row.lesson_id, lessonTitle: row.lesson_title,
        courseSlug: row.course_slug, front: row.front, back: row.back,
        status: row.progress_id === null ? 'new' : 'due',
        repetitions: row.progress_id === null ? 0 : row.repetitions,
        easeFactor: row.progress_id === null ? 2.5 : row.ease_factor,
        intervalDays: row.progress_id === null ? 0 : row.interval_days,
        lastReviewAt: row.last_review_at, nextReviewAt: row.next_review_at,
      }));
    },
    async history(userId, { limit = 20, offset = 0 } = {}) {
      const { items, total } = await repository.findHistory(userId, limit, offset);
      return { items: items.map(row => ({
        reviewId: row.id, flashcardId: row.flashcard_id, courseSlug: row.course_slug,
        lessonTitle: row.lesson_title, front: row.front, quality: row.quality,
        reviewedAt: row.reviewed_at, easeFactorBefore: row.ease_factor_before,
        easeFactorAfter: row.ease_factor_after, intervalBeforeDays: row.interval_before_days,
        intervalAfterDays: row.interval_after_days, nextReviewAt: row.next_review_at,
      })), total, limit, offset };
    },
    async record(userId, input) {
      return repository.record(userId, input, async (tx) => {
        let original = await tx.findReview();
        if (original) return replay(original, input);
        await tx.lockCard();
        // Nueva instantánea tras esperar: otra solicitud pudo confirmar el repaso.
        original = await tx.findReview();
        if (original) return replay(original, input);
        const card = await tx.findCard();
        if (!card) throw new ReviewNotFoundError();
        const previous = await tx.findProgress();
        if (!previous && !card.completed) throw new ReviewForbiddenError();
        const reviewedAt = await tx.now();
        if (previous && previous.nextReviewAt > reviewedAt) throw new ReviewNotDueError();
        const state = previous || createInitialSm2State();
        const next = calculateSm2(state, input.quality, reviewedAt);
        await tx.saveProgress(next);
        return { ...await tx.insertReview(state, next), replayed: false };
      }, (original) => replay(original, input));
    },
  };
}
module.exports = { createReviewService, ReviewNotFoundError, ReviewForbiddenError,
  ReviewConflictError, ReviewNotDueError, ReviewsUnavailableError };
