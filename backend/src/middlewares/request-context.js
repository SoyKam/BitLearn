const { randomUUID } = require('node:crypto');

function requestContext(req, res, next) {
  // ID generado por el servidor: nunca copiar encabezados arbitrarios a logs.
  req.correlationId = randomUUID();
  res.set('x-correlation-id', req.correlationId);
  next();
}

module.exports = requestContext;
