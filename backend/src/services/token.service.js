const { randomBytes, createHash } = require('node:crypto');
const jwt = require('jsonwebtoken');

function createTokenService(config) {
  return {
    createRefreshToken() {
      const token = randomBytes(32).toString('base64url');
      const createdAt = new Date(Math.floor(Date.now() / 1000) * 1000);
      return {
        token,
        tokenHash: createHash('sha256').update(token).digest('hex'),
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
