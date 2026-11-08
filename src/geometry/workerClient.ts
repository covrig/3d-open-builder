import type { OpArgs, OpName, OpResult } from './ops';

type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void };

let worker: Worker | undefined;
let nextId = 1;
const pending = new Map<number, Pending>();
const listeners = new Set<(busy: boolean) => void>();

function notify(): void {
  for (const l of listeners) l(pending.size > 0);
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

/** Run a heavy geometry operation in the background worker. */
export function runOp<K extends OpName>(op: K, args: OpArgs<K>): Promise<OpResult<K>> {
  return new Promise((resolve, reject) => {
    const id = nextId++;
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    notify();
    getWorker().postMessage({ id, op, args });
  });
}

/** Called with true while any operation is running, false when all are done. */
export function onBusyChange(listener: (busy: boolean) => void): void {
  listeners.add(listener);
}
