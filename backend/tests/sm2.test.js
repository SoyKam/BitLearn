const assert = require('node:assert/strict');
const { describe, test } = require('node:test');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const vm = require('node:vm');
const { calculateSm2, createInitialSm2State, Sm2ValidationError } = require('../src/domain/sm2');

const reviewedAt = new Date('2026-11-03T12:00:00.000Z');
const initial = Object.freeze(createInitialSm2State());
const evaluate = (state, quality = 4, date = reviewedAt) => calculateSm2(state, quality, date);
function sequence(qualities, start = initial) {
  let state = start;
  let date = reviewedAt;
  return qualities.map((quality) => {
    state = evaluate(state, quality, date);
    date = new Date(state.nextReviewAt);
    return state;
  });
}

describe('factor de facilidad', () => {
  test('estado inicial independiente con factor 2.5', () => {
    assert.deepEqual(createInitialSm2State(), { repetitions: 0, easeFactor: 2.5, intervalDays: 0 });
    const a = createInitialSm2State();
    a.easeFactor = 7;
    assert.deepEqual(createInitialSm2State(), initial);
  });
  for (const [quality, expected] of [1.7, 1.96, 2.18, 2.36, 2.5, 2.6].entries()) {
    test(`calidad ${quality}: EF 2.5 pasa a ${expected}`, () => {
      assert.equal(evaluate(initial, quality).easeFactor, expected);
    });
  }
  test('mínimo 1.3 incluso tras múltiples fallos (D)', () => {
    const results = sequence([2, 1, 0, 3, 0], { ...initial, easeFactor: 1.3001 });
    assert.deepEqual(results.map((s) => s.easeFactor), [1.3, 1.3, 1.3, 1.3, 1.3]);
  });
  test('conserva cuatro decimales y evita acumulación de errores', () => {
    assert.equal(evaluate({ ...initial, easeFactor: 2.3456 }, 3).easeFactor, 2.2056);
    assert.deepEqual(sequence([5, 5, 3, 5]).map((s) => s.easeFactor), [2.6, 2.7, 2.56, 2.66]);
    let state = { ...initial, easeFactor: 1.3001 };
    for (let i = 0; i < 1000; i++) {
      state = evaluate({ ...state, repetitions: 0, intervalDays: 0 }, 5);
    }
    assert.equal(state.easeFactor, 101.3001);
    // Contrato normalizado: no se redondean silenciosamente entradas inválidas.
    for (const easeFactor of [2.34564, 2.34565, 2.34566, 2.6000000000000005]) {
      assert.throws(() => evaluate({ ...initial, easeFactor }), Sm2ValidationError);
    }
  });
});

describe('repeticiones e intervalos', () => {
  test('buen recuerdo 4 → 4 → 4 → 4 (A)', () => {
    const results = sequence([4, 4, 4, 4]);
    assert.deepEqual(results.map((s) => s.repetitions), [1, 2, 3, 4]);
    assert.deepEqual(results.map((s) => s.intervalDays), [1, 6, 15, 38]);
    assert.deepEqual(results.map((s) => s.easeFactor), [2.5, 2.5, 2.5, 2.5]);
  });
  test('recuerdo excelente 5 → 5 → 5 → 5 usa EF anterior (B)', () => {
    const results = sequence([5, 5, 5, 5]);
    assert.deepEqual(results.map((s) => s.easeFactor), [2.6, 2.7, 2.8, 2.9]);
    assert.deepEqual(results.map((s) => s.intervalDays), [1, 6, 16, 45]);
    assert.deepEqual(results, sequence([5, 5, 5, 5]));
  });
  test('fallo y nueva primera repetición 4 → 4 → 2 → 4 (C)', () => {
    const results = sequence([4, 4, 2, 4]);
    assert.deepEqual(results.map((s) => s.repetitions), [1, 2, 0, 1]);
    assert.deepEqual(results.map((s) => s.intervalDays), [1, 6, 1, 1]);
    assert.deepEqual(results.map((s) => s.easeFactor), [2.5, 2.5, 2.18, 2.18]);
  });
  test('todas las calificaciones fallidas reinician y todas las satisfactorias incrementan', () => {
    for (const quality of [0, 1, 2]) {
      const result = evaluate({ repetitions: 12, intervalDays: 60, easeFactor: 2.5 }, quality);
      assert.equal(result.repetitions, 0);
      assert.equal(result.intervalDays, 1);
    }
    for (const quality of [3, 4, 5]) {
      assert.equal(evaluate({ repetitions: 12, intervalDays: 60, easeFactor: 2.5 }, quality).repetitions, 13);
    }
  });
  test('factor decreciente modifica futuros intervalos, no el intervalo actual', () => {
    const results = sequence([3, 3, 3, 3]);
    assert.deepEqual(results.map((s) => s.easeFactor), [2.36, 2.22, 2.08, 1.94]);
    assert.deepEqual(results.map((s) => s.intervalDays), [1, 6, 13, 27]);
    for (const quality of [3, 4, 5]) {
      assert.equal(evaluate({ repetitions: 2, intervalDays: 6, easeFactor: 2.5 }, quality).intervalDays, 15);
    }
  });
  test('redondea intervalos al entero cercano, empates hacia arriba', () => {
    for (const [easeFactor, expected] of [[2.4999, 2], [2.5, 3], [2.5001, 3]]) {
      assert.equal(evaluate({ repetitions: 2, intervalDays: 1, easeFactor }).intervalDays, expected);
    }
    assert.equal(evaluate({ repetitions: 3, intervalDays: 15, easeFactor: 2.5 }).intervalDays, 38);
  });
});

