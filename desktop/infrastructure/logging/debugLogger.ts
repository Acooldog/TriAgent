/** Infrastructure-level debug logging with redaction.
 *
 * Moved from application/ because this is a cross-cutting technical concern
 * (console output + sensitive-field redaction), not business logic. Both
 * Application and Presentation layers may depend on it.
 */
type DebugValue = Record<string, unknown> | unknown[] | string | number | boolean | null | undefined;

const SENSITIVE_KEY = /api[-_]?key|authorization|token|secret|cookie|credential|password|private[-_]?key/i;
const SENSITIVE_TEXT = /(bearer\s+|authorization\s*[:=]|api[-_]?key\s*[:=]|token\s*[:=]|secret\s*[:=]|cookie\s*[:=])\S+/gi;

export function debugInfo(scope: string, event: string, payload?: DebugValue): void { console.info(`[TriMusicAgent][${scope}] ${event}`, sanitize(payload)); }
export function debugWarn(scope: string, event: string, payload?: DebugValue): void { console.warn(`[TriMusicAgent][${scope}] ${event}`, sanitize(payload)); }
export function debugError(scope: string, event: string, error?: unknown, payload?: DebugValue): void { console.error(`[TriMusicAgent][${scope}] ${event}`, { error: safeError(error), payload: sanitize(payload) }); }

function sanitize(value: DebugValue, ancestors = new WeakSet<object>()): DebugValue {
  if (value === undefined || value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (typeof value === "string") return value.replace(SENSITIVE_TEXT, "[已脱敏]");
  if (ancestors.has(value)) return "[循环引用]";
  ancestors.add(value);
  const result = Array.isArray(value)
    ? value.map((item) => sanitize(item as DebugValue, ancestors))
    : Object.fromEntries(Object.entries(value).map(([key, item]) => [key, SENSITIVE_KEY.test(key) && typeof item === "string" ? "[已脱敏]" : sanitize(item as DebugValue, ancestors)]));
  ancestors.delete(value);
  return result;
}

function safeError(error: unknown): Record<string, unknown> { return error instanceof Error ? { name: error.name, message: error.message.replace(SENSITIVE_TEXT, "[已脱敏]") } : { value: sanitize(error as DebugValue) }; }
