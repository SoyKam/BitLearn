const bcrypt = require('bcryptjs');
const { randomBytes } = require('node:crypto');

// Conserva el costo 10 del ejemplo: hash asíncrono y límite de intentos en HTTP.
const PASSWORD_COST = 10;

class EmailAlreadyRegisteredError extends Error {}
class IncorrectCredentialsError extends Error {}
class InvalidSessionError extends Error {}

let dummyHash;
function getDummyHash() {
  // Se prepara una sola vez por proceso. Ambas rutas esperan la misma promesa.
  dummyHash ??= bcrypt.hash(randomBytes(32).toString('hex'), PASSWORD_COST);
  return dummyHash;
}

function createAuthService(userRepository, sessionRepository, tokenService) {
  return {
    async refresh(token) {
      const tokenHash = tokenService.hashRefreshToken(token);
      if (!tokenHash) throw new InvalidSessionError();
      const refresh = tokenService.createRefreshToken();
      const session = await sessionRepository.rotate(tokenHash, refresh.tokenHash);
      // Un resultado nulo puede incluir una revocación ya confirmada por reutilización.
      if (!session) throw new InvalidSessionError();
      return {
        ...tokenService.createAccessToken(session.userId, session.sessionId),
        refreshToken: refresh.token, refreshExpiresAt: session.expiresAt,
      };
    },
    async logout(token) {
      const tokenHash = tokenService.hashRefreshToken(token);
      if (tokenHash) await sessionRepository.revokeByTokenHash(tokenHash);
    },
    async authenticate(accessToken) {
      const identity = tokenService.verifyAccessToken(accessToken);
      if (!identity || !await sessionRepository.isActive(identity)) throw new InvalidSessionError();
      return identity;
    },
    async me({ userId }) {
      const user = await userRepository.findPublicById(userId);
      if (!user) throw new InvalidSessionError();
      return { id: user.id, name: user.name, email: user.email, created_at: user.created_at };
    },
    async login({ email, password }) {
      const fallbackHash = await getDummyHash();
      const user = await userRepository.findByEmail(email);
      const matches = await bcrypt.compare(password, user ? user.password : fallbackHash);
      if (!user || !matches) throw new IncorrectCredentialsError();

      const refresh = tokenService.createRefreshToken();
      const sessionId = await sessionRepository.create({ userId: user.id,
        tokenHash: refresh.tokenHash, createdAt: refresh.createdAt, expiresAt: refresh.expiresAt });
      // El repositorio solo retorna después de COMMIT. Nunca emitir antes.
      const access = tokenService.createAccessToken(user.id, sessionId);
      return {
        user: { id: user.id, name: user.name, email: user.email },
        ...access,
        refreshToken: refresh.token,
        refreshExpiresAt: refresh.expiresAt,
      };
    },
    // Recibe exclusivamente datos validados y normalizados por el middleware.
    async register({ name, email, password }) {
      const passwordHash = await bcrypt.hash(password, PASSWORD_COST);
      const user = await userRepository.create({ name, email, passwordHash });
      if (!user) throw new EmailAlreadyRegisteredError();
      // Lista explícita de campos públicos, incluso si cambia el repositorio.
      return { id: user.id, name: user.name, email: user.email, created_at: user.created_at };
    },
  };
}

module.exports = { createAuthService, EmailAlreadyRegisteredError, IncorrectCredentialsError, InvalidSessionError };
