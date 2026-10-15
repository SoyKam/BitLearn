const pool = require('../config/db');

const HealthRepository = {
  async checkConnection() {
    await pool.query({ text: 'SELECT 1', query_timeout: 5000 });
  },
};

module.exports = HealthRepository;
