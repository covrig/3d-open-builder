import Module, { type Manifold, type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { splitByPlane } from '../src/geometry/cut';
import { meshDataToManifold, type MeshData } from '../src/geometry/meshData';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const meshOf = (m: Manifold): MeshData => {
  const g = m.getMesh();
  return { positions: g.vertProperties.slice(), indices: g.triVerts.slice() };
};
const measure = (mesh: MeshData) => {
  const m = meshDataToManifold(wasm, mesh);
  const parts = m.decompose();
  const out = { volume: m.volume(), shells: parts.length };
  for (const p of parts) p.delete();
  m.delete();
  return out;
};

describe('split gives every loose piece its own entry', () => {
  it('a U shape cut across its arms: two arms on one side, one block on the other', () => {
    // 40 mm cube minus a 20 x 50 x 40 slot centred 10 mm above the middle: the upper half is two arms.
    const u = meshOf(wasm.Manifold.cube([40, 40, 40], true).subtract(wasm.Manifold.cube([20, 50, 40], true).translate([0, 0, 10])));
    const r = splitByPlane(wasm, { mesh: u, matrix: IDENTITY }, [0, 0, 1], 0);
    expect(r.positive.map((p) => measure(p.mesh).volume.toFixed(2))).toEqual(['8000.00', '8000.00']);
    expect(r.negative.map((p) => measure(p.mesh).volume.toFixed(2))).toEqual(['24000.00']);
    // Each piece is centred on its own box and says where that is.
    expect(r.positive.map((p) => p.center[0]).sort((a, b) => a - b)).toEqual([-15, 15]);
  });

  it('a hollow cube cut above the hollow: the lower piece keeps its hollow', () => {
    const hollow = meshOf(wasm.Manifold.cube([40, 40, 40], true).subtract(wasm.Manifold.cube([20, 20, 20], true)));
    const r = splitByPlane(wasm, { mesh: hollow, matrix: IDENTITY }, [0, 0, 1], 15);
    expect(r.positive).toHaveLength(1);
    expect(measure(r.positive[0].mesh).volume).toBeCloseTo(8000, 2);
    expect(r.negative).toHaveLength(1);
    const lower = measure(r.negative[0].mesh);
    expect(lower.volume).toBeCloseTo(48000, 2);
    expect(lower.shells).toBe(2); // the outside and the hollow
  });

  it('a plane that misses leaves one side empty', () => {
    const cube = meshOf(wasm.Manifold.cube([40, 40, 40], true));
    const above = splitByPlane(wasm, { mesh: cube, matrix: IDENTITY }, [0, 0, 1], 30);
    expect(above.positive).toEqual([]);
    expect(above.negative).toHaveLength(1);
    const below = splitByPlane(wasm, { mesh: cube, matrix: IDENTITY }, [0, 0, 1], -30);
    expect(below.negative).toEqual([]);
    expect(below.positive).toHaveLength(1);
  });
});
