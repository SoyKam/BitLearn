class CatalogUnavailableError extends Error {}

function createCourseService(courseRepository) {
  return {
    async listCourses() {
      const courses = await courseRepository.findAll();
      // Lista pública explícita, incluso si el repositorio incorpora más campos.
      return courses.map(({ id, title, slug, description }) => ({ id, title, slug, description }));
    },
    async getCourseBySlug(slug) {
      const course = await courseRepository.findBySlug(slug);
      if (!course) return null;

      const rows = await courseRepository.findStructureByCourseId(course.id);
      const units = new Map();
      for (const row of rows) {
        if (!units.has(row.unit_id)) {
          units.set(row.unit_id, {
            id: row.unit_id, title: row.unit_title, position: row.unit_position, lessons: [],
          });
        }
        if (row.lesson_id !== null) {
          units.get(row.unit_id).lessons.push({
            id: row.lesson_id, title: row.lesson_title, position: row.lesson_position,
          });
        }
      }
      const { id, title, description } = course;
      return { id, title, slug: course.slug, description, units: [...units.values()] };
    },
  };
}

module.exports = { createCourseService, CatalogUnavailableError };
