function createCourseController(courseService) {
  return {
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
