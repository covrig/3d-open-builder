import type { ManifoldToplevel } from 'manifold-3d';
import { manifoldToMeshData } from './meshData';

type Vec3 = [number, number, number];

/**
 * The normal of the triangle whose corners start at positions `a`, `b` and `c`
 * of `p` (already multiplied by the stride, so a vertex index times 3 for plain
 * positions), written to `out`. It is not made unit length: its length is twice
 * the triangle's area, and 0 for a flat sliver. Pass the same `out` array in a
 * loop so nothing is allocated per triangle.
 */
export function triangleNormal(p: ArrayLike<number>, a: number, b: number, c: number, out: { [i: number]: number }): void {
  const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
  const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
  out[0] = uy * vz - uz * vy;
  out[1] = uz * vx - ux * vz;
  out[2] = ux * vy - uy * vx;
}

/**
 * The flat faces of the convex hull of some points: one entry per distinct
 * (rounded) outward unit normal `n`, with the summed `area` of the hull's
 * triangles that face that way. Works on raw points, so it also suits imported
 * meshes that aren't closed solids.
 */
export function hullFaces(wasm: ManifoldToplevel, positions: Float32Array): { n: Vec3; area: number }[] {
  const points: Vec3[] = [];
  for (let i = 0; i < positions.length; i += 3) points.push([positions[i], positions[i + 1], positions[i + 2]]);
  const hullManifold = wasm.Manifold.hull(points);
  const hull = manifoldToMeshData(hullManifold);
  hullManifold.delete();

  // Hull triangles with the same normal are coplanar, so summing their areas per rounded normal gives each face's area.
  const faces = new Map<string, { n: Vec3; area: number }>();
  const p = hull.positions;
  const idx = hull.indices;
  const m = [0, 0, 0];
  for (let t = 0; t < idx.length; t += 3) {
    triangleNormal(p, idx[t] * 3, idx[t + 1] * 3, idx[t + 2] * 3, m);
    const len = Math.hypot(m[0], m[1], m[2]);
    if (len === 0) continue;
    const n: Vec3 = [m[0] / len, m[1] / len, m[2] / len];
    const key = n.map((v) => Math.round(v * 1000)).join(',');
    const face = faces.get(key) ?? { n, area: 0 };
    face.area += len / 2;
    faces.set(key, face);
  }
  return [...faces.values()];
}
