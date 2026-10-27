const { seedCatalog, CatalogSeedError } = require('../src/config/seed-catalog');

async function main() {
  let pool;
  try {
    pool = require('../src/config/db');
    pool.removeAllListeners('error');
    pool.on('error', () => {
      console.error('Error: se perdió la conexión con PostgreSQL.');
      process.exitCode = 1;
    });
    const results = await seedCatalog(pool);
    // Se informa solo después de COMMIT; no presenta una carga revertida como exitosa.
    for (const { label, created } of results) {
      console.log(`${created ? 'Creado' : 'Ya existía'}: ${label}`);
    }
  } catch (error) {
    console.error(error instanceof CatalogSeedError
      ? `Error: ${error.message}`
      : 'Error: no se pudo cargar el seed o la configuración de PostgreSQL.');
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

main();
