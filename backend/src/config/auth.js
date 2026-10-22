function loadAuthConfig(env = process.env) {
  // 32 bytes aleatorios codificados en hexadecimal, no una contraseña textual.
  const value = env.AUTH_JWT_SECRET_HEX;
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error('Configura AUTH_JWT_SECRET_HEX con 32 bytes criptográficamente aleatorios en hexadecimal.');
  }
  const signingKey = Buffer.from(value, 'hex');
  // Rechaza claves obviamente débiles; ningún test puede demostrar su origen aleatorio.
  if (new Set(signingKey).size < 16) {
    throw new Error('AUTH_JWT_SECRET_HEX no tiene suficiente diversidad; genera una clave aleatoria.');
  }
  for (const name of ['AUTH_JWT_ISSUER', 'AUTH_JWT_AUDIENCE']) {
    if (typeof env[name] !== 'string' || !/^[a-zA-Z0-9:._/-]{1,150}$/.test(env[name])) {
      throw new Error(`Configura ${name} con un identificador válido de hasta 150 caracteres.`);
    }
  }
  const allowHttp = env.AUTH_ALLOW_INSECURE_COOKIE;
  if (allowHttp !== undefined && !['true', 'false'].includes(allowHttp)) {
    throw new Error('AUTH_ALLOW_INSECURE_COOKIE debe ser true o false.');
  }
  if (allowHttp === 'true' && (env.NODE_ENV !== 'development' || env.CODESPACES === 'true')) {
    throw new Error('La cookie sin Secure solo se permite en desarrollo HTTP local, fuera de Codespaces.');
  }
  return Object.freeze({
    signingKey,
    issuer: env.AUTH_JWT_ISSUER,
    audience: env.AUTH_JWT_AUDIENCE,
    accessTokenSeconds: 15 * 60,
    refreshTokenSeconds: 7 * 24 * 60 * 60,
    cookieSecure: allowHttp !== 'true',
  });
}

module.exports = loadAuthConfig;
