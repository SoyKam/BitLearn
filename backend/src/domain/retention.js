const DAY_MS = 86400000;
function calculateRetention(intervalDays, elapsedDays) {
  if (!Number.isInteger(intervalDays) || intervalDays < 0 || intervalDays > 2147483647)
    throw new RangeError('Intervalo inválido');
  if (!Number.isFinite(elapsedDays) || elapsedDays < 0) throw new RangeError('Tiempo inválido');
  return Math.exp(-elapsedDays / (Math.max(1, intervalDays) / Math.LN2));
}
function instant(date) {
  if (!(date instanceof Date) || !Number.isFinite(date.getTime())) throw new RangeError('Fecha inválida');
  return date.getTime();
}
// Probabilidades sin redondear. Todo instante se recibe explícitamente.
// Política de reloj: cualquier último repaso futuro se limita a tiempo transcurrido cero.
function projectRetention(states, asOf, horizons = [0, 1, 3, 7, 14, 30]) {
  const now = instant(asOf);
  if (!Array.isArray(states) || !Array.isArray(horizons)) throw new TypeError('Colección inválida');
  for (const day of horizons) if (!Number.isInteger(day) || day < 0 || day > 2147483647) throw new RangeError('Horizonte inválido');
  const cards = states.filter(state => state.lastReviewAt !== null).map(state => {
    const elapsed = Math.max(0, (now - instant(state.lastReviewAt)) / DAY_MS);
    calculateRetention(state.intervalDays, elapsed);
    return { interval: state.intervalDays, elapsed };
  });
  return { modeledCards: cards.length, points: cards.length ? horizons.map(daysAhead => ({
    daysAhead, retention: cards.reduce((sum, card) => sum + calculateRetention(card.interval, card.elapsed + daysAhead), 0) / cards.length,
  })) : [] };
}
module.exports = { calculateRetention, projectRetention };
