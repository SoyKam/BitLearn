async function checkDatabase() {
  let pool;

  try {
    pool = require('../src/config/db');

    // Este proceso CLI reemplaza el logger del pool para no exponer errores internos.
    pool.removeAllListeners('error');
    pool.on('error', () => {
      console.error('Error: se perdió la conexión con PostgreSQL.');
      process.exitCode = 1;
    });

    const { rows } = await pool.query({
      text: `
        SELECT current_database() AS database, ssl
        FROM pg_stat_ssl
        WHERE pid = pg_backend_pid()
      `,
      query_timeout: 5000,
    });
    const session = rows[0];

    if (!session || typeof session.database !== 'string' || !session.database) {
      console.error('Error: no se pudo identificar la base de datos y su sesión TLS.');
      process.exitCode = 1;
      return;
    }

    console.log(`Base de datos: ${JSON.stringify(session.database)}`);

    if (session.ssl !== true) {
      console.error('Error: TLS no está activo o no se pudo comprobar.');
      process.exitCode = 1;
      return;
    }

    if (!process.exitCode) {
      console.log('Conexión PostgreSQL correcta. TLS activo; certificado e identidad verificados.');
    }
  } catch {
    console.error('Error: no se pudo verificar PostgreSQL. Revisa las variables DB_*, la conectividad y el certificado TLS.');
    process.exitCode = 1;
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch {
        console.error('Error: no se pudo cerrar correctamente el pool de PostgreSQL.');
        process.exitCode = 1;
      }
    }
  }
}

checkDatabase();
