import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { booleanOp } from '../src/geometry/booleans';
import { analyze, gentleWeld, weld } from '../src/geometry/meshCheck';
import { meshDataToManifold, type MeshData } from '../src/geometry/meshData';
import { repairMesh } from '../src/geometry/meshTools';
import { createPrimitive } from '../src/geometry/primitives';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const I = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
/** Every triangle gets its own three vertices (as STL stores them), each coordinate moved by a seeded amount within +-jitter. */
const soup = (m: MeshData, jitter: number): MeshData => {
  const positions = new Float32Array(m.indices.length * 3);
  const indices = new Uint32Array(m.indices.length);
  let s = 12345;
  const rnd = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff - 0.5) * 2;
  for (let i = 0; i < m.indices.length; i++) {
    for (let k = 0; k < 3; k++) positions[i * 3 + k] = m.positions[m.indices[i] * 3 + k] + rnd() * jitter;
    indices[i] = i;
  }
  return { positions, indices };
};
const volume = (m: MeshData) => {
  const s = meshDataToManifold(wasm, m);
  const v = s.volume();
  s.delete();
  return v;
};

describe('weld by distance', () => {
  it('merges two points a hair apart on either side of a rounding border', () => {
    // 5e-5 is half of eps: the old grid rounding put 5e-5 - 5e-10 and 5e-5 + 5e-10 into different cells.
    const lo = 5e-5 - 5e-10, hi = 5e-5 + 5e-10;
    const mesh: MeshData = { positions: new Float32Array([lo, lo, lo, hi, hi, hi, 1, 0, 0]), indices: new Uint32Array([0, 1, 2]) };
    const w = weld(mesh, 1e-4);
    expect(w.positions.length / 3).toBe(2); // the two close points are one; the point at 1 stays
    expect(w.indices.length).toBe(0); // the triangle collapsed
  });

  it('keeps points further apart than eps apart', () => {
    const mesh: MeshData = { positions: new Float32Array([0, 0, 0, 2e-4, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
    expect(weld(mesh, 1e-4).positions.length / 3).toBe(3);
  });

  it('closes the surface of a soup moved by 1e-6, with the fixed 1e-4 distance', () => {
    const sphere = createPrimitive(wasm, 'sphere', { diameter: 40 });
    expect(analyze(weld(soup(sphere, 1e-6), 1e-4)).openEdges).toBe(0);
  });

  it('gentleWeld uses the smallest distance that closes the surface', () => {
    const sphere = createPrimitive(wasm, 'sphere', { diameter: 40 });
    const g = gentleWeld(soup(sphere, 1e-5));
    expect(g.report.openEdges).toBe(0);
    expect(g.report.nonManifoldEdges).toBe(0);
    expect(g.report.triangles).toBe(sphere.indices.length / 3);
  });
});

describe('repair of triangle soup whose corners differ a little', () => {
  const sphere = () => createPrimitive(wasm, 'sphere', { diameter: 40 });

  for (const jitter of [0, 1e-7, 1e-6, 1e-5, 5e-5, 2e-4]) {
    it('gives back a closed solid of the right volume for a jitter of ' + jitter, () => {
      const sp = sphere();
      const expected = volume(sp);
      const r = repairMesh(wasm, soup(sp, jitter));
      expect(Math.abs(volume(r.mesh) / expected - 1)).toBeLessThan(0.001);
    });
  }

  it('says it joined the corners, and the result can be merged', () => {
    const input = soup(sphere(), 1e-5);
    expect(() => meshDataToManifold(wasm, input)).toThrow(); // Manifold alone does not accept it
    const r = repairMesh(wasm, input);
    expect(r.actions[0]).toBe('Joined corners that had come apart');
    expect(r.mesh).not.toBe(input);
    const merged = booleanOp(wasm, 'union', [{ mesh: r.mesh, matrix: I }, { mesh: createPrimitive(wasm, 'cube'), matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 30, 0, 0, 1] }]);
    expect(merged.empty).toBe(false);
  });

  it('still hands back the very same mesh when it was fine as it is', () => {
    const exact = soup(sphere(), 0); // repeated corners are exact copies: Manifold welds them itself
    const r = repairMesh(wasm, exact);
    expect(r.mesh).toBe(exact);
    expect(r.actions).toEqual(['Nothing needed repairing']);
  });
});
