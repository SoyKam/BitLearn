const runMigrations = require('../src/config/migrate');

async function migrate() {
  let pool;
  try {
    pool = require('../src/config/db');
    pool.removeAllListeners('error');
    pool.on('error', () => {
      console.error('Error: se perdió la conexión con PostgreSQL.');
      process.exitCode = 1;
    });
    await runMigrations(pool);
  } catch (error) {
    // Solo los errores controlados del migrador se muestran al usuario.
    const controlled = /^(No se pudo aplicar |Los archivos SQL deben |Versión de migración duplicada: )/;
    console.error(controlled.test(error.message)
      ? `Error: ${error.message}`
      : 'Error: no se pudieron cargar las migraciones o la configuración de PostgreSQL.');
    process.exitCode = 1;
  } finally {
    if (pool) {
      try {
        await pool.end();
      } catch {
        console.error('Error: no se pudo cerrar el pool de PostgreSQL.');
        process.exitCode = 1;
      }
    }
  }
}

migrate();
