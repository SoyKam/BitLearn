// Telemetría prescindible de respuestas 429; nunca recibe req, tokens ni datos académicos.
function createEventQueue({ capacity = 256, delayMs = 100,
  write = line => new Promise((resolve, reject) => {
    process.stdout.write(line, error => error ? reject(error) : resolve());
  }),
} = {}) {
  if (!Number.isInteger(capacity) || capacity < 1 || !Number.isInteger(delayMs) || delayMs < 1) {
    throw new RangeError('Configuración de cola inválida');
  }
  const pending = [];
  let running = false;
  let timer;
  let dropped = 0;
  function schedule() {
    if (timer || running || !pending.length) return;
    // Como máximo diez escrituras/segundo por proceso con la configuración normal.
    timer = setTimeout(drain, delayMs);
    timer.unref();
  }
  async function drain() {
    timer = undefined;
    running = true;
    const line = pending.shift();
    try { await write(line); }
    catch { dropped++; } // Sin reintentos ni logs recursivos ante un consumidor averiado.
    finally { running = false; schedule(); }
  }
  return {
    enqueue({ correlationId, method }) {
      if (typeof correlationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(correlationId)) return false;
      if (pending.length + Number(running) >= capacity) { dropped++; return false; }
      // Lista explícita: no copiar campos adicionales, URL, IP ni encabezados.
      pending.push(JSON.stringify({ level: 'info', event: 'rate_limit_reached', correlation_id: correlationId,
        method: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'].includes(method) ? method : 'OTHER',
        status: 429 }) + '\n');
      schedule();
      return true;
    },
    get size() { return pending.length + Number(running); },
    get dropped() { return dropped; },
  };
}
module.exports = { createEventQueue, eventQueue: createEventQueue() };
