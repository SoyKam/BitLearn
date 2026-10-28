class CatalogUnavailableError extends Error {}

function createCourseService(courseRepository) {
  return {
    async listCourses() {
      const courses = await courseRepository.findAll();
      // Lista pública explícita, incluso si el repositorio incorpora más campos.
      return courses.map(({ id, title, slug, description }) => ({ id, title, slug, description }));
    },
  };
}

module.exports = { createCourseService, CatalogUnavailableError };
