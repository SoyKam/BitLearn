const fs = require('node:fs/promises');
const path = require('node:path');

const migrationsDirectory = path.join(__dirname, '../../database/migrations');

async function runMigrations(pool, { directory = migrationsDirectory, log = console.log } = {}) {
  const files = (await fs.readdir(directory)).filter((file) => file.endsWith('.sql'));
  const versions = new Set();
  const migrations = [];

  for (const name of files) {
    const match = /^(\d+)_[a-z0-9_]+\.sql$/.exec(name);
    if (!match || BigInt(match[1]) === 0n) {
      throw new Error('Los archivos SQL deben usar una versión positiva y un nombre como 001_create_users.sql.');
    }
    const version = BigInt(match[1]).toString();
    if (versions.has(version)) {
      throw new Error(`Versión de migración duplicada: ${version}.`);
    }
    versions.add(version);
    migrations.push({ version, name, sql: await fs.readFile(path.join(directory, name), 'utf8') });
  }

  migrations.sort((a, b) => BigInt(a.version) < BigInt(b.version) ? -1 : 1);

  for (const migration of migrations) {
    let client;
    let discardClient = false;
    let applied = false;
    try {
      client = await pool.connect();
      await client.query('BEGIN');
      await client.query('SET LOCAL search_path TO public');
      // La misma clave serializa a todos los migradores de BitLearn en esta BD.
      // Se adquiere antes de crear/consultar el registro y se libera al terminar la transacción.
      await client.query('SELECT pg_advisory_xact_lock(72615, 1)');
      await client.query(`
        CREATE TABLE IF NOT EXISTS public.schema_migrations (
          version TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          applied_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
        )
      `);
      const { rows } = await client.query(
        'SELECT name FROM public.schema_migrations WHERE version = $1',
        [migration.version]
      );

      if (rows.length && rows[0].name !== migration.name) {
        throw new Error('El nombre registrado no coincide; restaura el archivo original de esta versión.');
      }
      if (!rows.length) {
        await client.query(migration.sql);
        await client.query(
          'INSERT INTO public.schema_migrations (version, name) VALUES ($1, $2)',
          [migration.version, migration.name]
        );
        applied = true;
      }
      await client.query('COMMIT');
    } catch (error) {
      if (client) {
        try {
          await client.query('ROLLBACK');
        } catch {
          discardClient = true;
        }
      }
      // No imprimir mensajes de pg: pueden incluir valores de filas o credenciales.
      const reason = error.code === 'BL001'
        ? 'users tiene una estructura incompatible; revisa tipos, obligatoriedad, clave primaria, autoincremento, unicidad de email y fecha predeterminada.'
        : 'revisa la conexión, los permisos, el SQL y que el nombre coincida con el registro de versiones.';
      throw new Error(`No se pudo aplicar ${migration.name}: ${reason}`);
    } finally {
      if (client) client.release(discardClient);
    }
    log(`${applied ? 'Aplicada' : 'Omitida (ya aplicada)'}: ${migration.name}`);
  }
  if (!migrations.length) log('No hay migraciones SQL.');
}

module.exports = runMigrations;
