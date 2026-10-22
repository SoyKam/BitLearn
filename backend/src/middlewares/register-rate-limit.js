const { rateLimit } = require('express-rate-limit');

function createRegisterRateLimit({ limit = 10, action = 'registro' } = {}) {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit,
    standardHeaders: 'draft-8',
    legacyHeaders: false,
    // Express conserva trust proxy=false: encabezados enviados por el cliente
    // no cambian la IP. Evitar avisos con datos ajenos al recibir esos encabezados.
    validate: { xForwardedForHeader: false, forwardedHeader: false },
    message: { success: false, message: `Demasiados intentos de ${action}. Inténtalo más tarde.` },
  });
}

module.exports = createRegisterRateLimit;
