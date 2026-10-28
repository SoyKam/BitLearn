const { z } = require('zod');

const slugSchema = z.string().min(1).max(150).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
  // En JavaScript, $ también puede coincidir antes de un salto de línea final.
  .refine((value) => !/\s/u.test(value));

function createCourseController(courseService) {
  return {
    async detail(req, res, next) {
      const result = slugSchema.safeParse(req.params.slug);
      if (!result.success) {
        return res.status(400).json({ success: false, message: 'Slug de curso inválido.' });
      }
      try {
        const course = await courseService.getCourseBySlug(result.data);
        if (!course) {
          return res.status(404).json({ success: false, message: 'Curso no encontrado.' });
        }
        res.status(200).json({ success: true, data: course });
      } catch (error) {
        next(error);
      }
    },
    async list(req, res, next) {
      try {
        const courses = await courseService.listCourses();
        res.status(200).json({ success: true, data: courses });
      } catch (error) {
        next(error);
      }
    },
  };
}

module.exports = createCourseController;
