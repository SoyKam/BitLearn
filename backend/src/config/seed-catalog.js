class CatalogSeedError extends Error {}

// Los identificadores SQL son constantes internas; los valores siempre se parametrizan.
const entities = {
  courses: { columns: ['slug', 'title', 'description'], where: 'slug = $1' },
  units: {
    columns: ['course_id', 'position', 'title'],
    where: 'course_id = $1 AND (position = $2 OR title = $3)',
  },
  lessons: {
    columns: ['unit_id', 'position', 'title', 'content'],
    where: 'unit_id = $1 AND (position = $2 OR title = $3)',
  },
};

async function ensureRecord(client, table, values, label, results) {
  const { columns, where } = entities[table];
  const keys = table === 'courses' ? values.slice(0, 1) : values.slice(0, 3);
  const { rows } = await client.query(`SELECT * FROM public.${table} WHERE ${where}`, keys);
  if (rows.length) {
    // También rechaza el mismo título desplazado a otra posición dentro del padre.
    if (rows.length !== 1 || columns.some((column, index) => rows[0][column] !== values[index])) {
      throw new CatalogSeedError(`Conflicto en ${label}: la identidad, posición o contenido existente no coincide. Revisa los datos antes de reintentar; no se sobrescribió ningún registro.`);
    }
    results.push({ label, created: false });
    return rows[0].id;
  }
  const placeholders = values.map((_, index) => `$${index + 1}`).join(', ');
  const inserted = await client.query(
    `INSERT INTO public.${table} (${columns.join(', ')}) VALUES (${placeholders}) RETURNING id`, values
  );
  results.push({ label, created: true });
  return inserted.rows[0].id;
}

async function seedCatalog(pool) {
  let client;
  let discardClient = false;
  const results = [];
  try {
    // También controla errores de lectura o sintaxis del archivo de contenido.
    const catalog = require('../../database/seeds/001_web_catalog.json');
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '10s'");
    const { rows } = await client.query(`
      SELECT to_regclass('public.courses') AS courses,
             to_regclass('public.units') AS units,
             to_regclass('public.lessons') AS lessons
    `);
    if (!rows[0].courses || !rows[0].units || !rows[0].lessons) {
      throw new CatalogSeedError('Faltan tablas del catálogo. Aplica las migraciones 001, 002 y 003 antes de ejecutar el seed.');
    }
    // Carga manual pequeña: serializa seeds y bloquea escrituras ajenas mientras
    // se comprueba e inserta. Las lecturas normales siguen permitidas. Las claves
    // únicas y foráneas existentes siguen siendo la garantía final de integridad.
    await client.query('LOCK TABLE public.courses, public.units, public.lessons IN SHARE ROW EXCLUSIVE MODE');
    for (const course of catalog) {
      const courseId = await ensureRecord(client, 'courses',
        [course.slug, course.title, course.description], `curso ${course.slug}`, results);
      const unitId = await ensureRecord(client, 'units',
        [courseId, 1, course.unit.title], `unidad ${course.slug}/1`, results);
      for (const [index, lesson] of course.unit.lessons.entries()) {
        await ensureRecord(client, 'lessons', [unitId, index + 1, lesson.title, lesson.content],
          `lección ${course.slug}/1/${index + 1}`, results);
      }
    }
    await client.query('COMMIT');
    return results;
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch {
        discardClient = true;
      }
    }
    if (discardClient) {
      throw new CatalogSeedError('No se pudo confirmar el rollback; se descartó la conexión. Revisa el estado de la base antes de reintentar.');
    }
    if (error instanceof CatalogSeedError) throw error;
    // Nunca propaga mensajes de pg, que pueden contener valores o credenciales.
    throw new CatalogSeedError('No se pudo cargar el catálogo. Revisa el archivo del seed, conexión, permisos, esquema y bloqueos concurrentes.');
  } finally {
    if (client) client.release(discardClient);
  }
}

module.exports = { seedCatalog, CatalogSeedError };
