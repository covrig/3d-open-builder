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
  /**
   * Work nobody waits for (the overlap lines): runs on its own second worker, so
   * it never delays a user's operation, never shows "Working…", and is replaced
   * by a newer background request (the older one is rejected with CANCELLED).
   */
  background?: boolean;
  /** Abort to say the result is no longer wanted (e.g. a newer preview replaced it). */
  signal?: AbortSignal;
}

/** One worker with the jobs waiting for it. The worker gets one job at a time, so the client always knows which one runs. */
interface Lane {
  worker?: WorkerLike;
  /**
   * Ids of the meshes this lane's worker has been sent in full. Later jobs send
   * just the id. A new worker (after Cancel or a crash) starts with none.
   */
  sent: Set<number>;
  queue: Job[];
  running?: Job;
}

interface Job {
  id: number;
  op: OpName;
  args: unknown;
  quiet: boolean;
  lane: Lane;
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

const newLane = (): Lane => ({ sent: new Set(), queue: [] });
/** The worker for what the user asked for. */
const userLane = newLane();
/** A second worker, made on first use, for background work only: it can never hold up the user's. */
const backgroundLane = newLane();
let nextId = 1;
const listeners = new Set<(busy: boolean) => void>();

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

function notify(): void {
  // Only the user's work counts: quiet jobs (e.g. edge lines) and background work never show "Working…"; nor does a job nobody waits for.
  const { queue, running } = userLane;
  const busy = queue.some((j) => !j.quiet) || (running !== undefined && !running.quiet && !running.dropped);
  for (const l of listeners) l(busy);
}

/** Send a job: meshes the worker has already by id only (see meshTransfer), unless `full`. */
function post(lane: Lane, job: Job, full = false): void {
  const w = getWorker(lane);
  if (full) {
    w.postMessage({ id: job.id, op: job.op, args: job.args });
    return;
  }
  const fresh = new Set<number>();
  w.postMessage({ id: job.id, op: job.op, args: slim(job.args, lane.sent, fresh) });
  for (const f of fresh) lane.sent.add(f);
}

function dropWorker(lane: Lane): void {
  lane.worker?.terminate();
  lane.worker = undefined;
  lane.sent = new Set();
}

function release(job: Job): void {
  if (job.signal && job.onAbort) job.signal.removeEventListener('abort', job.onAbort);
}

/** Give the lane's worker the next waiting job, if it is idle. */
function pump(lane: Lane): void {
  if (lane.running || lane.queue.length === 0) return;
  const job = lane.queue.shift()!;
  lane.running = job;
  job.startedAt = now();
  post(lane, job);
}

function getWorker(lane: Lane): WorkerLike {
  if (lane.worker) return lane.worker;
  lane.sent = new Set();
  const w = factory();
  lane.worker = w;
  w.onmessage = (e) => {
    const job = lane.running;
    if (lane.worker !== w || !job || e.data.id !== job.id) return;
    // The worker no longer keeps a mesh this job named by id: send the job again in full.
    if (e.data.missing && !job.dropped) {
      post(lane, job, true);
      return;
    }
    lane.running = undefined;
    release(job);
    // The geometry engine is broken (e.g. out of memory): start a fresh worker for what comes next.
    if (e.data.fatal) dropWorker(lane);
    if (!job.dropped && !e.data.missing) {
      if (e.data.error !== undefined) job.reject(new Error(e.data.error));
      else job.resolve(e.data.result);
    }
    notify();
    pump(lane);
  };
  // If the worker itself crashes (e.g. out of memory), fail everything waiting
  // and start a fresh worker for the next operation.
  w.onerror = (e) => {
    e.preventDefault();
    const jobs = [...(lane.running ? [lane.running] : []), ...lane.queue];
    lane.running = undefined;
    lane.queue = [];
    if (lane.worker === w) dropWorker(lane);
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
 * Run a heavy geometry operation in a worker. `options` is `quiet` (true:
 * don't show "Working…") or `{ quiet, background, signal }`. Aborting the signal
 * rejects the job with CANCELLED; a job that has run for a while is stopped too.
 * A background job runs on the second worker, and a newer one replaces it.
 */
export function runOp<K extends OpName>(op: K, args: OpArgs<K>, options: boolean | RunOptions = false): Promise<OpResult<K>> {
  const opts: RunOptions = typeof options === 'boolean' ? { quiet: options } : options;
  return new Promise((resolve, reject) => {
    const signal = opts.signal;
    if (signal?.aborted) {
      reject(new Error(CANCELLED));
      return;
    }
    const lane = opts.background ? backgroundLane : userLane;
    const job: Job = {
      id: nextId++, op, args, quiet: opts.quiet ?? !!opts.background, lane,
      resolve: resolve as (v: unknown) => void, reject, signal, startedAt: 0, dropped: false,
    };
    if (signal) {
      job.onAbort = () => abortJob(job);
      signal.addEventListener('abort', job.onAbort, { once: true });
    }
    // Only the newest background request is wanted: stop the one running and the one waiting.
    if (lane === backgroundLane) for (const old of [...lane.queue, ...(lane.running ? [lane.running] : [])]) abortJob(old);
    lane.queue.push(job);
    notify();
    pump(lane);
  });
}

function abortJob(job: Job): void {
  const lane = job.lane;
  const i = lane.queue.indexOf(job);
  if (i >= 0) {
    lane.queue.splice(i, 1);
    job.reject(new Error(CANCELLED));
    release(job);
    notify();
    return;
  }
  if (lane.running !== job || job.dropped) return;
  job.reject(new Error(CANCELLED));
  release(job);
  if (now() - job.startedAt > SUPERSEDE_AFTER_MS) {
    // Long enough that stopping it pays: shut the worker down and carry on with the rest on a new one.
    lane.running = undefined;
    dropWorker(lane);
    notify();
    pump(lane);
    return;
  }
  // Nearly done: let it finish, and throw the result away when it arrives.
  job.dropped = true;
  notify();
}

/**
 * Stop whatever is running, on both workers. A worker busy inside a geometry
 * operation can't read messages until it finishes, so it is shut down; the next
 * operation starts a fresh one (loading the geometry engine again takes a moment).
 */
export function cancelAll(): void {
  const jobs: Job[] = [];
  for (const lane of [userLane, backgroundLane]) {
    if (!lane.running && lane.queue.length === 0) continue;
    jobs.push(...(lane.running ? [lane.running] : []), ...lane.queue);
    if (lane.running) dropWorker(lane);
    lane.running = undefined;
    lane.queue = [];
  }
  if (!jobs.length) return;
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

/** Forget every job, the workers and the busy listeners (tests only). */
export function resetWorkerClientForTests(): void {
  for (const lane of [userLane, backgroundLane]) {
    lane.worker?.terminate();
    lane.worker = undefined;
    lane.sent = new Set();
    lane.queue = [];
    lane.running = undefined;
  }
  listeners.clear();
  nextId = 1;
}
