import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CANCELLED, SUPERSEDE_AFTER_MS, cancelAll, isFatalEngineError, onBusyChange, resetWorkerClientForTests, runOp, setWorkerFactory,
  type WorkerLike,
} from '../src/geometry/workerClient';

class FakeWorker implements WorkerLike {
  posted: { id: number; op: string; args: unknown }[] = [];
  terminated = false;
  onmessage: WorkerLike['onmessage'] = null;
  onerror: WorkerLike['onerror'] = null;
  postMessage(m: unknown): void {
    this.posted.push(m as { id: number; op: string; args: unknown });
  }
  terminate(): void {
    this.terminated = true;
  }
  reply(data: unknown): void {
    this.onmessage?.({ data });
  }
}

let workers: FakeWorker[] = [];
// Any op name will do: the fake worker never runs it, and plain arguments pass through slim() unchanged.
const run = (args: unknown, options?: boolean | { quiet?: boolean; signal?: AbortSignal }) =>
  runOp('shell', args as never, options) as Promise<unknown>;

beforeEach(() => {
  vi.useFakeTimers();
  workers = [];
  setWorkerFactory(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  });
});
afterEach(() => {
  resetWorkerClientForTests();
  setWorkerFactory(null);
  vi.useRealTimers();
});

describe('worker client queue', () => {
  it('posts one job at a time, in order', async () => {
    const a = run({ n: 1 });
    const b = run({ n: 2 });
    expect(workers[0].posted.map((m) => m.args)).toEqual([{ n: 1 }]);
    workers[0].reply({ id: workers[0].posted[0].id, result: 'A' });
    await expect(a).resolves.toBe('A');
    expect(workers[0].posted.map((m) => m.args)).toEqual([{ n: 1 }, { n: 2 }]);
    workers[0].reply({ id: workers[0].posted[1].id, result: 'B' });
    await expect(b).resolves.toBe('B');
  });

  it('rejects a queued job whose signal aborts, and never posts it', async () => {
    const c = new AbortController();
    const a = run({ n: 1 });
    const b = run({ n: 2 }, { signal: c.signal });
    c.abort();
    await expect(b).rejects.toThrow(CANCELLED);
    workers[0].reply({ id: workers[0].posted[0].id, result: 'A' });
    await expect(a).resolves.toBe('A');
    expect(workers[0].posted).toHaveLength(1);
  });

  it('rejects at once for an already aborted signal', async () => {
    const c = new AbortController();
    c.abort();
    await expect(run({ n: 1 }, { signal: c.signal })).rejects.toThrow(CANCELLED);
    expect(workers).toHaveLength(0);
  });

  it('stops a job that ran longer than the limit and carries on with the next on a new worker', async () => {
    const c = new AbortController();
    const a = run({ n: 1 }, { signal: c.signal });
    const b = run({ n: 2 });
    vi.advanceTimersByTime(SUPERSEDE_AFTER_MS + 1);
    c.abort();
    await expect(a).rejects.toThrow(CANCELLED);
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1].posted.map((m) => m.args)).toEqual([{ n: 2 }]);
    workers[1].reply({ id: workers[1].posted[0].id, result: 'B' });
    await expect(b).resolves.toBe('B');
  });

  it('lets a young job finish but rejects it at once and drops its result', async () => {
    const c = new AbortController();
    const a = run({ n: 1 }, { signal: c.signal });
    const b = run({ n: 2 });
    vi.advanceTimersByTime(SUPERSEDE_AFTER_MS - 100);
    c.abort();
    await expect(a).rejects.toThrow(CANCELLED);
    expect(workers[0].terminated).toBe(false);
    expect(workers[0].posted).toHaveLength(1);
    workers[0].reply({ id: workers[0].posted[0].id, result: 'late' });
    expect(workers).toHaveLength(1);
    expect(workers[0].posted.map((m) => m.args)).toEqual([{ n: 1 }, { n: 2 }]);
    workers[0].reply({ id: workers[0].posted[1].id, result: 'B' });
    await expect(b).resolves.toBe('B');
  });

  it('replaces the worker after a fatal reply', async () => {
    const a = run({ n: 1 });
    const b = run({ n: 2 });
    workers[0].reply({ id: workers[0].posted[0].id, error: 'out of memory', fatal: true });
    await expect(a).rejects.toThrow('out of memory');
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);
    expect(workers[1].posted.map((m) => m.args)).toEqual([{ n: 2 }]);
    workers[1].reply({ id: workers[1].posted[0].id, result: 'B' });
    await expect(b).resolves.toBe('B');
  });

  it('keeps the worker after an ordinary error', async () => {
    const a = run({ n: 1 });
    workers[0].reply({ id: workers[0].posted[0].id, error: 'Not manifold' });
    await expect(a).rejects.toThrow('Not manifold');
    expect(workers[0].terminated).toBe(false);
  });

  it('cancelAll rejects everything and stops the worker', async () => {
    const a = run({ n: 1 });
    const b = run({ n: 2 });
    cancelAll();
    await expect(a).rejects.toThrow(CANCELLED);
    await expect(b).rejects.toThrow(CANCELLED);
    expect(workers[0].terminated).toBe(true);
    expect(workers[0].posted).toHaveLength(1);
  });

  it('tells the busy listener true, then false; quiet jobs are not busy', async () => {
    const seen: boolean[] = [];
    onBusyChange((b) => seen.push(b));
    const a = run({ n: 1 });
    workers[0].reply({ id: workers[0].posted[0].id, result: 1 });
    await a;
    expect(seen[0]).toBe(true);
    expect(seen[seen.length - 1]).toBe(false);
    seen.length = 0;
    const q = run({ n: 2 }, true);
    expect(seen.every((b) => !b)).toBe(true);
    workers[0].reply({ id: workers[0].posted[1].id, result: 1 });
    await q;
  });

  it('sends the same job again when the worker reports a missing mesh', async () => {
    const a = run({ n: 1 });
    const id = workers[0].posted[0].id;
    workers[0].reply({ id, missing: true });
    expect(workers[0].posted).toHaveLength(2);
    expect(workers[0].posted[1]).toEqual({ id, op: 'shell', args: { n: 1 } });
    workers[0].reply({ id, result: 'ok' });
    await expect(a).resolves.toBe('ok');
  });
});

describe('isFatalEngineError', () => {
  it('recognises a dead engine, not an ordinary failure', () => {
    expect(isFatalEngineError(new WebAssembly.RuntimeError('x'))).toBe(true);
    expect(isFatalEngineError(new Error('Aborted(OOM). Build with -sASSERTIONS'))).toBe(true);
    expect(isFatalEngineError(new Error('memory access out of bounds'))).toBe(true);
    expect(isFatalEngineError(new Error('Array buffer allocation failed'))).toBe(true);
    expect(isFatalEngineError(new Error('The shape is not solid'))).toBe(false);
    expect(isFatalEngineError('nope')).toBe(false);
  });
});
