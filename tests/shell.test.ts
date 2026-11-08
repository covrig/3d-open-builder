import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { shell, wallsFit } from '../src/geometry/features';
import { meshDataToManifold } from '../src/geometry/meshData';
import { makeThreaded } from '../src/geometry/threads';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

describe('shell: do the walls fit?', () => {
  it('finds room in solid shapes', () => {
    expect(wallsFit(wasm.Manifold.cube([20, 20, 20], true), 2)).toBe(true);
    expect(wallsFit(wasm.Manifold.sphere(10, 48), 4)).toBe(true);
  });

  it('refuses walls that cannot fit', () => {
    // 20 mm cube: two 11 mm walls need 22 mm.
    expect(wallsFit(wasm.Manifold.cube([20, 20, 20], true), 11)).toBe(false);
    // 3 mm plate: two 2 mm walls need 4 mm.
    expect(wallsFit(wasm.Manifold.cube([40, 40, 3], true), 2)).toBe(false);
    // Tube with 3 mm of material: no room for 2 mm walls on both sides.
    const tube = wasm.Manifold.cylinder(20, 13, 13, 64).subtract(wasm.Manifold.cylinder(20, 10, 10, 64).translate([0, 0, 0]));
    expect(wallsFit(tube, 2)).toBe(false);
  });

  it('hollows bolts and nuts from a plain stand-in, keeping the thread outside', () => {
    const volume = (mesh: { positions: Float32Array; indices: Uint32Array }) => {
      const m = meshDataToManifold(wasm, mesh);
      const v = m.volume();
      m.delete();
      return v;
    };
    for (const [kind, size, wall] of [['bolt', 'M10', 1.5], ['nut', 'M16', 1]] as const) {
      const part = makeThreaded(wasm, { kind, size, length: 30, clearance: 0.2 });
      const thread = { kind, size, length: 30, clearance: 0.2, origin: part.center };
      const r = shell(wasm, { mesh: part.mesh, matrix: IDENTITY }, wall, thread);
      const before = volume(part.mesh), after = volume(r.mesh);
      // Something was hollowed out...
      expect(after).toBeLessThan(before * 0.95);
      // ...only from the inside: the result lies within the original, so what
      // was removed is exactly the volume lost, and the outer surface with its
      // thread is untouched (the result's outer bounds match).
      const original = meshDataToManifold(wasm, part.mesh);
      const result = meshDataToManifold(wasm, r.mesh, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...r.center, 1]);
      const removed = original.subtract(result);
      expect(removed.volume()).toBeCloseTo(before - after, 0);
      const [a, b] = [original.boundingBox(), result.boundingBox()];
      for (let k = 0; k < 3; k++) {
        expect(b.min[k]).toBeCloseTo(a.min[k], 3);
        expect(b.max[k]).toBeCloseTo(a.max[k], 3);
      }
      for (const m of [original, result, removed]) m.delete();
    }
  });

  it('refuses detailed objects without a stand-in instead of running for minutes', () => {
    const bolt = makeThreaded(wasm, { kind: 'bolt', size: 'M6', length: 20, clearance: 0 });
    expect(bolt.mesh.indices.length / 3).toBeGreaterThan(20000);
    expect(() => shell(wasm, { mesh: bolt.mesh, matrix: IDENTITY }, 1)).toThrow(/triangles/);
  });

  it('refuses an M10 nut with 2 mm walls quickly, instead of hollowing for seconds', () => {
    const nut = meshDataToManifold(wasm, makeThreaded(wasm, { kind: 'nut', size: 'M10', length: 0, clearance: 0.2 }).mesh);
    const t0 = performance.now();
    expect(wallsFit(nut, 2)).toBe(false);
    expect(performance.now() - t0).toBeLessThan(5000);
    expect(() => shell(wasm, { mesh: makeThreaded(wasm, { kind: 'nut', size: 'M10', length: 0, clearance: 0.2 }).mesh, matrix: IDENTITY }, 2))
      .toThrow(/walls don't fit/);
  });
});
