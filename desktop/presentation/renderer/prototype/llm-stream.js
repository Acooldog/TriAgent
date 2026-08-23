export function createStreamSession() {
  const controller = new AbortController();
  return { signal: controller.signal, abort: () => controller.abort() };
}

export function streamText(text, { session, delay = 45, chunkSize = 2, onChunk, onDone, onAbort }) {
  let index = 0;
  let finished = false;
  const finishAbort = () => {
    if (finished) return;
    finished = true;
    onAbort?.(index);
  };
  const timer = window.setInterval(() => {
    if (session.signal.aborted) { window.clearInterval(timer); finishAbort(); return; }
    index = Math.min(text.length, index + chunkSize);
    onChunk?.(index);
    if (index >= text.length) { window.clearInterval(timer); finished = true; onDone?.(); }
  }, delay);
  session.signal.addEventListener("abort", () => { window.clearInterval(timer); finishAbort(); }, { once: true });
  return () => window.clearInterval(timer);
}

export async function retryConnection(connect, { session, maxAttempts = 5, delay = 650, onAttempt }) {
  let lastError;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    if (session.signal.aborted) throw new DOMException("Aborted", "AbortError");
    onAttempt?.(attempt, maxAttempts);
    try { return await connect(attempt, session.signal); } catch (error) { lastError = error; }
    if (attempt < maxAttempts) await new Promise((resolve, reject) => { const timer = window.setTimeout(resolve, delay); session.signal.addEventListener("abort", () => { window.clearTimeout(timer); reject(new DOMException("Aborted", "AbortError")); }, { once: true }); });
  }
  throw lastError;
}
