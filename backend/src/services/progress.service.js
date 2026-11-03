function createProgressService(repository) {
  return {
    async get(userId) {
      const rows = await repository.findByUser(userId);
      const lessons = rows.filter((row) => row.lesson_id !== null).map((row) => ({
        lessonId: row.lesson_id, courseSlug: row.course_slug, attempts: row.attempts,
        correctAnswers: row.correct_answers, completedAt: row.completed_at,
      }));
      return { completedLessons: lessons.filter((lesson) => lesson.completedAt !== null).length,
        totalLessons: rows[0].total, lessons };
    },
  };
}
module.exports = createProgressService;
