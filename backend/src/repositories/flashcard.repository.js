const { FlashcardsUnavailableError } = require('../services/flashcard.service');
const isPostgresUnavailable = require('../config/postgres-errors');

function createFlashcardRepository(database) {
  return {
    async findByCourseSlug(slug) {
      try {
        // Una sola instantánea distingue curso ausente de curso sin tarjetas.
        const { rows } = await database.query(`
          SELECT f.id, f.lesson_id, l.title AS lesson_title, f.position, f.front, f.back
          FROM public.courses c
          LEFT JOIN public.units u ON u.course_id = c.id
          LEFT JOIN public.lessons l ON l.unit_id = u.id
          LEFT JOIN public.flashcards f ON f.lesson_id = l.id
          WHERE c.slug = $1
          ORDER BY u.position ASC, l.position ASC, f.position ASC`, [slug]);
        return rows.length ? rows.filter((row) => row.id !== null) : null;
      } catch (error) {
        if (isPostgresUnavailable(error)) throw new FlashcardsUnavailableError();
        throw error;
      }
    },
  };
}
module.exports = createFlashcardRepository;
