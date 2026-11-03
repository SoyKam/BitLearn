const { z } = require('zod');
const { LearningInputError } = require('../services/lesson.service');

const idSchema = z.string().min(1).max(10).regex(/^[0-9]+$/)
  .refine((value) => !/[^0-9]/.test(value) && Number(value) > 0 && Number(value) <= 2147483647)
  .transform(Number);
const answerSchema = z.object({
  questionId: z.number().int().positive().max(2147483647),
  optionIndex: z.number().int().nonnegative().max(5),
}).strict();

function validateLessonId(req, res, next) {
  const result = idSchema.safeParse(req.params.id);
  if (!result.success) return next(new LearningInputError());
  req.lessonId = result.data;
  next();
}
function createLessonController(service) {
  return {
    async detail(req, res, next) {
      try { res.json({ success: true, data: await service.detail(req.lessonId) }); }
      catch (error) { next(error); }
    },
    async answer(req, res, next) {
      const result = answerSchema.safeParse(req.body);
      if (!result.success) return next(new LearningInputError());
      try {
        res.json({ success: true,
          data: await service.answer(req.auth.userId, req.lessonId, result.data) });
      } catch (error) { next(error); }
    },
  };
}
module.exports = { createLessonController, validateLessonId };
