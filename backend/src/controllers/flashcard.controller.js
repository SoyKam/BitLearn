const { z } = require('zod');
const querySchema = z.strictObject({
  course: z.string().min(1).max(150).regex(/^[a-z0-9]+(-[a-z0-9]+)*$/)
    .refine((value) => !/\s/u.test(value)),
});

function createFlashcardController(service) {
  return {
    async list(req, res, next) {
      const result = querySchema.safeParse(req.query);
      if (!result.success) {
        return res.status(400).json({ success: false, message: 'Parámetro course inválido.' });
      }
      try {
        const cards = await service.listByCourse(result.data.course);
        if (cards === null) return res.status(404).json({ success: false, message: 'Curso no encontrado.' });
        return res.status(200).json({ success: true, data: cards });
      } catch (error) { next(error); }
    },
  };
}
module.exports = createFlashcardController;
