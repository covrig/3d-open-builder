import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { meshDataToManifold, type MeshData } from '../src/geometry/meshData';
import { bounds } from '../src/geometry/meshOps';
import { createPrimitive, PRIMITIVE_NAMES, type PrimitiveKind } from '../src/geometry/primitives';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

function volume(mesh: MeshData): number {
  const m = meshDataToManifold(wasm, mesh);
  try {
    return m.volume();
  } finally {
    m.delete();
  }
}

describe('shape dimensions', () => {
  it('keeps the default shapes as they were before measurements could be set', () => {
    // Volumes measured with the version that had no measurements. (The hexagon is now 40 across
    // its flats rather than its corners: 40 × (3√3/2)·(40/√3)² / 40 = 55425.6.)
    const before: Partial<Record<PrimitiveKind, number>> = {
      cube: 64000, cylinder: 50184.7760233466, sphere: 33321.09142071179, cone: 16728.25867444887,
      pyramid: 21333.333333333332, wedge: 32000, tube: 21955.839507463443, torus: 9868.888615274438,
      dome: 16660.545711404946,
    };
    for (const [kind, v] of Object.entries(before)) {
      expect(volume(createPrimitive(wasm, kind as PrimitiveKind)), kind).toBeCloseTo(v, 3);
    }
    expect(volume(createPrimitive(wasm, 'hexagon'))).toBeCloseTo(55425.62, 1);
  });

  it('builds every shape, centred, with a watertight mesh', () => {
    for (const kind of Object.keys(PRIMITIVE_NAMES) as PrimitiveKind[]) {
      const mesh = createPrimitive(wasm, kind);
      const b = bounds(mesh);
      expect(volume(mesh), kind).toBeGreaterThan(1000);
      expect(Math.abs(b.min[0] + b.max[0]), kind).toBeLessThan(1);
    }
  });

  it('makes a cube of the given width, depth and height', () => {
    const mesh = createPrimitive(wasm, 'cube', { width: 10, depth: 20, height: 30 });
    expect(volume(mesh)).toBeCloseTo(6000, 3);
    const b = bounds(mesh);
    expect([b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]]).toEqual([10, 20, 30]);
  });

  it('makes a tube from its outer and inner diameter', () => {
    const v = volume(createPrimitive(wasm, 'tube', { diameter: 40, innerDiameter: 30, height: 40 }));
    expect(v / (Math.PI * (20 ** 2 - 15 ** 2) * 40)).toBeGreaterThan(0.99);
    expect(v / (Math.PI * (20 ** 2 - 15 ** 2) * 40)).toBeLessThan(1.001);
    expect(() => createPrimitive(wasm, 'tube', { diameter: 30, innerDiameter: 30 })).toThrow(/inner diameter/);
  });

  it('makes a wedge from the three sides of its triangle', () => {
    // 30-40-50 is a right triangle: the base (30) and side b (40) are its legs, so its area is 600 and depth 10 gives 6000.
    const mesh = createPrimitive(wasm, 'wedge', { sideA: 30, sideB: 40, sideC: 50, depth: 10 });
    expect(volume(mesh)).toBeCloseTo(6000, 3);
    const b = bounds(mesh);
    expect(b.max[1] - b.min[1]).toBeCloseTo(10, 5);
    expect(b.max[0] - b.min[0]).toBeCloseTo(30, 5);
    expect(b.max[2] - b.min[2]).toBeCloseTo(40, 5);
  });

  it('refuses sides that cannot form a triangle', () => {
    expect(() => createPrimitive(wasm, 'wedge', { sideA: 10, sideB: 10, sideC: 30 })).toThrow(/can't form a triangle/);
    expect(() => createPrimitive(wasm, 'wedge', { sideA: 10, sideB: 10, sideC: 20 })).toThrow(/can't form a triangle/);
  });

  it('makes a regular tetrahedron resting on a face', () => {
    const mesh = createPrimitive(wasm, 'tetrahedron', { edge: 40 });
    expect(volume(mesh) / (40 ** 3 / (6 * Math.SQRT2))).toBeCloseTo(1, 5);
    expect(volume(mesh)).toBeCloseTo(7542.5, 0);
  });

  it('makes a cone, truncated when the top has a diameter', () => {
    const point = volume(createPrimitive(wasm, 'cone', { diameter: 20, topDiameter: 0, height: 30 }));
    const cut = volume(createPrimitive(wasm, 'cone', { diameter: 20, topDiameter: 10, height: 30 }));
    expect(cut).toBeGreaterThan(point);
    expect(cut / (Math.PI / 3 * 30 * (10 ** 2 + 10 * 5 + 5 ** 2))).toBeGreaterThan(0.99);
  });

  it('makes a pyramid, hexagon, torus and dome of the given size', () => {
    expect(volume(createPrimitive(wasm, 'pyramid', { width: 30, depth: 20, height: 12 }))).toBeCloseTo((30 * 20 * 12) / 3, 3);
    const hex = bounds(createPrimitive(wasm, 'hexagon', { width: 20, height: 10 }));
    expect(hex.max[1] - hex.min[1]).toBeCloseTo(20, 5); // across the flats (Y)
    expect(hex.max[2] - hex.min[2]).toBeCloseTo(10, 5);
    const torus = bounds(createPrimitive(wasm, 'torus', { diameter: 50, thickness: 10 }));
    expect(torus.max[0] - torus.min[0]).toBeCloseTo(50, 1);
    expect(torus.max[2] - torus.min[2]).toBeCloseTo(10, 1);
    expect(() => createPrimitive(wasm, 'torus', { diameter: 20, thickness: 10 })).toThrow(/less than half/);
    const dome = bounds(createPrimitive(wasm, 'dome', { diameter: 30 }));
    expect(dome.max[2] - dome.min[2]).toBeCloseTo(15, 1);
  });

  it('refuses sizes of zero or less', () => {
    expect(() => createPrimitive(wasm, 'cube', { width: 0 })).toThrow(/more than 0/);
    expect(() => createPrimitive(wasm, 'sphere', { diameter: -5 })).toThrow(/more than 0/);
  });
});
