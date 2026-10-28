const { CatalogUnavailableError } = require('../services/course.service');

const unavailableCodes = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
  'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH',
  '08000', '08001', '08003', '08006', '08007',
  '53300', '57P01', '57P02', '57P03',
]);
// pg/pg-pool también emiten estos errores de conexión sin código.
const unavailableMessages = new Set([
  'Connection terminated unexpectedly',
  'Connection terminated due to connection timeout',
  'timeout exceeded when trying to connect',
  'timeout expired',
]);

function createCourseRepository(database) {
  async function query(...args) {
    try {
      return await database.query(...args);
    } catch (error) {
      // Traduce fallos de infraestructura al contrato de aplicación, sin HTTP.
      if (unavailableCodes.has(error.code) || unavailableMessages.has(error.message)) {
        throw new CatalogUnavailableError();
      }
      throw error;
    }
  }

  return {
    async findAll() {
      const { rows } = await query(
        'SELECT id, title, slug, description FROM public.courses ORDER BY title ASC, id ASC'
      );
      return rows;
    },
    async findBySlug(slug) {
      const { rows } = await query(
        'SELECT id, title, slug, description FROM public.courses WHERE slug = $1', [slug]
      );
      return rows[0] || null;
    },
    async findStructureByCourseId(courseId) {
      const { rows } = await query(`
        SELECT u.id AS unit_id, u.title AS unit_title, u.position AS unit_position,
               l.id AS lesson_id, l.title AS lesson_title, l.position AS lesson_position
        FROM public.units u
        LEFT JOIN public.lessons l ON l.unit_id = u.id
        WHERE u.course_id = $1
        ORDER BY u.position ASC, l.position ASC
      `, [courseId]);
      return rows;
    },
  };
}

module.exports = createCourseRepository;
