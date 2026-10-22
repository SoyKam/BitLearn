function createValidateAuthOrigin({ trustedOrigins = [] } = {}) {
  const allowed = new Set(trustedOrigins);
  return function validateAuthOrigin(req, res, next) {
    const origin = req.get('origin');
    const site = req.get('sec-fetch-site');
    // No derivar confianza de Host/X-Forwarded-Host ni habilitar CORS con credenciales.
    // Clientes no navegador sin Origin/Fetch Metadata pueden usar la API.
    if ((origin !== undefined && !allowed.has(origin))
      || (origin === undefined && site !== undefined && site !== 'same-origin')) {
      return res.status(400).json({ success: false, message: 'Origen de solicitud no permitido.' });
    }
    next();
  };
}

module.exports = createValidateAuthOrigin;
