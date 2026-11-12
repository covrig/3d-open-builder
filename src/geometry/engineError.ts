/**
 * Whether an error thrown by the geometry engine means the engine itself is
 * broken (e.g. it ran out of memory), so every later job would fail too and
 * the worker has to be replaced. Kept apart so the worker and its client can
 * share it without importing each other.
 */
const FATAL = /out of memory|Cannot enlarge memory|memory access out of bounds|unreachable|Aborted\(|abort\(|table index is out of bounds|Array buffer allocation failed/i;

export function isFatalEngineError(err: unknown): boolean {
  if (typeof WebAssembly !== 'undefined' && err instanceof WebAssembly.RuntimeError) return true;
  const message = err instanceof Error ? err.message : String(err);
  return FATAL.test(message);
}
