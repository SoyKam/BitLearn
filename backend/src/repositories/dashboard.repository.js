const dueCondition = require('./review-eligibility');

function createDashboardRepository(database) {
  return {
    async findRetentionByUser(userId) {
      const { rows } = await database.query(`
        SELECT clock.as_of, p.interval_days, p.last_review_at, p.next_review_at
        FROM (SELECT statement_timestamp() AS as_of) clock
        LEFT JOIN public.user_card_progress p ON p.user_id = $1 AND p.last_review_at IS NOT NULL
        ORDER BY p.flashcard_id`, [userId]);
      return rows;
    },
    async findByUser(userId) {
      // Una sentencia, una instantánea y un reloj PostgreSQL. Las agregaciones
      // independientes evitan multiplicar lecciones por tarjetas o historial.
      const { rows } = await database.query(`
        WITH course_progress AS (
          SELECT c.id AS course_id, c.slug AS course_slug, c.title AS course_title,
            count(l.id) AS total_lessons,
            count(lp.completed_at) AS completed_lessons
          FROM public.courses c
          LEFT JOIN public.units u ON u.course_id = c.id
          LEFT JOIN public.lessons l ON l.unit_id = u.id
          LEFT JOIN public.user_lesson_progress lp ON lp.lesson_id = l.id AND lp.user_id = $1
          GROUP BY c.id
        ), summary AS (
          SELECT (SELECT count(*) FROM public.lessons) AS total_lessons,
            (SELECT count(*) FROM public.user_lesson_progress
              WHERE user_id = $1 AND completed_at IS NOT NULL) AS completed_lessons,
            (SELECT count(*) FROM public.user_card_progress WHERE user_id = $1) AS studied_flashcards,
            (SELECT count(*) FROM public.card_reviews WHERE user_id = $1) AS total_reviews,
            (SELECT count(*) FROM public.flashcards f
              LEFT JOIN public.user_card_progress p ON p.flashcard_id = f.id AND p.user_id = $1
              LEFT JOIN public.user_lesson_progress lp ON lp.lesson_id = f.lesson_id AND lp.user_id = $1
              WHERE ${dueCondition()}) AS due_reviews
        )
        SELECT s.*, c.course_id, c.course_slug, c.course_title,
          c.total_lessons AS course_total_lessons, c.completed_lessons AS course_completed_lessons
        FROM summary s LEFT JOIN course_progress c ON true
        ORDER BY c.course_slug, c.course_id`, [userId]);
      return rows;
    },
  };
}
module.exports = createDashboardRepository;
