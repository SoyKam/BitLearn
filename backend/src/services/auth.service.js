const bcrypt = require('bcryptjs');

// Conserva el costo 10 del ejemplo: hash asíncrono y límite de intentos en HTTP.
const PASSWORD_COST = 10;

class EmailAlreadyRegisteredError extends Error {}

function createAuthService(userRepository) {
  return {
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

module.exports = { createAuthService, EmailAlreadyRegisteredError };
