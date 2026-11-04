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