describe('fechas UTC y días de exactamente 24 horas', () => {
  for (const [state, from, expected] of [
    [initial, '2026-11-03T12:00:00.000Z', '2026-11-04T12:00:00.000Z'],
    [{ ...initial, repetitions: 1, intervalDays: 1 }, '2026-11-03T12:00:00.000Z', '2026-11-09T12:00:00.000Z'],
    [{ ...initial, repetitions: 2, intervalDays: 6 }, '2026-11-03T12:00:00.000Z', '2026-11-18T12:00:00.000Z'],
    [initial, '2026-11-30T12:00:00.123Z', '2026-12-01T12:00:00.123Z'],
    [initial, '2026-12-31T12:00:00.000Z', '2027-01-01T12:00:00.000Z'],
    [initial, '2028-02-28T12:00:00.000Z', '2028-02-29T12:00:00.000Z'],
    [initial, '2028-02-29T12:00:00.000Z', '2028-03-01T12:00:00.000Z'],
    [initial, '2026-02-28T12:00:00.000Z', '2026-03-01T12:00:00.000Z'],
  ]) {
    test(`${from} → ${expected}`, () => {
      const result = evaluate(state, 4, new Date(from));
      assert.equal(result.lastReviewAt, from);
      assert.equal(result.nextReviewAt, expected);
    });
  }
  test('zonas locales distintas y ambos cambios de horario de verano', () => {
    const script = `const { calculateSm2, createInitialSm2State } = require('./src/domain/sm2');
      console.log(JSON.stringify(['2026-03-08T06:30:00.000Z', '2026-11-01T05:30:00.000Z'].map(
        date => calculateSm2(createInitialSm2State(), 4, new Date(date)).nextReviewAt)));`;
    for (const TZ of ['UTC', 'America/New_York', 'Europe/Madrid', 'Asia/Tokyo']) {
      const output = execFileSync(process.execPath, ['-e', script], {
        cwd: `${__dirname}/..`, env: { ...process.env, TZ }, encoding: 'utf8',
      });
      assert.deepEqual(JSON.parse(output), ['2026-03-09T06:30:00.000Z', '2026-11-02T05:30:00.000Z']);
    }
  });
  test('rechaza fechas inválidas, tipos ambiguos y fechas anteriores al contrato', () => {
    for (const date of [undefined, null, 0, Infinity, '2026-11-03', 'incorrecta', {},
      new Date(NaN), new Date(Infinity), new Date(8640000000000001), new Date('0000-12-31T00:00:00Z')]) {
      assert.throws(() => calculateSm2(initial, 4, date), Sm2ValidationError);
    }
  });
  test('extremos temporales y desbordamiento de la suma', () => {
    assert.equal(evaluate(initial, 4, new Date('0001-01-01T00:00:00Z')).lastReviewAt, '0001-01-01T00:00:00.000Z');
    const latest = 8640000000000000;
    assert.equal(evaluate(initial, 4, new Date(latest - 86400000)).nextReviewAt, new Date(latest).toISOString());
    assert.throws(() => evaluate(initial, 4, new Date(latest - 86400000 + 1)), Sm2ValidationError);
    assert.throws(() => evaluate(initial, 4, new Date(latest)), Sm2ValidationError);
    assert.throws(() => evaluate({ repetitions: 2, intervalDays: 100000000, easeFactor: 1.3 }), Sm2ValidationError);
  });
});

