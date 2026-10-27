const assert = require('node:assert/strict');
const { test } = require('node:test');
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { seedCatalog, CatalogSeedError } = require('../src/config/seed-catalog');

for (const rollbackFails of [false, true]) {
  test(`error de consulta: rollback, mensaje seguro y release(${rollbackFails})`, async () => {
    const calls = [];
    const client = {
      async query(sql) {
        calls.push(sql);
        if (sql === 'BEGIN') return;
        if (sql === 'ROLLBACK' && !rollbackFails) return;
        throw new Error('password=secreto-ficticio');
      },
      release(discard) { calls.push(['release', discard]); },
    };
    await assert.rejects(seedCatalog({ async connect() { return client; } }), (error) => {
      assert.ok(error instanceof CatalogSeedError);
      assert.doesNotMatch(error.message, /secreto-ficticio|password/);
      assert.match(error.message, rollbackFails ? /descartó la conexión/ : /No se pudo cargar/);
      return true;
    });
    assert.equal(calls.at(-2), 'ROLLBACK');
    assert.deepEqual(calls.at(-1), ['release', rollbackFails]);
    assert.ok(!calls.includes('COMMIT'));
  });
}

test('fallo al adquirir cliente devuelve error seguro', async () => {
  await assert.rejects(seedCatalog({ async connect() { throw new Error('credencial-ficticia'); } }), (error) => {
    assert.ok(error instanceof CatalogSeedError);
    assert.doesNotMatch(error.message, /credencial-ficticia/);
    return true;
  });
});

for (const failure of ['configuration', 'catalog', 'connect', 'begin', 'query', 'commit', 'rollback', 'end', 'idle']) {
  test(`CLI: fallo ${failure} termina con 1, oculta detalles y cierra recursos`, () => {
    // Proceso separado con dobles en require.cache: nunca evalúa db.js ni lee .env.
    const code = `
      const { EventEmitter } = require('node:events');
      const failure = ${JSON.stringify(failure)};
      const secret = () => { throw new Error('secreto-ficticio'); };
      const pool = new EventEmitter();
      pool.connect = async () => {
        if (failure === 'connect') secret();
        if (failure === 'idle') pool.emit('error', new Error('secreto-ficticio'));
        return {
          async query(sql) {
            if (sql === 'ROLLBACK') {
              if (failure === 'rollback') secret();
              return;
            }
            if ((sql === 'BEGIN' && failure === 'begin') || (sql === 'COMMIT' && failure === 'commit')) secret();
            if (sql === 'BEGIN' || sql.startsWith('SET LOCAL') || sql.startsWith('LOCK TABLE') || sql === 'COMMIT') return;
            if (failure === 'query' || failure === 'rollback') secret();
            if (sql.includes('to_regclass')) return { rows: [{ courses: 'courses', units: 'units', lessons: 'lessons' }] };
            if (sql.startsWith('SELECT')) return { rows: [] };
            return { rows: [{ id: 10 }] };
          },
          release(discard) { console.log('released:' + discard); }
        };
      };
      pool.end = async () => { console.log('pool-ended'); if (failure === 'end') secret(); };
      const entry = {};
      Object.defineProperty(entry, 'exports', { get() { if (failure === 'configuration') secret(); return pool; } });
      require.cache[${JSON.stringify(require.resolve('../src/config/db'))}] = entry;
      if (failure === 'catalog') {
        const catalogEntry = {};
        Object.defineProperty(catalogEntry, 'exports', { get: secret });
        require.cache[${JSON.stringify(require.resolve('../database/seeds/001_web_catalog.json'))}] = catalogEntry;
      }
      require(${JSON.stringify(path.join(__dirname, '../scripts/seed-catalog.js'))});
    `;
    const result = spawnSync(process.execPath, ['-e', code], {
      encoding: 'utf8', timeout: 10000, env: { ...process.env, NODE_OPTIONS: '' },
    });
    assert.ifError(result.error);
    assert.equal(result.status, 1);
    assert.doesNotMatch(result.stderr, /secreto-ficticio|password|postgresql:\/\//);
    if (failure !== 'configuration') assert.match(result.stdout, /pool-ended/);
    if (!['configuration', 'catalog', 'connect'].includes(failure)) {
      assert.match(result.stdout, new RegExp(`released:${failure === 'rollback'}`));
    }
    if (['catalog', 'begin', 'query', 'commit', 'rollback', 'connect'].includes(failure)) assert.doesNotMatch(result.stdout, /Creado:|Ya existía:/);
  });
}
