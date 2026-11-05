const { randomUUID } = require('node:crypto');
const { eventQueue } = require('../queues/observability.queue');

function requestContext(req, res, next) {
  // Montado globalmente y también en routers reutilizables: un solo ID/listener.
  if (req.correlationId) return next();
  // ID generado por el servidor: nunca copiar encabezados arbitrarios a logs.
  req.correlationId = randomUUID();
  res.set('x-correlation-id', req.correlationId);
  res.once('finish', () => {
    if (res.statusCode === 429) eventQueue.enqueue({ correlationId: req.correlationId, method: req.method });
  });
  next();
}

module.exports = requestContext;
