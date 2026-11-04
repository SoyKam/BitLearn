// Fragmento interno: alias p (estado) y lp (lección); nunca recibe entrada HTTP.
// El reloj opcional es una expresión SQL fija proporcionada por el repositorio.
function dueCondition(now = 'statement_timestamp()') {
  return `((p.flashcard_id IS NULL AND lp.completed_at IS NOT NULL)
    OR p.next_review_at <= ${now})`;
}
module.exports = dueCondition;
