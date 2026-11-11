import { describe, expect, it } from 'vitest';
import { MeshStore, Missing, slim } from '../src/geometry/meshTransfer';

const mesh = (id: number, tris: number) => ({
  id,
  positions: new Float32Array(9 * tris).map((_, i) => i),
  indices: new Uint32Array(3 * tris).map((_, i) => i),
});

/**
 * One job from page to worker as the real code sends it: slimmed on the page,
 * copied like a worker message, hydrated in the worker. Returns the worker's
 * input, or 'missing' (then the page sends the same job in full).
 */
function send(args: unknown, sent: Set<number>, store: MeshStore): unknown {
  const fresh = new Set<number>();
  const message = structuredClone(slim(args, sent, fresh));
  for (const f of fresh) sent.add(f);
  try {
    const used = new Set<number>();
    const input = store.hydrate(message, used);
    store.trim(used);
    return input;
  } catch (err) {
    if (!(err instanceof Missing)) throw err;
    const input = store.hydrate(structuredClone(args)); // the full resend
    return input;
  }
}

describe('sending meshes to the worker once', () => {
  it('sends a mesh in full the first time and by id afterwards, with the same data arriving', () => {
    const sent = new Set<number>();
    const store = new MeshStore(1e6);
    const a = mesh(1, 4);
    const job = { item: { mesh: a, matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, 0, 0, 1] }, size: 2 };

    const fresh = new Set<number>();
    expect((slim(job, sent, fresh) as typeof job).item.mesh.positions).toBe(a.positions);
    const first = send(job, sent, store) as typeof job;
    expect(first.item.mesh.positions).toEqual(a.positions);
    expect(sent.has(1)).toBe(true);

    // Second job: only the id goes; the worker puts its copy back.
    const slimmed = slim(job, sent, new Set()) as { item: { mesh: unknown } };
    expect(slimmed.item.mesh).toEqual({ id: 1, stored: true });
    const second = send(job, sent, store) as typeof job;
    expect(second.item.mesh.positions).toEqual(a.positions);
    expect(second.item.mesh.indices).toEqual(a.indices);
    expect(second.item.matrix).toEqual(job.item.matrix);
    expect(second.size).toBe(2);
  });

  it('does not change the caller\'s objects and passes other values through untouched', () => {
    const sent = new Set([1]);
    const a = mesh(1, 2);
    const buffer = new ArrayBuffer(8);
    const job = { items: [{ mesh: a }], buffer, text: 'x', n: 3, flag: true, nothing: null };
    const out = slim(job, sent, new Set()) as Record<string, unknown>;
    expect(job.items[0].mesh).toBe(a); // the caller's job still holds the mesh
    expect(out.buffer).toBe(buffer);
    expect([out.text, out.n, out.flag, out.nothing]).toEqual(['x', 3, true, null]);

    // A file's bytes arrive in the worker as bytes (not rebuilt into an object).
    const store = new MeshStore(1e6);
    const hydrated = store.hydrate(structuredClone({ buffer: new Uint8Array([1, 2, 3]).buffer })) as { buffer: ArrayBuffer };
    expect(hydrated.buffer).toBeInstanceOf(ArrayBuffer);
    expect([...new Uint8Array(hydrated.buffer)]).toEqual([1, 2, 3]);
  });

  it('meshes without an id always go in full', () => {
    const plain = { positions: new Float32Array(9), indices: new Uint32Array(3) };
    const sent = new Set<number>();
    const out = slim({ mesh: plain }, sent, new Set()) as { mesh: typeof plain };
    expect(out.mesh.positions).toBe(plain.positions);
    expect(out.mesh.indices).toBe(plain.indices);
    expect(sent.size).toBe(0);
  });

  it('a mesh the worker forgot is sent again in full and the job still gets the right data', () => {
    const sent = new Set<number>();
    const store = new MeshStore(10); // room for 10 triangles
    const a = mesh(1, 6), b = mesh(2, 6);
    send({ mesh: a }, sent, store);
    send({ mesh: b }, sent, store); // a (oldest) is forgotten to make room
    expect(store.has(1)).toBe(false);
    expect(store.has(2)).toBe(true);
    expect(() => store.hydrate(structuredClone(slim({ mesh: a }, sent, new Set())))).toThrow(Missing);
    const again = send({ mesh: a }, sent, store) as { mesh: typeof a };
    expect(again.mesh.positions).toEqual(a.positions);
  });

  it('never forgets a mesh the current job uses, even over the limit', () => {
    const store = new MeshStore(4);
    const used = new Set<number>();
    store.hydrate(structuredClone({ items: [mesh(1, 6), mesh(2, 6)] }), used);
    store.trim(used);
    expect(store.has(1) && store.has(2)).toBe(true);
  });

  it('kept meshes\' buffers are listed so they are never transferred away', () => {
    const store = new MeshStore(1e6);
    const input = store.hydrate(structuredClone({ mesh: mesh(7, 2) })) as { mesh: { positions: Float32Array; indices: Uint32Array } };
    const keep = store.buffers();
    expect(keep.has(input.mesh.positions.buffer)).toBe(true);
    expect(keep.has(input.mesh.indices.buffer)).toBe(true);
  });
});
