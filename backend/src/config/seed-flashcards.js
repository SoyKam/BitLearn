const { z } = require('zod');
const catalog = require('../../database/seeds/001_web_catalog.json');
class FlashcardSeedError extends Error {}
const text = z.string().refine((value) => value.trim().length > 0);
const positive = z.number().int().positive().max(2147483647);
const seedSchema = z.array(z.strictObject({
  courseSlug: z.enum(['html', 'css', 'javascript']),
  unitPosition: positive, unitTitle: text,
  lessonPosition: positive, lessonTitle: text,
  position: positive, front: text, back: text,
})).length(15);

function validateFlashcards(data) {
  const parsed = seedSchema.safeParse(data);
  if (!parsed.success) throw new FlashcardSeedError('Seed inválido: se requieren 15 tarjetas con campos válidos.');
  const positions = new Set();
  const fronts = new Set();
  for (const card of parsed.data) {
    const course = catalog.find((item) => item.slug === card.courseSlug);
    if (card.unitPosition !== 1 || card.unitTitle !== course.unit.title ||
        card.lessonTitle !== course.unit.lessons[card.lessonPosition - 1]?.title) {
      throw new FlashcardSeedError('La identidad de la lección no coincide con el catálogo.');
    }
    const parent = [card.courseSlug, card.unitPosition, card.lessonPosition];
    const position = JSON.stringify([...parent, card.position]);
    const front = JSON.stringify([...parent, card.front]);
    if (positions.has(position) || fronts.has(front)) {
      throw new FlashcardSeedError('Seed duplicado: posición o frente repetido dentro de una lección.');
    }
    positions.add(position);
    fronts.add(front);
  }
  for (const course of catalog) {
    const cards = parsed.data.filter((card) => card.courseSlug === course.slug);
    if (cards.length !== 5 || [1, 2, 3].some((lesson, index) =>
      cards.filter((card) => card.lessonPosition === lesson).length !== [2, 2, 1][index])) {
      throw new FlashcardSeedError('Se requieren cinco tarjetas por curso, distribuidas 2, 2 y 1 por lección.');
    }
  }
  return parsed.data;
}

async function seedFlashcards(pool, data) {
  let client;
  let discard = false;
  try {
    const flashcards = validateFlashcards(data ?? require('../../database/seeds/003_web_flashcards.json'));
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    // Mismo orden de tablas que seedCatalog; no crea ni modifica el catálogo.
    await client.query('LOCK TABLE public.courses, public.units, public.lessons IN SHARE MODE');
    await client.query('LOCK TABLE public.flashcards IN SHARE ROW EXCLUSIVE MODE');
    const results = [];
    for (const q of flashcards) {
      const identity = await client.query(`
        SELECT l.id FROM public.lessons l
        JOIN public.units u ON u.id = l.unit_id
        JOIN public.courses c ON c.id = u.course_id
        WHERE c.slug = $1 AND u.position = $2 AND u.title = $3
          AND l.position = $4 AND l.title = $5`,
      [q.courseSlug, q.unitPosition, q.unitTitle, q.lessonPosition, q.lessonTitle]);
      if (identity.rows.length !== 1) {
        throw new FlashcardSeedError('Falta una lección o su identidad no coincide con el catálogo esperado.');
      }
      const lessonId = identity.rows[0].id;
      const { rows } = await client.query(`SELECT position, front, back
        FROM public.flashcards WHERE lesson_id = $1 AND (position = $2 OR front = $3)`,
      [lessonId, q.position, q.front]);
      if (rows.length && (rows.length !== 1 || ['position', 'front', 'back']
        .some((key) => rows[0][key] !== q[key]))) {
        throw new FlashcardSeedError('Conflicto de flashcard: posición o contenido diferente. No se sobrescribió ningún registro.');
      }
      if (!rows.length) {
        await client.query(`INSERT INTO public.flashcards
          (lesson_id, position, front, back)
          VALUES ($1, $2, $3, $4)`,
        [lessonId, q.position, q.front, q.back]);
      }
      results.push({ label: `${q.courseSlug}/${q.unitPosition}/${q.lessonPosition}/${q.position}`, created: !rows.length });
    }
    await client.query('COMMIT');
    return results;
  } catch (error) {
    if (client) {
      try { await client.query('ROLLBACK'); } catch { discard = true; }
    }
    if (discard) throw new FlashcardSeedError('No se pudo confirmar rollback; se descartó la conexión.');
    if (error instanceof FlashcardSeedError) throw error;
    throw new FlashcardSeedError('No se pudieron cargar las flashcards. Revisa el seed, las migraciones 001 a 004, conexión y permisos.');
  } finally {
    if (client) client.release(discard);
  }
}
module.exports = { seedFlashcards, validateFlashcards, FlashcardSeedError };
