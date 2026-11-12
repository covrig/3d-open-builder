import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { meshDataToManifold } from '../src/geometry/meshData';
import { ISO_THREADS, makeThreaded, type ThreadSize } from '../src/geometry/threads';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const triangles = (size: ThreadSize, length: number, quality?: 'draft' | 'normal' | 'fine') =>
  makeThreaded(wasm, { kind: 'rod', size, length, clearance: 0, quality }).mesh.indices.length / 3;

/** Largest and smallest distance from the axis, over cuts across one pitch in the middle of a rod. */
function radiusRange(size: ThreadSize): { maxR: number[]; minR: number[] } {
  const { P } = ISO_THREADS[size];
  const rod = makeThreaded(wasm, { kind: 'rod', size, length: 6 * P, clearance: 0 });
  // The mesh is centred; put it back where it was built (z from 0 to the length).
  const [cx, cy, cz] = rod.center;
  const solid = meshDataToManifold(wasm, rod.mesh, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, cx, cy, cz, 1]);
  const maxR: number[] = [];
  const minR: number[] = [];
  for (let i = 0; i < 160; i++) {
    const z = 2.5 * P + (i / 160) * P;
    const section = solid.slice(z);
    const radii = section.toPolygons().flat().map(([x, y]) => Math.hypot(x, y));
    section.delete();
    maxR.push(Math.max(...radii));
    minR.push(Math.min(...radii));
  }
  solid.delete();
  return { maxR, minR };
}

describe('thread mesh quality', () => {
  for (const size of ['M6', 'M20'] as const) {
    it(`${size}: crest and root stay within a fraction of a percent along the helix`, () => {
      const { d, P } = ISO_THREADS[size];
      const crest = d / 2;
      const root = d / 2 - 0.625 * 0.8660254 * P;
      const { maxR, minR } = radiusRange(size);
      for (const r of maxR) {
        expect(r).toBeLessThanOrEqual(crest + 1e-4);
        expect(r).toBeGreaterThan(crest * (1 - 0.005));
      }
      for (const r of minR) {
        expect(r).toBeGreaterThanOrEqual(root * (1 - 0.006));
        expect(r).toBeLessThan(root * (1 + 0.006));
      }
    });
  }

  it('Draft, Normal and Fine differ in triangle count', () => {
    const normal = triangles('M6', 20);
    expect(Math.abs(normal - 46364) / 46364).toBeLessThan(0.15);
    expect(triangles('M6', 20, 'draft')).toBeLessThan(normal * 0.6);
    expect(triangles('M6', 20, 'fine')).toBeGreaterThan(normal * 1.5);
  });
});
