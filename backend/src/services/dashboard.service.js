const { projectRetention } = require('../domain/retention');
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
    async getRetention(userId) {
      const rows = await repository.findRetentionByUser(userId);
      const asOf = rows[0].as_of;
      const states = rows.filter(row => row.last_review_at !== null).map(row => ({
        intervalDays: row.interval_days, lastReviewAt: row.last_review_at,
      }));
      const projection = projectRetention(states, asOf);
      const points = projection.points.map(point => ({ daysAhead: point.daysAhead,
        estimatedRetentionPercent: Math.round(point.retention * 10000) / 100 }));
      const future = rows.filter(row => row.last_review_at !== null && row.next_review_at > asOf)
        .map(row => row.next_review_at.getTime());
      return { asOf: asOf.toISOString(), modeledCards: projection.modeledCards,
        averageRetentionNowPercent: points[0]?.estimatedRetentionPercent ?? null,
        nextScheduledReviewAt: future.length ? new Date(Math.min(...future)).toISOString() : null, points };
    },
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
