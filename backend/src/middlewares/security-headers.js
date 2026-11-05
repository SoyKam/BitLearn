function securityHeaders(req, res, next) {
  res.set({
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'X-Frame-Options': 'DENY',
    // No restringe scripts/estilos de Swagger ni el desarrollo Vue/Vite.
    'Content-Security-Policy': "frame-ancestors 'none'; base-uri 'none'; object-src 'none'",
  });
  next();
}
module.exports = securityHeaders;
