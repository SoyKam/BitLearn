function createUserRepository(database) {
  return {
    async findPublicById(id) {
      const { rows } = await database.query(
        'SELECT id, name, email, created_at FROM public.users WHERE id = $1', [id]
      );
      return rows[0] || null;
    },
    async findByEmail(email) {
      const { rows } = await database.query(
        'SELECT id, name, email, password FROM public.users WHERE email = $1', [email]
      );
      return rows[0] || null;
    },
    async create({ name, email, passwordHash }) {
      try {
        const { rows } = await database.query(
          'INSERT INTO public.users (name, email, password) VALUES ($1, $2, $3) RETURNING id, name, email, created_at',
          [name, email, passwordHash]
        );
        return rows[0];
      } catch (error) {
        // La restricción de 001 es la garantía incluso con INSERT simultáneos.
        // No confundir conflictos de otras claves (por ejemplo la PK) con email.
        if (error.code === '23505' && error.constraint === 'users_email_key') return null;
        throw error;
      }
    },
  };
}

module.exports = createUserRepository;
