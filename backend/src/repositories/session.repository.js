function createSessionRepository(database) {
  return {
    async create({ userId, tokenHash, createdAt, expiresAt }) {
      const client = await database.connect();
      let releaseError;
      try {
        await client.query('BEGIN');
        const { rows } = await client.query(
          'INSERT INTO public.auth_sessions (user_id, created_at, expires_at) VALUES ($1, $2, $3) RETURNING id',
          [userId, createdAt, expiresAt]
        );
        const sessionId = rows[0].id;
        await client.query(
          'INSERT INTO public.auth_refresh_tokens (token_hash, session_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
          [tokenHash, sessionId, createdAt, expiresAt]
        );
        await client.query('COMMIT');
        return sessionId;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollbackError) {
          // Descartar una conexión cuyo estado transaccional ya no es fiable.
          releaseError = rollbackError;
        }
        throw error;
      } finally {
        client.release(releaseError);
      }
    },
  };
}

module.exports = createSessionRepository;
