import { isFatalEngineError } from './engineError';
import { slim } from './meshTransfer';
import type { OpArgs, OpName, OpResult } from './ops';

export { isFatalEngineError };

/** The parts of a Worker the client uses (a test can supply a fake one). */
export interface WorkerLike {
  postMessage(message: unknown): void;
  terminate(): void;
  // The reply's shape is checked where it is read, so `any` is enough here.
  onmessage: ((e: { data: any }) => void) | null;
  onerror: ((e: { message?: string; preventDefault(): void }) => void) | null;
}

/** A job that has run longer than this (ms) is worth stopping when its result is no longer wanted. */
export const SUPERSEDE_AFTER_MS = 400;

/** Message of the error that operations stopped by cancelAll() fail with. */
export const CANCELLED = 'Stopped. Nothing was changed.';

export interface RunOptions {
  quiet?: boolean;
  /** Abort to say the result is no longer wanted (e.g. a newer preview replaced it). */
  signal?: AbortSignal;
}

interface Job {
  id: number;
  op: OpName;
  args: unknown;
  quiet: boolean;
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  /** When it was given to the worker */
  startedAt: number;
  /** Already rejected (its signal aborted while it ran); the late result is thrown away */
  dropped: boolean;
}

const defaultFactory = (): WorkerLike =>
  new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }) as unknown as WorkerLike;
let factory: () => WorkerLike = defaultFactory;

/** Use another way to make the worker (tests); null goes back to the real one. */
export function setWorkerFactory(f: (() => WorkerLike) | null): void {
  factory = f ?? defaultFactory;
}

let worker: WorkerLike | undefined;
let nextId = 1;
/** Jobs waiting their turn. The worker gets one job at a time, so the client always knows which one runs. */
let queue: Job[] = [];
let running: Job | undefined;
const listeners = new Set<(busy: boolean) => void>();
/**
 * Ids of the meshes the current worker has been sent in full. Later jobs send
 * just the id. A new worker (after Cancel or a crash) starts with none.
 */
let sent = new Set<number>();

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function notify(): void {
  // Quiet work (e.g. the overlap lines) never shows "Working…"; nor does a job nobody waits for.
  const busy = queue.some((j) => !j.quiet) || (running !== undefined && !running.quiet && !running.dropped);
  for (const l of listeners) l(busy);
}

/** Send a job: meshes the worker has already by id only (see meshTransfer), unless `full`. */
function post(job: Job, full = false): void {
  const w = getWorker();
  if (full) {
    w.postMessage({ id: job.id, op: job.op, args: job.args });
    return;
  }
  const fresh = new Set<number>();
  w.postMessage({ id: job.id, op: job.op, args: slim(job.args, sent, fresh) });
  for (const f of fresh) sent.add(f);
}

function dropWorker(): void {
  worker?.terminate();
  worker = undefined;
  sent = new Set();
}

function release(job: Job): void {
  if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
}

/** Give the worker the next waiting job, if it is idle. */
function pump(): void {
  if (running || queue.length === 0) return;
  const job = queue.shift()!;
  running = job;
  job.startedAt = now();
  post(job);
}

function getWorker(): WorkerLike {
  if (worker) return worker;
  sent = new Set();
  const w = factory();
  worker = w;
  w.onmessage = (e) => {
    const job = running;
    if (worker !== w || !job || e.data.id !== job.id) return;
    // The worker no longer keeps a mesh this job named by id: send the job again in full.
    if (e.data.missing && !job.dropped) {
      post(job, true);
      return;
    }
    running = undefined;
    release(job);
    // The geometry engine is broken (e.g. out of memory): start a fresh worker for what comes next.
    if (e.data.fatal) dropWorker();
    if (!job.dropped && !e.data.missing) {
      if (e.data.error !== undefined) job.reject(new Error(e.data.error));
      else job.resolve(e.data.result);
    }
    notify();
    pump();
  };
  // If the worker itself crashes (e.g. out of memory), fail everything waiting
  // and start a fresh worker for the next operation.
  w.onerror = (e) => {
    e.preventDefault();
    const jobs = [...(running ? [running] : []), ...queue];
    running = undefined;
    queue = [];
    if (worker === w) dropWorker();
    else w.terminate();
    for (const j of jobs) {
      release(j);
      if (!j.dropped) j.reject(new Error(e.message || 'The geometry engine stopped'));
    }
    notify();
  };
  return w;
}

/**
 * Run a heavy geometry operation in the background worker. `options` is `quiet`
 * (true: don't show "Working…") or `{ quiet, signal }`. Aborting the signal
 * rejects the job with CANCELLED; a job that has run for a while is stopped too.
 */
export function runOp<K extends OpName>(op: K, args: OpArgs<K>, options: boolean | RunOptions = false): Promise<OpResult<K>> {
  const opts: RunOptions = typeof options === 'boolean' ? { quiet: options } : options;
  return new Promise((resolve, reject) => {
    const signal = opts.signal;
    if (signal?.aborted) {
      reject(new Error(CANCELLED));
      return;
    }
    const job: Job = {
      id: nextId++, op, args, quiet: opts.quiet ?? false,
      resolve: resolve as (v: unknown) => void, reject, signal, startedAt: 0, dropped: false,
    };
    if (signal) {
      job.onAbort = () => abortJob(job);
      signal.addEventListener('abort', job.onAbort, { once: true });
    }
    queue.push(job);
    notify();
    pump();
  });
}

function abortJob(job: Job): void {
  const i = queue.indexOf(job);
  if (i >= 0) {
    queue.splice(i, 1);
    job.reject(new Error(CANCELLED));
    release(job);
    notify();
    return;
  }
  if (running !== job || job.dropped) return;
  job.reject(new Error(CANCELLED));
  release(job);
  if (now() - job.startedAt > SUPERSEDE_AFTER_MS) {
    // Long enough that stopping it pays: shut the worker down and carry on with the rest on a new one.
    running = undefined;
    dropWorker();
    notify();
    pump();
    return;
  }
  // Nearly done: let it finish, and throw the result away when it arrives.
  job.dropped = true;
  notify();
}

/**
 * Stop whatever is running. A worker busy inside a geometry operation can't
 * read messages until it finishes, so it is shut down; the next operation
 * starts a fresh one (loading the geometry engine again takes a moment).
 */
export function cancelAll(): void {
  if (!running && queue.length === 0) return;
  const jobs = [...(running ? [running] : []), ...queue];
  if (running) dropWorker();
  running = undefined;
  queue = [];
  for (const j of jobs) {
    release(j);
    if (!j.dropped) j.reject(new Error(CANCELLED));
  }
  notify();
}

/** Called with true while any operation is running, false when all are done. */
export function onBusyChange(listener: (busy: boolean) => void): void {
  listeners.add(listener);
}

/** Forget every job, the worker and the busy listeners (tests only). */
export function resetWorkerClientForTests(): void {
  worker?.terminate();
  worker = undefined;
  sent = new Set();
  queue = [];
  running = undefined;
  listeners.clear();
  nextId = 1;
}
