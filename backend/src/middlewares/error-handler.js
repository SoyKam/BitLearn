const { EmailAlreadyRegisteredError, IncorrectCredentialsError } = require('../services/auth.service');

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
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
  return res.status(500).json({ success: false, message: 'No se pudo completar la solicitud.' });
}

module.exports = errorHandler;
