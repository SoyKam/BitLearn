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
  return {
    async findAll() {
      try {
        const { rows } = await database.query(
          'SELECT id, title, slug, description FROM public.courses ORDER BY title ASC, id ASC'
        );
        return rows;
      } catch (error) {
        // Traduce fallos de infraestructura al contrato de aplicación, sin HTTP.
        if (unavailableCodes.has(error.code) || unavailableMessages.has(error.message)) {
          throw new CatalogUnavailableError();
        }
        throw error;
      }
    },
  };
}

module.exports = createCourseRepository;
