function createSessionRepository(database) {
  async function transaction(work, begin = 'BEGIN') {
    const client = await database.connect();
    let releaseError;
    let committing = false;
    try {
      await client.query(begin);
      const result = await work(client);
      committing = true;
      await client.query('COMMIT');
      return result;
    } catch (error) {
      // Un fallo de COMMIT puede dejar un resultado desconocido: no reutilizar conexión.
      if (committing) releaseError = error;
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        releaseError = rollbackError;
      }
      throw error;
    } finally {
      client.release(releaseError);
    }
  }

  return {
    async create({ userId, tokenHash, createdAt, expiresAt }) {
      return transaction(async (client) => {
        const { rows } = await client.query(
          'INSERT INTO public.auth_sessions (user_id, created_at, expires_at) VALUES ($1, $2, $3) RETURNING id',
          [userId, createdAt, expiresAt]
        );
        const sessionId = rows[0].id;
        await client.query(
          'INSERT INTO public.auth_refresh_tokens (token_hash, session_id, created_at, expires_at) VALUES ($1, $2, $3, $4)',
          [tokenHash, sessionId, createdAt, expiresAt]
        );
        return sessionId;
      });
    },
    async rotate(tokenHash, nextTokenHash) {
      return transaction(async (client) => {
        // Serializa todas las renovaciones de una sesión, incluso con hashes distintos.
        const locked = await client.query(`
          SELECT id, user_id FROM public.auth_sessions
          WHERE id = (SELECT session_id FROM public.auth_refresh_tokens WHERE token_hash = $1)
          FOR UPDATE`, [tokenHash]);
        if (!locked.rows.length) return null;
        const session = locked.rows[0];
        // Consulta separada DESPUÉS del bloqueo: nueva instantánea READ COMMITTED.
        // Hora real posterior a la espera; no CURRENT_TIMESTAMP (inicio de transacción).
        // Fechas como texto preservan los microsegundos al volver a enviarlas a PostgreSQL.
        const { rows: [state] } = await client.query(`
          WITH instant AS MATERIALIZED (SELECT clock_timestamp() AS now)
          SELECT r.used_at, s.revoked_at, instant.now::text AS rotated_at,
            s.expires_at::text AS expires_at,
            (s.created_at <= instant.now AND r.created_at <= instant.now
              AND s.expires_at > instant.now AND r.expires_at > instant.now) AS valid
          FROM public.auth_refresh_tokens r
          JOIN public.auth_sessions s ON s.id = r.session_id CROSS JOIN instant
          WHERE r.token_hash = $1 AND s.id = $2`, [tokenHash, session.id]);
        if (!state) return null;
        if (state.used_at !== null) {
          await client.query(`UPDATE public.auth_sessions
            SET revoked_at = COALESCE(revoked_at, GREATEST(created_at, clock_timestamp()))
            WHERE id = $1`, [session.id]);
          // Retornar, no lanzar: transaction debe confirmar la revocación antes del 401.
          return null;
        }
        if (state.revoked_at !== null || !state.valid) return null;
        await client.query('UPDATE public.auth_refresh_tokens SET used_at = $1 WHERE token_hash = $2',
          [state.rotated_at, tokenHash]);
        const inserted = await client.query(`
          INSERT INTO public.auth_refresh_tokens (token_hash, session_id, created_at, expires_at)
          VALUES ($1, $2, $3, $4) RETURNING expires_at`,
        [nextTokenHash, session.id, state.rotated_at, state.expires_at]);
        return { sessionId: session.id, userId: session.user_id, expiresAt: inserted.rows[0].expires_at };
      }, 'BEGIN ISOLATION LEVEL READ COMMITTED');
    },
    async revokeByTokenHash(tokenHash) {
      // UPDATE toma el mismo bloqueo de sesión que rotate; una única sentencia es atómica.
      await database.query(`UPDATE public.auth_sessions
        SET revoked_at = COALESCE(revoked_at, GREATEST(created_at, clock_timestamp()))
        WHERE id = (SELECT session_id FROM public.auth_refresh_tokens WHERE token_hash = $1)`, [tokenHash]);
    },
    async isActive({ userId, sessionId }) {
      const { rows } = await database.query(`SELECT id FROM public.auth_sessions
        WHERE id = $1 AND user_id = $2 AND revoked_at IS NULL
          AND created_at <= clock_timestamp() AND expires_at > clock_timestamp()`, [sessionId, userId]);
      return rows.length === 1;
    },
  };
}

module.exports = createSessionRepository;
