import type { MeshData } from './meshData';

/**
 * Sending meshes to the geometry worker once. The page sends a mesh with an
 * id (see meshId) in full the first time; later jobs name it by id only
 * (`{ id, stored: true }`) and the worker uses the copy it kept. Meshes never
 * change once made, so an id always means the same mesh. If the worker no
 * longer has a mesh (it forgets the oldest beyond a limit), the job fails
 * with Missing and the page sends it again in full.
 */

/** A mesh named by id only */
export interface StoredRef {
  id: number;
  stored: true;
}

const isPlain = (v: object) => Object.getPrototypeOf(v) === Object.prototype;
const isIdMesh = (o: Record<string, unknown>): boolean =>
  typeof o.id === 'number' && o.positions instanceof Float32Array && o.indices instanceof Uint32Array;

/**
 * Page side: the job's arguments with every mesh in `sent` replaced by its id.
 * Only plain objects and arrays are rebuilt (the caller's objects are not
 * changed); anything else goes as it is. `fresh` collects ids sent in full.
 */
export function slim(value: unknown, sent: ReadonlySet<number>, fresh: Set<number>): unknown {
  if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
  if (Array.isArray(value)) return value.map((v) => slim(v, sent, fresh));
  if (!isPlain(value)) return value;
  const o = value as Record<string, unknown>;
  if (isIdMesh(o)) {
    const id = o.id as number;
    if (sent.has(id)) return { id, stored: true } satisfies StoredRef;
    fresh.add(id);
    return value;
  }
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(o)) out[k] = slim(o[k], sent, fresh);
  return out;
}

/** The worker no longer has a mesh a job named by id. */
export class Missing extends Error {}

/** Worker side: the meshes kept, newest last, with a limit on their triangles. */
export class MeshStore {
  private readonly meshes = new Map<number, MeshData>();
  private triangles = 0;

  constructor(private readonly limit: number) {}

  /** Put kept meshes back in place of their ids and keep the meshes sent in full. Throws Missing for an id not kept. */
  hydrate(value: unknown, used: Set<number> = new Set()): unknown {
    if (value === null || typeof value !== 'object' || ArrayBuffer.isView(value)) return value;
    if (Array.isArray(value)) return value.map((v) => this.hydrate(v, used));
    if (!isPlain(value)) return value; // e.g. a file's bytes
    const o = value as Record<string, unknown>;
    if (o.stored === true && typeof o.id === 'number') {
      const mesh = this.meshes.get(o.id);
      if (!mesh) throw new Missing();
      this.meshes.delete(o.id); // used just now: to the newest end
      this.meshes.set(o.id, mesh);
      used.add(o.id);
      return mesh;
    }
    if (isIdMesh(o)) {
      const id = o.id as number;
      if (!this.meshes.has(id)) {
        this.meshes.set(id, o as unknown as MeshData);
        this.triangles += (o.indices as Uint32Array).length / 3;
      }
      used.add(id);
      return o;
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o)) out[k] = this.hydrate(o[k], used);
    return out;
  }

  /** Forget the oldest meshes beyond the limit, but never one in `used` (the job about to run). */
  trim(used: ReadonlySet<number>): void {
    for (const [id, mesh] of this.meshes) {
      if (this.triangles <= this.limit) break;
      if (used.has(id)) continue;
      this.meshes.delete(id);
      this.triangles -= mesh.indices.length / 3;
    }
  }

  /** The kept meshes' buffers: never handed back by transfer (a job may return its input unchanged). */
  buffers(): Set<ArrayBufferLike> {
    const out = new Set<ArrayBufferLike>();
    for (const m of this.meshes.values()) out.add(m.positions.buffer).add(m.indices.buffer);
    return out;
  }

  has(id: number): boolean {
    return this.meshes.has(id);
  }
}
