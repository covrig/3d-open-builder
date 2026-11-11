import type { ManifoldToplevel } from 'manifold-3d';
import { bakeMesh, manifoldToMeshData, type MeshData } from './meshData';

export type Vec3 = [number, number, number];

/** Axis-aligned bounds of the vertices. */
export function bounds(data: MeshData): { min: Vec3; max: Vec3 } {
  const p = data.positions;
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < p.length; i += 3) {
    for (let k = 0; k < 3; k++) {
      if (p[i + k] < min[k]) min[k] = p[i + k];
      if (p[i + k] > max[k]) max[k] = p[i + k];
    }
  }
  return { min, max };
}

/**
 * Move the mesh so its bounding-box centre is at the origin.
 * Returns the new mesh and where that centre used to be.
 */
export function recenter(data: MeshData): { mesh: MeshData; center: Vec3 } {
  const { min, max } = bounds(data);
  const center: Vec3 = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2];
  const positions = new Float32Array(data.positions.length);
  for (let i = 0; i < positions.length; i += 3) {
    positions[i] = data.positions[i] - center[0];
    positions[i + 1] = data.positions[i + 1] - center[1];
    positions[i + 2] = data.positions[i + 2] - center[2];
  }
  return { mesh: { positions, indices: data.indices }, center };
}

/** Mirror across the plane through the origin perpendicular to an axis (0 = X, 1 = Y, 2 = Z). */
export function mirrorMesh(data: MeshData, axis: 0 | 1 | 2): MeshData {
  const m = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
  m[axis * 5] = -1; // diagonal entries are at 0, 5, 10
  return bakeMesh({ mesh: data, matrix: m });
}

/**
 * Normal of the plane that mirrors across the line a-b: the plane containing
 * the line and the Z (up) direction. When the line is (nearly) vertical, that
 * is undefined, so the plane through the line that faces `eye` (the camera) is used.
 * Null when a and b coincide or the camera looks along a vertical line.
 */
export function lineMirrorNormal(a: Vec3, b: Vec3, eye: Vec3): Vec3 | null {
  const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const dl = Math.hypot(...d);
  if (dl < 1e-9) return null;
  d[0] /= dl; d[1] /= dl; d[2] /= dl;
  let n: number[];
  if (Math.abs(d[2]) < 0.98) {
    n = [d[1], -d[0], 0]; // d x up
  } else {
    const t = [eye[0] - a[0], eye[1] - a[1], eye[2] - a[2]];
    const k = t[0] * d[0] + t[1] * d[1] + t[2] * d[2];
    n = [t[0] - k * d[0], t[1] - k * d[1], t[2] - k * d[2]];
  }
  const len = Math.hypot(...n);
  if (len < 1e-9) return null;
  return [n[0] / len, n[1] / len, n[2] / len];
}

/** Mirror a point across the plane through `point` with unit normal `n`. */
export function reflectPoint(p: Vec3, point: Vec3, n: Vec3): Vec3 {
  const k = 2 * ((p[0] - point[0]) * n[0] + (p[1] - point[1]) * n[1] + (p[2] - point[2]) * n[2]);
  return [p[0] - k * n[0], p[1] - k * n[1], p[2] - k * n[2]];
}

/**
 * Mirror across the plane through the origin with unit normal `n` (matrix I - 2nn^T).
 * The determinant is -1, so bakeMesh turns the triangles round and the faces keep pointing outward.
 */
export function reflectMesh(data: MeshData, n: Vec3): MeshData {
  const m = [
    1 - 2 * n[0] * n[0], -2 * n[0] * n[1], -2 * n[0] * n[2], 0,
    -2 * n[1] * n[0], 1 - 2 * n[1] * n[1], -2 * n[1] * n[2], 0,
    -2 * n[2] * n[0], -2 * n[2] * n[1], 1 - 2 * n[2] * n[2], 0,
    0, 0, 0, 1,
  ];
  return bakeMesh({ mesh: data, matrix: m }); // symmetric, so row- and column-major agree
}

/**
 * Find the outward normal of the largest flat face of the convex hull.
 * Turning that normal to point straight down makes the object rest on its
 * broadest stable face ("lay flat").
 */
export function largestFlatFaceNormal(wasm: ManifoldToplevel, data: MeshData): Vec3 {
  // Hull of the raw points, so this also works for imported meshes that
  // aren't closed solids.
  const points: Vec3[] = [];
  for (let i = 0; i < data.positions.length; i += 3) {
    points.push([data.positions[i], data.positions[i + 1], data.positions[i + 2]]);
  }
  const hullManifold = wasm.Manifold.hull(points);
  const hull = manifoldToMeshData(hullManifold);
  hullManifold.delete();

  // Hull faces with the same normal are coplanar, so summing triangle areas
  // per (rounded) normal gives each flat face's area.
  const areas = new Map<string, { area: number; normal: Vec3 }>();
  const p = hull.positions;
  const idx = hull.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) continue;
    const normal: Vec3 = [nx / len, ny / len, nz / len];
    const key = normal.map((v) => Math.round(v * 1000)).join(',');
    const entry = areas.get(key) ?? { area: 0, normal };
    entry.area += len / 2;
    areas.set(key, entry);
  }
  let best: { area: number; normal: Vec3 } = { area: -1, normal: [0, 0, -1] };
  for (const entry of areas.values()) {
    // Prefer the face already facing down when areas tie (within 0.1%).
    if (entry.area > best.area * 1.001 || (entry.area > best.area * 0.999 && entry.normal[2] < best.normal[2])) {
      best = entry;
    }
  }
  return best.normal;
}
