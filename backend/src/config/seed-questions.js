const { z } = require('zod');
const { questionSchema } = require('../services/lesson.service');
class QuestionSeedError extends Error {}
const seedSchema = z.array(questionSchema.safeExtend({
  courseSlug: z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/),
  unitPosition: z.number().int().positive(), unitTitle: z.string().min(1),
  lessonPosition: z.number().int().positive(), lessonTitle: z.string().min(1),
  position: z.number().int().positive(),
}));

async function seedQuestions(pool) {
  let client;
  let discard = false;
  try {
    const questions = seedSchema.parse(require('../../database/seeds/002_web_questions.json'));
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    // Mismo orden de tablas que seedCatalog; no crea ni modifica el catálogo.
    await client.query('LOCK TABLE public.courses, public.units, public.lessons IN SHARE MODE');
    await client.query('LOCK TABLE public.questions IN SHARE ROW EXCLUSIVE MODE');
    const results = [];
    for (const q of questions) {
      const identity = await client.query(`
        SELECT l.id FROM public.lessons l
        JOIN public.units u ON u.id = l.unit_id
        JOIN public.courses c ON c.id = u.course_id
        WHERE c.slug = $1 AND u.position = $2 AND u.title = $3
          AND l.position = $4 AND l.title = $5`,
      [q.courseSlug, q.unitPosition, q.unitTitle, q.lessonPosition, q.lessonTitle]);
      if (identity.rows.length !== 1) {
        throw new QuestionSeedError('Falta una lección o su identidad no coincide con el catálogo esperado.');
      }
      const lessonId = identity.rows[0].id;
      const { rows } = await client.query(`SELECT position, prompt, options, correct_option_index, explanation
        FROM public.questions WHERE lesson_id = $1 AND (position = $2 OR prompt = $3)`,
      [lessonId, q.position, q.prompt]);
      if (rows.length && (rows.length !== 1 || ['position', 'prompt', 'correct_option_index', 'explanation']
        .some((key) => rows[0][key] !== q[key]) || JSON.stringify(rows[0].options) !== JSON.stringify(q.options))) {
        throw new QuestionSeedError('Conflicto de pregunta: posición o contenido diferente. No se sobrescribió ningún registro.');
      }
      if (!rows.length) {
        await client.query(`INSERT INTO public.questions
          (lesson_id, position, prompt, options, correct_option_index, explanation)
          VALUES ($1, $2, $3, $4::jsonb, $5, $6)`,
        [lessonId, q.position, q.prompt, JSON.stringify(q.options), q.correct_option_index, q.explanation]);
      }
      results.push({ label: `${q.courseSlug}/${q.unitPosition}/${q.lessonPosition}/${q.position}`, created: !rows.length });
    }
    await client.query('COMMIT');
    return results;
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
    }
    if (discard) throw new QuestionSeedError('No se pudo confirmar rollback; se descartó la conexión.');
    if (error instanceof QuestionSeedError) throw error;
    throw new QuestionSeedError('No se pudieron cargar las preguntas. Revisa el seed, las migraciones 001 a 004, conexión y permisos.');
  } finally {
    if (client) client.release(discard);
  }
}
module.exports = { seedQuestions, QuestionSeedError };
