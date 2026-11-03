function createLessonRepository(database) {
  return {
    async findById(id) {
      const { rows } = await database.query(`
        SELECT l.id, l.title, l.content, u.id AS unit_id, u.title AS unit_title,
               c.id AS course_id, c.title AS course_title, c.slug AS course_slug
        FROM public.lessons l
        JOIN public.units u ON u.id = l.unit_id
        JOIN public.courses c ON c.id = u.course_id
        WHERE l.id = $1`, [id]);
      return rows[0] || null;
    },
    async findQuestions(lessonId) {
      const { rows } = await database.query(`
        SELECT id, prompt, options, correct_option_index, explanation
        FROM public.questions WHERE lesson_id = $1 ORDER BY position ASC, id ASC`, [lessonId]);
      return rows;
    },
    async findQuestion(lessonId, questionId) {
      const { rows } = await database.query(`
        SELECT id, prompt, options, correct_option_index, explanation
        FROM public.questions WHERE lesson_id = $1 AND id = $2`, [lessonId, questionId]);
      return rows[0] || null;
    },
  };
}
module.exports = createLessonRepository;
