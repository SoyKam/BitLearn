
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const tls = require('tls');

require('dotenv').config();

const certificatePath = path.join(
  __dirname,
  '../../certs/bitlearn.crt'
);

// DATABASE_URL is the private, internal Render Postgres connection string.
// Keep the existing verified TLS path for local development and Codespaces.
const connection = process.env.RENDER === 'true' && process.env.DATABASE_URL
  ? { connectionString: process.env.DATABASE_URL, ssl: false }
  : {
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,

  ssl: {
    ca: fs.readFileSync(certificatePath, 'utf8'),
    rejectUnauthorized: true,

    checkServerIdentity: (_hostname, cert) => {
      return tls.checkServerIdentity(
        'bitlearn.internal',
        cert
      );
    },
  },

};

const pool = new Pool({
  ...connection,
  connectionTimeoutMillis: 10000,
  // Cancelación del servidor: no abandonar una consulta aún activa en el cliente.
  statement_timeout: 5000,
  lock_timeout: 3000,
});

pool.on('error', () => {
  console.error(JSON.stringify({ level: 'error', event: 'postgres_pool_error' }));
});

module.exports = pool;
