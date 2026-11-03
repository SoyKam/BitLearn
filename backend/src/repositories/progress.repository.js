function createProgressRepository(database) {
  return {
    async recordAnswer(userId, lessonId, correct) {
      // Un único statement: PostgreSQL bloquea la fila en conflicto y suma sobre
      // el valor actual. Cada solicitud confirmada cuenta, incluso un reintento HTTP.
      const { rows } = await database.query(`
        INSERT INTO public.user_lesson_progress AS p
          (user_id, lesson_id, attempts, correct_answers, completed_at)
        VALUES ($1, $2, 1, $3, CASE WHEN $3 = 1 THEN clock_timestamp() ELSE NULL END)
        ON CONFLICT (user_id, lesson_id) DO UPDATE SET
          attempts = p.attempts + 1,
          correct_answers = p.correct_answers + EXCLUDED.correct_answers,
          completed_at = COALESCE(p.completed_at, EXCLUDED.completed_at),
          updated_at = GREATEST(p.updated_at, clock_timestamp())
        RETURNING attempts, correct_answers AS "correctAnswers", completed_at AS "completedAt"`,
      [userId, lessonId, correct ? 1 : 0]);
      return rows[0];
    },
    async findByUser(userId) {
      // Total y progreso comparten el mismo snapshot, incluso si cambia el catálogo.
      const { rows } = await database.query(`
        SELECT (SELECT count(*)::integer FROM public.lessons) AS total,
               p.lesson_id, c.slug AS course_slug, p.attempts, p.correct_answers, p.completed_at
        FROM (SELECT $1::integer AS user_id) identity
        LEFT JOIN public.user_lesson_progress p ON p.user_id = identity.user_id
        LEFT JOIN public.lessons l ON l.id = p.lesson_id
        LEFT JOIN public.units u ON u.id = l.unit_id
        LEFT JOIN public.courses c ON c.id = u.course_id
        ORDER BY c.slug ASC, u.position ASC, l.position ASC, l.id ASC`, [userId]);
      return rows;
    },
  };
}
module.exports = createProgressRepository;
