import { loadManifold } from './loadManifold';
import { MeshStore, Missing } from './meshTransfer';
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

/** Meshes the page has sent, so later jobs can name them by id (see meshTransfer). */
const store = new MeshStore(4_000_000);

/** Every ArrayBuffer in the result, handed back without copying, except those in `keep`. */
function buffers(value: unknown, keep: Set<ArrayBufferLike>, out: Set<ArrayBuffer> = new Set()): Set<ArrayBuffer> {
  if (ArrayBuffer.isView(value)) {
    if (!keep.has(value.buffer)) out.add(value.buffer as ArrayBuffer);
  } else if (Array.isArray(value)) for (const v of value) buffers(v, keep, out);
  else if (value && typeof value === 'object') for (const v of Object.values(value)) buffers(v, keep, out);
  return out;
}

scope.onmessage = async (e) => {
  const { id, op, args } = e.data;
  try {
    const wasm = await ready;
    const used = new Set<number>();
    const input = store.hydrate(args, used);
    store.trim(used);
    const fn = ops[op] as (w: typeof wasm, a: unknown) => unknown;
    const result = fn(wasm, input);
    scope.postMessage({ id, result }, [...buffers(result, store.buffers())]);
  } catch (err) {
    if (err instanceof Missing) scope.postMessage({ id, missing: true });
    else scope.postMessage({ id, error: err instanceof Error ? err.message : String(err) });
  }
};
