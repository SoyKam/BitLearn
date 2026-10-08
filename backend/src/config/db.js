
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');
const tls = require('tls');

require('dotenv').config();

const certificatePath = path.join(
  __dirname,
  '../../certs/bitlearn.crt'
);

const pool = new Pool({
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

  connectionTimeoutMillis: 10000,
});

pool.on('error', (err) => {
  console.error('Error en PostgreSQL:', err.message);
});

module.exports = pool;