describe('validación y límites de persistencia', () => {
  test('calidad estrictamente numérica y entera 0–5', () => {
    for (const quality of [-1, 6, 2.5, '4', null, undefined, NaN, Infinity, -Infinity, true, 4n, {}]) {
      assert.throws(() => calculateSm2(initial, quality, reviewedAt), Sm2ValidationError);
    }
  });
  test('objeto y campos obligatorios', () => {
    for (const state of [undefined, null, [], 'estado', 4, {},
      { easeFactor: 2.5, intervalDays: 0 }, { repetitions: 0, intervalDays: 0 },
      { repetitions: 0, easeFactor: 2.5 }]) {
      assert.throws(() => evaluate(state), Sm2ValidationError);
    }
  });
  for (const field of ['repetitions', 'intervalDays']) {
    test(`${field}: entero no negativo hasta 2147483647`, () => {
      for (const value of [-1, 0.1, 2147483648, Number.MAX_SAFE_INTEGER, '1', null, undefined, NaN, Infinity, true]) {
        assert.throws(() => evaluate({ ...initial, [field]: value }), Sm2ValidationError);
      }
      assert.doesNotThrow(() => evaluate({ ...initial, [field]: 2147483647 }, 0));
    });
  }
  test('factor finito y normalizado dentro de NUMERIC(8,4)', () => {
    for (const easeFactor of [1.2999, -1, 10000, 9999.99991, '2.5000', null, undefined, NaN, Infinity, -Infinity, true]) {
      assert.throws(() => evaluate({ ...initial, easeFactor }), Sm2ValidationError);
    }
    assert.equal(evaluate({ ...initial, easeFactor: 9999.9999 }).easeFactor, 9999.9999);
    assert.equal(evaluate({ ...initial, easeFactor: 9999.8999 }, 5).easeFactor, 9999.9999);
    assert.throws(() => evaluate({ ...initial, easeFactor: 9999.9 }, 5), Sm2ValidationError);
  });
  test('overflow del contador, producto del intervalo y factor sin mutaciones', () => {
    for (const [state, quality, message] of [
      [{ ...initial, repetitions: 2147483647 }, 4, /repetitions resultante/],
      [{ repetitions: 2, intervalDays: 2147483647, easeFactor: 9999.9999 }, 4, /intervalDays resultante/],
      [{ ...initial, easeFactor: 9999.9999 }, 5, /NUMERIC/],
    ]) {
      const before = { ...state };
      Object.freeze(state);
      assert.throws(() => evaluate(state, quality), (error) => error instanceof Sm2ValidationError && message.test(error.message));
      assert.deepEqual(state, before);
    }
  });
});

describe('pureza e independencia', () => {
  test('no muta entradas ni Date y devuelve objetos nuevos', () => {
    const date = Object.freeze(new Date(reviewedAt));
    const before = date.getTime();
    const a = evaluate(initial, 4, date);
    const b = evaluate(initial, 4, date);
    assert.deepEqual(a, b);
    assert.notEqual(a, b);
    a.easeFactor = 99;
    assert.equal(b.easeFactor, 2.5);
    assert.deepEqual(initial, createInitialSm2State());
    assert.equal(date.getTime(), before);
  });
  test('dos secuencias independientes desde el mismo estado (E)', () => {
    const bBefore = sequence([2, 3, 4]);
    const a = sequence([5, 5, 5]);
    const bAfter = sequence([2, 3, 4]);
    assert.deepEqual(bBefore, bAfter);
    assert.notDeepEqual(a, bAfter);
    assert.deepEqual(a.map((s) => s.intervalDays), [1, 6, 16]);
    assert.deepEqual(bAfter.map((s) => s.intervalDays), [1, 1, 6]);
    assert.deepEqual(bAfter.map((s) => s.easeFactor), [2.18, 2.04, 2.04]);
    assert.deepEqual(initial, createInitialSm2State());
  });
  test('se ejecuta aislado sin imports, PostgreSQL, Express, reloj, red ni aleatoriedad', () => {
    class ExplicitDate extends Date {
      constructor(...args) {
        assert.equal(args.length, 1, 'No consultar el reloj implícitamente');
        super(...args);
      }
      static now() { assert.fail('No consultar Date.now'); }
    }
    const math = Object.create(Math);
    math.random = () => assert.fail('No usar aleatoriedad');
    const sandbox = { module: { exports: {} }, Date: ExplicitDate, Math: math,
      console: { log() { assert.fail('No producir logs'); } } };
    vm.runInNewContext(fs.readFileSync(require.resolve('../src/domain/sm2'), 'utf8'), sandbox);
    const result = sandbox.module.exports.calculateSm2(initial, 4, new ExplicitDate(reviewedAt.getTime()));
    assert.deepEqual(JSON.parse(JSON.stringify(result)), evaluate(initial));
  });
});
