import type { OpArgs, OpName, OpResult } from './ops';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; quiet: boolean };

let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();
const listeners = new Set<(busy: boolean) => void>();

function notify(): void {
  // Quiet work (e.g. the overlap lines) never shows "Working…".
  const busy = [...pending.values()].some((p) => !p.quiet);
  for (const l of listeners) l(busy);
}

function getWorker(): Worker {
  if (worker) return worker;
  worker = new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' });
  worker.onmessage = (e: MessageEvent<{ id: number; result?: unknown; error?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.error !== undefined) p.reject(new Error(e.data.error));
    else p.resolve(e.data.result);
    notify();
  };
  // If the worker itself crashes (e.g. out of memory), fail everything waiting
  // and start a fresh worker for the next operation.
  worker.onerror = (e) => {
    e.preventDefault();
    for (const p of pending.values()) p.reject(new Error(e.message || 'The geometry engine stopped'));
    pending.clear();
    worker?.terminate();
    worker = undefined;
    notify();
  };
  return worker;
}

/** Run a heavy geometry operation in the background worker; `quiet` ones don't show "Working…". */
export function runOp<K extends OpName>(op: K, args: OpArgs<K>, quiet = false): Promise<OpResult<K>> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, quiet });
    notify();
    getWorker().postMessage({ id, op, args });
  });
}

/** Message of the error that operations stopped by cancelAll() fail with. */
export const CANCELLED = 'Stopped. Nothing was changed.';

/**
 * Stop whatever is running. A worker busy inside a geometry operation can't
 * read messages until it finishes, so it is shut down; the next operation
 * starts a fresh one (loading the geometry engine again takes a moment).
 */
export function cancelAll(): void {
  if (pending.size === 0) return;
  worker?.terminate();
  worker = undefined;
  for (const p of pending.values()) p.reject(new Error(CANCELLED));
  pending.clear();
  notify();
}

/** Called with true while any operation is running, false when all are done. */
export function onBusyChange(listener: (busy: boolean) => void): void {
  listeners.add(listener);
}
