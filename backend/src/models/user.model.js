const pool = require('../config/db');
const createUserRepository = require('../repositories/user.repository');
const { createAuthService } = require('../services/auth.service');
const authService = createAuthService(createUserRepository(pool));

const UserModel = {
  async findAll() {
    const { rows } = await pool.query(
      'SELECT id, name, email, created_at FROM users ORDER BY id'
    );
    return rows;
  },

  async findById(id) {
    const { rows } = await pool.query(
      'SELECT id, name, email, created_at FROM users WHERE id = $1',
      [id]
    );
    return rows[0] || null;
  },

  async findByEmail(email) {
    const { rows } = await pool.query(
      'SELECT * FROM users WHERE email = $1',
      [email]
    );
    return rows[0] || null;
  },

  async create({ name, email, password }) {
    // Adaptador heredado sin rutas públicas; única implementación de creación.
    return authService.register({ name, email, password });
  },

  async update(id, { name, email }) {
    const { rows } = await pool.query(
      'UPDATE users SET name = $1, email = $2 WHERE id = $3 RETURNING id, name, email, created_at',
      [name, email, id]
    );
    return rows[0] || null;
  },

  async delete(id) {
    const { rows } = await pool.query(
      'DELETE FROM users WHERE id = $1 RETURNING id',
      [id]
    );
    return rows[0] || null;
  },
};

module.exports = UserModel;
