const { randomBytes, createHash } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { z } = require('zod');

const identifier = z.string().regex(/^[1-9][0-9]{0,9}$/)
  .refine((value) => Number(value) <= 2147483647);
const claimsSchema = z.object({
  sub: identifier, sid: identifier,
  iat: z.number().int().nonnegative(), exp: z.number().int().positive(),
  iss: z.string(), aud: z.string(),
});

function hashRefreshToken(token) {
  // Solo la representación canónica de los 32 bytes emitidos por este servicio.
  if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(token)
    || Buffer.from(token, 'base64url').toString('base64url') !== token) return null;
  return createHash('sha256').update(token).digest('hex');
}

function createTokenService(config) {
  return {
    hashRefreshToken,
    verifyAccessToken(token) {
      let payload;
      try {
        payload = jwt.verify(token, config.signingKey, {
          algorithms: ['HS256'], issuer: config.issuer, audience: config.audience,
        });
      } catch {
        return null;
      }
      const result = claimsSchema.safeParse(payload);
      if (!result.success) return null;
      const claims = result.data;
      if (claims.iat > Math.floor(Date.now() / 1000) || claims.exp <= claims.iat
        || claims.exp - claims.iat > config.accessTokenSeconds) return null;
      return { userId: Number(claims.sub), sessionId: Number(claims.sid) };
    },
    createRefreshToken() {
      const token = randomBytes(32).toString('base64url');
      const createdAt = new Date(Math.floor(Date.now() / 1000) * 1000);
      return {
        token,
        tokenHash: hashRefreshToken(token),
        createdAt,
        expiresAt: new Date(createdAt.getTime() + config.refreshTokenSeconds * 1000),
      };
    },
    createAccessToken(userId, sessionId) {
      return {
        accessToken: jwt.sign({ sid: String(sessionId) }, config.signingKey, {
          algorithm: 'HS256',
          subject: String(userId),
          issuer: config.issuer,
          audience: config.audience,
          expiresIn: config.accessTokenSeconds,
        }),
        expiresIn: config.accessTokenSeconds,
      };
    },
  };
}

module.exports = createTokenService;
