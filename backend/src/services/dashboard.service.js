class DashboardUnavailableError extends Error {}

function count(value) {
  if (!(typeof value === 'number' || (typeof value === 'string' && /^[0-9]+$/.test(value)))) {
    throw new Error('Contador inválido');
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error('Contador fuera de rango');
  return number;
}
function progress(total, completed) {
  const totalLessons = count(total);
  const completedLessons = count(completed);
  if (completedLessons > totalLessons) throw new Error('Progreso inconsistente');
  return { totalLessons, completedLessons,
    completionPercent: totalLessons === 0 ? 0 : Math.round((completedLessons / totalLessons) * 10000) / 100 };
}
function createDashboardService(repository) {
  return {
    async get(userId) {
      const rows = await repository.findByUser(userId);
      const first = rows[0];
      return {
        summary: { ...progress(first.total_lessons, first.completed_lessons),
          studiedFlashcards: count(first.studied_flashcards), dueReviews: count(first.due_reviews),
          totalReviews: count(first.total_reviews) },
        courses: rows.filter(row => row.course_id !== null).map(row => ({
          courseId: count(row.course_id), courseSlug: row.course_slug, courseTitle: row.course_title,
          ...progress(row.course_total_lessons, row.course_completed_lessons),
        })),
      };
    },
  };
}
module.exports = { createDashboardService, DashboardUnavailableError };
