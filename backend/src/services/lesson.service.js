const { z } = require('zod');

class LearningUnavailableError extends Error {}
class LearningInputError extends Error {}
class LearningNotFoundError extends Error {}

// La migración verifica longitud e índice; también validamos texto al leer/cargar.
const questionSchema = z.object({
  prompt: z.string().refine((value) => value.trim().length > 0),
  options: z.array(z.string().refine((value) => value.trim().length > 0)).min(2).max(6),
  correct_option_index: z.number().int().nonnegative(),
  explanation: z.string().nullable(),
}).refine((question) => question.correct_option_index < question.options.length);

function createLessonService(lessonRepository, progressRepository) {
  return {
    async detail(id) {
      const lesson = await lessonRepository.findById(id);
      if (!lesson) throw new LearningNotFoundError();
      const questions = await lessonRepository.findQuestions(id);
      return {
        id: lesson.id, title: lesson.title, content: lesson.content,
        course: { id: lesson.course_id, title: lesson.course_title, slug: lesson.course_slug },
        unit: { id: lesson.unit_id, title: lesson.unit_title },
        questions: questions.map((question) => {
          const { prompt, options } = questionSchema.parse(question);
          return { id: question.id, prompt, options };
        }),
      };
    },
    async answer(userId, lessonId, { questionId, optionIndex }) {
      const question = await lessonRepository.findQuestion(lessonId, questionId);
      if (!question) throw new LearningNotFoundError();
      const validated = questionSchema.parse(question);
      if (optionIndex >= validated.options.length) throw new LearningInputError();
      const correct = optionIndex === validated.correct_option_index;
      // MVP de una pregunta inicial por lección: cualquier acierto completa.
      // Los contadores agregados no verifican dominio de todas las preguntas.
      const progress = await progressRepository.recordAnswer(userId, lessonId, correct);
      return { correct, completed: progress.completedAt !== null,
        explanation: validated.explanation, progress };
    },
  };
}

module.exports = { createLessonService, questionSchema, LearningUnavailableError, LearningInputError, LearningNotFoundError };
