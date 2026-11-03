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

function isPostgresUnavailable(error) {
  return unavailableCodes.has(error.code) || unavailableMessages.has(error.message);
}
module.exports = isPostgresUnavailable;
