import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { analyze } from '../src/geometry/meshCheck';
import { manifoldToMeshData, meshDataToManifold } from '../src/geometry/meshData';
import { bounds, lineMirrorNormal, planeNormal, recenter, reflectMesh, reflectPoint, type Vec3 } from '../src/geometry/meshOps';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

describe('mirroring across a plane', () => {
  it('keeps volume and orientation and lands where expected', () => {
    // An asymmetric solid (an L) so a wrong reflection would show.
    const a = wasm.Manifold.cube([4, 2, 2], true);
    const b = wasm.Manifold.cube([2, 2, 6], true).translate([1, 0, 2]);
    const solid = a.add(b);
    const mesh = manifoldToMeshData(solid);
    const volume = solid.volume();

    const n = planeNormal([0, 0, 0], [1, 0, 1], [0, 1, 0]) as Vec3; // slanted plane through the origin
    expect(n).not.toBeNull();
    const reflected = reflectMesh(mesh, n);
    const m = meshDataToManifold(wasm, reflected);
    expect(m.volume()).toBeCloseTo(volume, 3);
    expect(m.volume()).toBeGreaterThan(0);
    expect(analyze(reflected).signedVolume).toBeGreaterThan(0);
    expect(analyze(reflected).flippedEdges).toBe(0);

    // Every vertex is the mirror image of the original one.
    for (let i = 0; i < mesh.positions.length; i += 3) {
      const p: Vec3 = [mesh.positions[i], mesh.positions[i + 1], mesh.positions[i + 2]];
      const q = reflectPoint(p, [0, 0, 0], n);
      expect(reflected.positions[i]).toBeCloseTo(q[0], 4);
      expect(reflected.positions[i + 1]).toBeCloseTo(q[1], 4);
      expect(reflected.positions[i + 2]).toBeCloseTo(q[2], 4);
    }
    m.delete();
    solid.delete();
  });

  it('places a cube across a plane away from the origin', () => {
    const cube = wasm.Manifold.cube([2, 2, 2], true);
    const mesh = manifoldToMeshData(cube);
    cube.delete();
    // Plane x = 10 (three points on it): a cube centred at x = 4 ends up centred at x = 16.
    const n = planeNormal([10, 0, 0], [10, 1, 0], [10, 0, 1]) as Vec3;
    const centre = reflectPoint([4, 3, 5], [10, 0, 0], n);
    expect(centre[0]).toBeCloseTo(16, 6);
    expect(centre[1]).toBeCloseTo(3, 6);
    expect(centre[2]).toBeCloseTo(5, 6);
    const { mesh: baked, center } = recenter(reflectMesh(mesh, n));
    expect(center[0]).toBeCloseTo(0, 6);
    const b = bounds(baked);
    expect(b.max[0] - b.min[0]).toBeCloseTo(2, 6);
  });

  it('rejects collinear points and builds line planes', () => {
    expect(planeNormal([0, 0, 0], [1, 1, 1], [2, 2, 2])).toBeNull();
    // A line along X: the plane containing it and the vertical has a normal along Y.
    const n = lineMirrorNormal([0, 0, 0], [5, 0, 0], [0, -50, 20]) as Vec3;
    expect(Math.abs(n[1])).toBeCloseTo(1, 6);
    // A vertical line: the plane faces the camera (camera on -Y: normal along Y).
    const v = lineMirrorNormal([0, 0, 0], [0, 0, 5], [0, -50, 20]) as Vec3;
    expect(Math.abs(v[1])).toBeCloseTo(1, 6);
    expect(Math.abs(v[2])).toBeLessThan(1e-9);
  });
});
