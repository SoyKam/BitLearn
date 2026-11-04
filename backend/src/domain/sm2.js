const INTEGER_MAX = 2147483647;
const FACTOR_SCALE = 10000;
const FACTOR_MIN = 13000;
const FACTOR_MAX = 99999999;
const DAY_MS = 86400000n;
const DATE_MAX_MS = 8640000000000000n;
// Contrato del MVP: era común, también representable en TIMESTAMPTZ.
const DATE_MIN_MS = -62135596800000;

class Sm2ValidationError extends RangeError {
  constructor(message) {
    super(message);
    this.name = 'Sm2ValidationError';
  }
}

function validateInteger(value, field) {
  if (!Number.isInteger(value) || value < 0 || value > INTEGER_MAX) {
    throw new Sm2ValidationError(`${field} debe ser un INTEGER no negativo.`);
  }
}

function scaledFactor(value) {
  if (!Number.isFinite(value) || value < 1.3 || value > 9999.9999) {
    throw new Sm2ValidationError('easeFactor debe estar entre 1.3 y 9999.9999.');
  }
  const scaled = Math.round(value * FACTOR_SCALE);
  // El round-trip admite números decimales normalizados, no ruido ni truncamiento.
  if (scaled / FACTOR_SCALE !== value) {
    throw new Sm2ValidationError('easeFactor debe tener como máximo cuatro decimales.');
  }
  return scaled;
}

function createInitialSm2State() {
  return { repetitions: 0, easeFactor: 2.5, intervalDays: 0 };
}

/**
 * Estado numérico normalizado; reviewedAt es Date (desde 0001-01-01 UTC).
 * Devuelve un objeto nuevo con fechas ISO UTC. No modifica estado ni fecha.
 * Errores de entrada o desbordamiento: Sm2ValidationError, sin resultado parcial.
 */
function calculateSm2(previousState, quality, reviewedAt) {
  if (!previousState || typeof previousState !== 'object' || Array.isArray(previousState)) {
    throw new Sm2ValidationError('previousState debe ser un objeto de estado SM-2.');
  }
  const { repetitions, easeFactor, intervalDays } = previousState;
  validateInteger(repetitions, 'repetitions');
  validateInteger(intervalDays, 'intervalDays');
  const factor = scaledFactor(easeFactor);
  if (!Number.isInteger(quality) || quality < 0 || quality > 5) {
    throw new Sm2ValidationError('quality debe ser un entero entre 0 y 5.');
  }
  if (!(reviewedAt instanceof Date)) {
    throw new Sm2ValidationError('reviewedAt debe ser un objeto Date válido.');
  }
  const reviewedMs = Date.prototype.getTime.call(reviewedAt);
  if (!Number.isFinite(reviewedMs) || reviewedMs < DATE_MIN_MS) {
    throw new Sm2ValidationError('reviewedAt debe ser un instante válido desde el año 1 UTC.');
  }

  const nextRepetitions = quality < 3 ? 0 : repetitions + 1;
  validateInteger(nextRepetitions, 'repetitions resultante');
  let nextInterval = 1; // Política explícita del MVP: reaprendizaje al día siguiente.
  if (nextRepetitions === 2) nextInterval = 6;
  if (nextRepetitions >= 3) {
    // Factor ANTERIOR. BigInt evita perder precisión en productos grandes.
    // Redondeo al más cercano, empate positivo hacia arriba.
    nextInterval = Number((BigInt(intervalDays) * BigInt(factor) + 5000n) / 10000n);
  }
  validateInteger(nextInterval, 'intervalDays resultante');

  const distance = 5 - quality;
  // Fórmula EF + 0.1 - (5-q)*(0.08+(5-q)*0.02), en diezmilésimas.
  // La entrada tiene <=4 decimales y el ajuste 2: el resultado ya es exacto
  // a escala 4, sin dígitos descartados ni empates de redondeo del factor.
  const nextFactor = Math.max(FACTOR_MIN, factor + 1000 - distance * (800 + distance * 200));
  if (nextFactor > FACTOR_MAX) {
    throw new Sm2ValidationError('easeFactor resultante excede NUMERIC(8,4).');
  }

  const nextMs = BigInt(reviewedMs) + BigInt(nextInterval) * DAY_MS;
  if (nextMs > DATE_MAX_MS) {
    throw new Sm2ValidationError('nextReviewAt excede el rango de Date.');
  }
  return {
    repetitions: nextRepetitions,
    easeFactor: nextFactor / FACTOR_SCALE,
    intervalDays: nextInterval,
    lastReviewAt: new Date(reviewedMs).toISOString(),
    nextReviewAt: new Date(Number(nextMs)).toISOString(),
  };
}

module.exports = { calculateSm2, createInitialSm2State, Sm2ValidationError };
