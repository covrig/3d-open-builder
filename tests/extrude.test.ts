import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { extrudeToPlane } from '../src/geometry/cut';
import { countPieces } from '../src/geometry/meshCheck';
import { meshDataToManifold, type MeshData } from '../src/geometry/meshData';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const lift = (z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, z, 1];
const meshOf = (make: () => ReturnType<ManifoldToplevel['Manifold']['cube']>): MeshData => {
  const m = make();
  const g = m.getMesh();
  m.delete();
  return { positions: g.vertProperties.slice(), indices: g.triVerts.slice() };
};
const volume = (mesh: MeshData) => {
  const m = meshDataToManifold(wasm, mesh);
  const v = m.volume();
  m.delete();
  return v;
};

describe('extrude down with a plane', () => {
  it('keeps what is above the plane and extends the cut shape to the plate', () => {
    // A 20 mm cube floating 10 mm above the plate, plane 5 mm into it.
    const cube = meshOf(() => wasm.Manifold.cube([20, 20, 20], true));
    const r = extrudeToPlane(wasm, { mesh: cube, matrix: lift(20) }, 15);
    // Above the plane: 20 × 20 × 15; below: 20 × 20 × 15 down to the plate.
    expect(volume(r.mesh)).toBeCloseTo(20 * 20 * 30, 0);
    expect(countPieces(r.mesh)).toBe(1);
    expect(r.center[2]).toBeCloseTo(15, 3);
  });

  it('replaces the part below the plane by the shape at the plane (upside-down cone)', () => {
    // Cone, point down: radius 0 at z = 0 → 20 at z = 40 (local), lifted so the tip is at z = 10.
    const cone = meshOf(() => wasm.Manifold.cylinder(40, 0, 20, 64));
    const r = extrudeToPlane(wasm, { mesh: cone, matrix: lift(10) }, 30);
    const solid = meshDataToManifold(wasm, cone, lift(10));
    const above = solid.trimByPlane([0, 0, 1], 30);
    const section = solid.slice(30).area();
    const expected = above.volume() + section * 30;
    above.delete();
    solid.delete();
    expect(volume(r.mesh)).toBeCloseTo(expected, 0);
    expect(countPieces(r.mesh)).toBe(1);
  });

  it('refuses a plane that misses the object', () => {
    const cube = meshOf(() => wasm.Manifold.cube([10, 10, 10], true));
    expect(() => extrudeToPlane(wasm, { mesh: cube, matrix: lift(20) }, 40)).toThrow(/cuts through/);
    expect(() => extrudeToPlane(wasm, { mesh: cube, matrix: lift(20) }, 0)).toThrow(/above the plate/);
  });
});
