import type { MeshData } from './meshData';

/** A neighbour that turns away by less than this (cosine of 25 degrees) counts as a smooth continuation, not a real edge. */
const SMOOTH_COS = Math.cos((25 * Math.PI) / 180);

/** Triangles per edge (vertex indices are shared in our meshes), worked out once per mesh. */
const edgeCache = new WeakMap<MeshData, Map<number, number[]>>();
function edgeTrianglesOf(mesh: MeshData): Map<number, number[]> {
  let edgeTris = edgeCache.get(mesh);
  if (edgeTris) return edgeTris;
  edgeTris = new Map<number, number[]>();
  const idx = mesh.indices;
  const triCount = idx.length / 3;
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const u = idx[t * 3 + k], v = idx[t * 3 + ((k + 1) % 3)];
      const key = u < v ? u * 67108864 + v : v * 67108864 + u;
      const list = edgeTris.get(key);
      if (list) list.push(t);
      else edgeTris.set(key, [t]);
    }
  }
  edgeCache.set(mesh, edgeTris);
  return edgeTris;
}

export interface FaceRegion {
  /** Area-weighted centre, in the mesh's own coordinates */
  centre: [number, number, number];
  /** The triangles of the region */
  triangles: Set<number>;
  /**
   * True for a real flat face. False for the tiny "region" of a curved surface
   * (a cylinder wall, a sphere) whose triangles are only each in their own
   * plane: most of its border continues smoothly into neighbours.
   */
  flat: boolean;
}

/**
 * The flat face that triangle `tri` belongs to: all triangles reachable from
 * it through shared edges that lie in the same plane, with their area-weighted
 * centre.
 */
export function flatFaceRegion(mesh: MeshData, tri: number): FaceRegion {
  const p = mesh.positions;
  const idx = mesh.indices;
  const normal = (t: number) => {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const len = Math.hypot(n[0], n[1], n[2]);
    return { n: n.map((v) => v / (len || 1)), area: len / 2 };
  };
  const edgeTris = edgeTrianglesOf(mesh);
  const n0 = normal(tri).n;
  const seen = new Set([tri]);
  const queue = [tri];
  let cx = 0, cy = 0, cz = 0, total = 0;
  // Border edges of the region, and how many of them continue smoothly.
  let border = 0, smooth = 0;
  while (queue.length) {
    const t = queue.pop()!;
    const { area } = normal(t);
    for (let k = 0; k < 3; k++) {
      const i = idx[t * 3 + k] * 3;
      cx += (p[i] * area) / 3;
      cy += (p[i + 1] * area) / 3;
      cz += (p[i + 2] * area) / 3;
    }
    total += area;
    const tn = normal(t).n;
    for (let k = 0; k < 3; k++) {
      const u = idx[t * 3 + k], v = idx[t * 3 + ((k + 1) % 3)];
      for (const nb of edgeTris.get(u < v ? u * 67108864 + v : v * 67108864 + u) ?? []) {
        if (nb === t) continue;
        const n = normal(nb).n;
        const dot = n[0] * n0[0] + n[1] * n0[1] + n[2] * n0[2];
        if (dot < 0.9999) {
          // Not in the same plane: a border edge (counted from the region's side only).
          border++;
          if (n[0] * tn[0] + n[1] * tn[1] + n[2] * tn[2] > SMOOTH_COS) smooth++;
          continue;
        }
        if (seen.has(nb)) continue;
        seen.add(nb);
        queue.push(nb);
      }
    }
  }
  const centre: [number, number, number] =
    total > 0 ? [cx / total, cy / total, cz / total] : [p[idx[tri * 3] * 3], p[idx[tri * 3] * 3 + 1], p[idx[tri * 3] * 3 + 2]];
  return { centre, triangles: seen, flat: border === 0 || smooth * 2 < border };
}

/**
 * Centre (area-weighted) of the flat face that triangle `tri` belongs to
 * (see flatFaceRegion). Used to centre text or a hole on a face.
 */
export function flatFaceCentre(mesh: MeshData, tri: number): [number, number, number] {
  return flatFaceRegion(mesh, tri).centre;
}
