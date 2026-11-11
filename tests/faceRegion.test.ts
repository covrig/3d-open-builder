import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { flatFaceRegion } from '../src/geometry/faceRegion';
import { createPrimitive } from '../src/geometry/primitives';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

describe('flatFaceRegion', () => {
  it('finds the centre of every face of a cube', () => {
    const cube = createPrimitive(wasm, 'cube', { width: 10, depth: 10, height: 10 });
    for (let t = 0; t < cube.indices.length / 3; t++) {
      const r = flatFaceRegion(cube, t);
      expect(r.flat).toBe(true);
      expect(r.triangles.size).toBe(2);
      // The centre lies on a face of the cube: one coordinate is +-5, the others 0.
      const onFace = r.centre.filter((v) => Math.abs(Math.abs(v) - 5) < 1e-4).length;
      const zero = r.centre.filter((v) => Math.abs(v) < 1e-4).length;
      expect([onFace, zero]).toEqual([1, 2]);
    }
  });

  it('does not treat a curved wall as a flat face, but does its end caps', () => {
    const cyl = createPrimitive(wasm, 'cylinder', { diameter: 20, height: 10 });
    const flat: number[] = [];
    let curved = 0;
    for (let t = 0; t < cyl.indices.length / 3; t++) {
      const r = flatFaceRegion(cyl, t);
      if (r.flat) flat.push(r.triangles.size);
      else curved++;
    }
    expect(curved).toBeGreaterThan(0);
    expect(Math.max(...flat)).toBeGreaterThan(10); // the caps
    const sphere = createPrimitive(wasm, 'sphere', { diameter: 20 });
    for (let t = 0; t < sphere.indices.length / 3; t++) expect(flatFaceRegion(sphere, t).flat).toBe(false);
  });
});
