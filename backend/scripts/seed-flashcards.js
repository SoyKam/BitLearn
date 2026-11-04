const { seedFlashcards, FlashcardSeedError } = require('../src/config/seed-flashcards');

async function main() {
  let pool;
  try {
    pool = require('../src/config/db');
    pool.removeAllListeners('error');
    pool.on('error', () => {
      console.error('Error: se perdió la conexión con PostgreSQL.');
      process.exitCode = 1;
    });
    const results = await seedFlashcards(pool);
    // Se informa solo después de COMMIT; no presenta una carga revertida como exitosa.
    const created = results.filter((result) => result.created).length;
    console.log(`${created} flashcards nuevas.\n${results.length - created} flashcards existentes.`);
  } catch (error) {
    console.error(error instanceof FlashcardSeedError
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

if (require.main === module) main();
