const { ReviewNotFoundError, ReviewForbiddenError, ReviewConflictError, ReviewNotDueError, ReviewsUnavailableError } = require('../services/review.service');
const { FlashcardsUnavailableError } = require('../services/flashcard.service');
const { EmailAlreadyRegisteredError, IncorrectCredentialsError, InvalidSessionError } = require('../services/auth.service');
const { CatalogUnavailableError } = require('../services/course.service');

const { LearningInputError, LearningNotFoundError, LearningUnavailableError } = require('../services/lesson.service');

function errorHandler(error, req, res, next) {
  if (res.headersSent) return next(error);
  const reviewErrors = [
    [ReviewNotFoundError, 404, 'Flashcard no encontrada.'],
    [ReviewForbiddenError, 403, 'Debes completar la lección antes de activar la tarjeta.'],
    [ReviewConflictError, 409, 'requestId ya utilizado con otros datos.'],
    [ReviewNotDueError, 409, 'La tarjeta todavía no está pendiente.'],
  ];
  for (const [type, status, message] of reviewErrors) {
    if (error instanceof type) return res.status(status).json({ success: false, message });
  }
  if (error instanceof LearningInputError) {
    return res.status(400).json({ success: false, message: 'Identificador o respuesta inválida.' });
  }
  if (error instanceof LearningNotFoundError) {
    return res.status(404).json({ success: false, message: 'Lección o pregunta no encontrada.' });
  }
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
  if (error instanceof ReviewsUnavailableError || error instanceof LearningUnavailableError || error instanceof FlashcardsUnavailableError) {
    return res.status(503).json({ success: false, message: 'El servicio no está disponible temporalmente.' });
  }
  return res.status(500).json({ success: false, message: 'No se pudo completar la solicitud.' });
}

module.exports = errorHandler;
