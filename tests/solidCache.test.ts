import Module, { type ManifoldToplevel } from 'manifold-3d';
import * as THREE from 'three';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { booleanOp } from '../src/geometry/booleans';
import { findEdges, findEdgesPlaced } from '../src/geometry/edges';
import { bakeMesh, clearSolidCache, meshDataToManifold, meshId, solidCacheSize, type MeshData } from '../src/geometry/meshData';
import { ops } from '../src/geometry/ops';
import { clearOverlapCache, overlapLines } from '../src/geometry/overlaps';
import { createPrimitive } from '../src/geometry/primitives';
import { buildGeometry, SceneDocument } from '../src/scene/document';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});
afterEach(() => {
  clearSolidCache();
  clearOverlapCache();
});

const move = (x: number, y = 0, z = 0) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const withId = (m: MeshData): MeshData => ({ ...m, id: meshId(m) });

describe('solid cache', () => {
  it('gives the same solid with and without an id, and leaves the cached base alive', () => {
    const cube = createPrimitive(wasm, 'cube', 20);
    const cached = withId(cube);
    const plain = meshDataToManifold(wasm, cube, move(3, 4, 5));
    const first = meshDataToManifold(wasm, cached, move(3, 4, 5));
    expect(first.volume()).toBeCloseTo(plain.volume(), 6);
    first.delete(); // the caller owns and frees its copy
    const second = meshDataToManifold(wasm, cached, move(3, 4, 5));
    expect(second.volume()).toBeCloseTo(plain.volume(), 6);
    expect(solidCacheSize().solids).toBe(1);
    plain.delete();
    second.delete();
    // A different placement of the same mesh reuses the base.
    const other = meshDataToManifold(wasm, cached, move(100));
    expect(other.boundingBox().min[0]).toBeCloseTo(90, 4);
    other.delete();
    expect(solidCacheSize().solids).toBe(1);
  });

  it('does not cache a mesh that is not a valid solid', () => {
    const bad = withId({ positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) });
    expect(() => meshDataToManifold(wasm, bad)).toThrow();
    expect(solidCacheSize().solids).toBe(0);
  });

  it('frees the oldest solids beyond the triangle limit without failing', () => {
    const sphere = createPrimitive(wasm, 'sphere', 20);
    const each = sphere.indices.length / 3;
    const inserts = Math.ceil(4_000_000 / each);
    for (let i = 0; i < inserts; i++) meshDataToManifold(wasm, withId({ ...sphere }), move(i)).delete();
    const size = solidCacheSize();
    expect(size.triangles).toBeLessThanOrEqual(3_000_000);
    expect(size.solids).toBeLessThan(inserts);
    expect(size.solids).toBeGreaterThan(0);
  });

  it('boolean results are the same with ids', () => {
    const a = createPrimitive(wasm, 'cube', 20), b = createPrimitive(wasm, 'sphere', 14);
    const run = (x: MeshData, y: MeshData) => {
      const r = booleanOp(wasm, 'union', [{ mesh: x, matrix: move(0) }, { mesh: y, matrix: move(6, 0, 0) }]);
      if (r.empty) throw new Error('empty');
      const m = meshDataToManifold(wasm, r.mesh);
      const v = m.volume();
      m.delete();
      return v;
    };
    const plain = run(a, b);
    expect(run(withId(a), withId(b))).toBeCloseTo(plain, 4);
    expect(run(withId(a), withId(b))).toBeCloseTo(plain, 4);
  });
});

describe('overlap cache', () => {
  it('gives the same lines cached as uncached, also after moving an object', () => {
    const a = createPrimitive(wasm, 'cube', 20), b = createPrimitive(wasm, 'cube', 20), c = createPrimitive(wasm, 'cylinder', 12);
    const ia = withId(a), ib = withId(b), ic = withId(c);
    const scene = (bx: number, ids: boolean) => [
      { mesh: ids ? ia : a, matrix: move(0) },
      { mesh: ids ? ib : b, matrix: move(bx, 5, 5) },
      { mesh: ids ? ic : c, matrix: move(8, 0, 0) },
    ];
    const sorted = (f: Float32Array) => {
      const segs: string[] = [];
      for (let i = 0; i < f.length; i += 6) segs.push(Array.from(f.slice(i, i + 6)).join(','));
      return segs.sort();
    };
    for (const bx of [10, 10, 12]) {
      const plain = overlapLines(wasm, scene(bx, false));
      const cached = overlapLines(wasm, scene(bx, true));
      expect(plain.length).toBeGreaterThan(0);
      expect(sorted(cached)).toEqual(sorted(plain));
    }
    // Pairs not in the call are forgotten; a pair left out and back in still gives the same answer.
    overlapLines(wasm, [scene(10, true)[0]]);
    expect(sorted(overlapLines(wasm, scene(10, true)))).toEqual(sorted(overlapLines(wasm, scene(10, false))));
  });
});

describe('edges off the main thread', () => {
  it('findEdges op matches findEdges on the baked mesh, and is remembered', () => {
    const cube = createPrimitive(wasm, 'cube', 10);
    const item = { mesh: withId(cube), matrix: move(1, 2, 3) };
    const direct = findEdges(bakeMesh({ mesh: cube, matrix: move(1, 2, 3) }));
    const viaOp = ops.findEdges(wasm, { item });
    expect(viaOp).toEqual(direct);
    expect(findEdgesPlaced(item)).toBe(viaOp);
  });

  it('edgeLines op gives the same lines as EdgesGeometry on the object geometry', () => {
    const mesh = createPrimitive(wasm, 'cylinder', 20);
    const sorted = (f: ArrayLike<number>) => {
      const segs: string[] = [];
      for (let i = 0; i < f.length; i += 6) {
        const a = Array.from({ length: 3 }, (_, k) => f[i + k].toFixed(4)).join(',');
        const b = Array.from({ length: 3 }, (_, k) => f[i + 3 + k].toFixed(4)).join(',');
        segs.push(a < b ? `${a}|${b}` : `${b}|${a}`);
      }
      return segs.sort();
    };
    const expected = new THREE.EdgesGeometry(buildGeometry(mesh), 25).getAttribute('position').array;
    expect(sorted(ops.edgeLines(wasm, { mesh, angle: 25 }))).toEqual(sorted(expected));
  });
});

describe('placed() ids', () => {
  it('adds a stable id without copying or changing the stored mesh', () => {
    const doc = new SceneDocument(new THREE.Group());
    const mesh = createPrimitive(wasm, 'cube', 10);
    const obj = doc.add('Cube', mesh);
    const p1 = doc.placed(obj), p2 = doc.placed(obj);
    expect(p1.mesh.id).toBeTypeOf('number');
    expect(p2.mesh.id).toBe(p1.mesh.id);
    expect(p1.mesh.positions).toBe(mesh.positions);
    expect('id' in obj.data).toBe(false);
    expect('id' in doc.exportState().objects[0].data).toBe(false);
    const other = doc.add('Cube', createPrimitive(wasm, 'cube', 10));
    expect(doc.placed(other).mesh.id).not.toBe(p1.mesh.id);
  });
});
