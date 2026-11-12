import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { extrudeToPlane } from '../src/geometry/cut';
import { findEdges } from '../src/geometry/edges';
import { bakeMesh, meshDataToManifold, type MeshData } from '../src/geometry/meshData';
import { bounds } from '../src/geometry/meshOps';
import { createPrimitive } from '../src/geometry/primitives';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const lift = (z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, z, 1];
const volume = (mesh: MeshData) => {
  const m = meshDataToManifold(wasm, mesh);
  const v = m.volume();
  m.delete();
  return v;
};
const shells = (mesh: MeshData) => {
  const m = meshDataToManifold(wasm, mesh);
  const parts = m.decompose();
  const n = parts.length;
  for (const p of parts) p.delete();
  m.delete();
  return n;
};
/** Mesh in world space, given the piece's centre. */
const inWorld = (r: { mesh: MeshData; center: [number, number, number] }) => bakeMesh({ mesh: r.mesh, matrix: lift(0).map((v, i) => (i === 14 ? r.center[2] : i === 12 ? r.center[0] : i === 13 ? r.center[1] : v)) });
const smallest = (mesh: MeshData) => {
  const p = mesh.positions, ix = mesh.indices;
  let least = Infinity;
  for (let t = 0; t < ix.length; t += 3) {
    const [a, b, c] = [ix[t] * 3, ix[t + 1] * 3, ix[t + 2] * 3];
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    least = Math.min(least, Math.hypot(uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx) / 2);
  }
  return least;
};

describe('extrude down leaves no step at the plane', () => {
  it('a sphere cut at z = 45: one ring of sharp edges at the plane, nothing collapsed', () => {
    const sphere = createPrimitive(wasm, 'sphere', { diameter: 40 }); // centred, lifted to z = 30
    const r = extrudeToPlane(wasm, { mesh: sphere, matrix: lift(30) }, 45);
    const world = inWorld(r);
    expect(smallest(world)).toBeGreaterThan(1e-12);
    const edges = findEdges(world);
    expect(edges.segments.length).toBeGreaterThan(0);
    for (const s of edges.segments) {
      // No phantom edge with a zero face normal.
      expect(Math.hypot(...s.n1)).toBeGreaterThan(0.99);
      expect(Math.hypot(...s.n2)).toBeGreaterThan(0.99);
      // All sharp edges are at the plane (45) or the plate (0): none 1 µm off.
      for (const z of [s.a[2], s.b[2]]) {
        expect(Math.min(Math.abs(z - 45), Math.abs(z))).toBeLessThan(1e-6);
      }
    }
    expect(edges.segments.filter((s) => Math.abs(s.a[2] - 45) < 1e-6).length).toBeGreaterThanOrEqual(32);
    // The same solid as before: 25,924.84 mm³ (the old method added about 0.5 mm³ for the 1 µm overlap).
    expect(Math.abs(volume(r.mesh) / 25924.84 - 1)).toBeLessThan(1e-4);
  });

  it('a cylinder cut through its middle: 12,546.19 mm³, from the plate up to z = 40', () => {
    const cylinder = createPrimitive(wasm, 'cylinder', { diameter: 20, height: 20 });
    const r = extrudeToPlane(wasm, { mesh: cylinder, matrix: lift(30) }, 30);
    expect(volume(r.mesh)).toBeCloseTo(12546.19, 1);
    const b = bounds(inWorld(r));
    expect(b.min[2]).toBeCloseTo(0, 4);
    expect(b.max[2]).toBeCloseTo(40, 4);
  });

  it('two separate cubes in one object stay two shells', () => {
    const a = wasm.Manifold.cube([10, 10, 10], true);
    const b = a.translate([30, 0, 0]);
    const both = wasm.Manifold.compose([a, b]);
    const g = both.getMesh();
    const mesh: MeshData = { positions: g.vertProperties.slice(), indices: g.triVerts.slice() };
    const r = extrudeToPlane(wasm, { mesh, matrix: lift(30) }, 30);
    expect(shells(r.mesh)).toBe(2);
    expect(volume(r.mesh)).toBeCloseTo(7000, 2);
  });
});
