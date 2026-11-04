class FlashcardsUnavailableError extends Error {}

function createFlashcardService(repository) {
  return {
    async listByCourse(slug) {
      const cards = await repository.findByCourseSlug(slug);
      if (cards === null) return null;
      return cards.map(({ id, lesson_id, lesson_title, position, front, back }) => ({
        id, lessonId: lesson_id, lessonTitle: lesson_title, position, front, back,
      }));
    },
  };
}
module.exports = { createFlashcardService, FlashcardsUnavailableError };
