import { loadManifold } from './loadManifold';
import { ops, type OpName } from './ops';

/**
 * Geometry worker: runs heavy Manifold operations off the main thread, so
 * the page stays responsive (the view keeps turning) while they compute.
 */
const ready = loadManifold();

interface WorkerScope {
  onmessage: ((e: MessageEvent<{ id: number; op: OpName; args: unknown }>) => void) | null;
  postMessage(message: unknown, transfer?: Transferable[]): void;
}
const scope = self as unknown as WorkerScope;

/** Every ArrayBuffer in the result, handed back without copying. */
function buffers(value: unknown, out: Set<ArrayBuffer> = new Set()): Set<ArrayBuffer> {
  if (ArrayBuffer.isView(value)) out.add(value.buffer as ArrayBuffer);
  else if (Array.isArray(value)) for (const v of value) buffers(v, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) buffers(v, out);
  return out;
}

scope.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    const wasm = await ready;
    const fn = ops[op] as (w: typeof wasm, a: unknown) => unknown;
    const result = fn(wasm, args);
    scope.postMessage({ id, result }, [...buffers(result)]);
  } catch (err) {
    scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
