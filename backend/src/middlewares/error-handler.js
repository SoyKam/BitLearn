const { EmailAlreadyRegisteredError, IncorrectCredentialsError, InvalidSessionError } = require('../services/auth.service');
const { CatalogUnavailableError } = require('../services/course.service');

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  if (error instanceof InvalidSessionError) {
    return res.status(401).json({ success: false, message: 'Sesión no válida.' });
  }
  if (error instanceof IncorrectCredentialsError) {
    return res.status(401).json({ success: false, message: 'Credenciales incorrectas.' });
  }
  if (error instanceof EmailAlreadyRegisteredError) {
    return res.status(409).json({ success: false, message: 'El correo ya está registrado.' });
  }
  // Errores del parser: no reflejar su mensaje, body ni stack.
  if (['entity.parse.failed', 'entity.too.large', 'encoding.unsupported',
    'charset.unsupported', 'request.aborted', 'request.size.invalid'].includes(error.type)) {
    return res.status(400).json({ success: false, message: 'El cuerpo debe ser JSON válido de hasta 4 KiB.' });
  }
  console.error(JSON.stringify({
    level: 'error', event: 'request_failed', correlation_id: req.correlationId,
  }));
  if (error instanceof CatalogUnavailableError) {
    return res.status(503).json({ success: false, message: 'El catálogo no está disponible temporalmente.' });
  }
  return res.status(500).json({ success: false, message: 'No se pudo completar la solicitud.' });
}

module.exports = errorHandler;
