const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Pool } = require('pg');

// Nunca carga db.js ni .env: solo conecta a un clúster propio por socket privado.
const postgresBin = process.env.POSTGRES_BIN || '/usr/lib/postgresql/16/bin';
const available = ['initdb', 'pg_ctl'].every((file) => fs.existsSync(path.join(postgresBin, file)));
const postgresSkip = available ? false : 'Falta PostgreSQL local; define POSTGRES_BIN con la carpeta de initdb y pg_ctl.';

async function temporaryPostgres(t) {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'bitlearn-tests-'));
  const data = path.join(temporary, 'data');
  const socket = path.join(temporary, 'socket');
  fs.mkdirSync(socket, { mode: 0o700 });
  let started = false;
  let admin;
  t.after(async () => {
    try {
      if (admin) await admin.end();
    } finally {
      if (started) {
        execFileSync(path.join(postgresBin, 'pg_ctl'), ['-D', data, '-m', 'fast', '-w', 'stop'], { stdio: 'pipe' });
      }
      fs.rmSync(temporary, { recursive: true, force: true });
    }
  });

  execFileSync(path.join(postgresBin, 'initdb'), [
    '-D', data, '-U', 'bitlearn_test', '--auth=trust', '--no-locale', '--encoding=UTF8',
  ], { stdio: 'pipe' });
  execFileSync(path.join(postgresBin, 'pg_ctl'), [
    '-D', data, '-l', path.join(temporary, 'postgres.log'),
    '-o', `-h '' -k ${socket} -p 55439`, '-w', 'start',
  ], { stdio: 'pipe' });
  started = true;
  const connection = { host: socket, port: 55439, user: 'bitlearn_test', ssl: false, max: 1 };
  admin = new Pool({ ...connection, database: 'postgres' });
  let number = 0;

  async function database(context) {
    // Identificador generado por la prueba; nunca procede de entradas externas.
    const name = `isolated_test_${++number}`;
    await admin.query(`CREATE DATABASE ${name}`);
    const pool = new Pool({ ...connection, database: name });
    context.after(() => pool.end());
    return pool;
  }

  return { temporary, connection, database };
}

module.exports = { temporaryPostgres, postgresSkip };
