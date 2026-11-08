import type { MeshData } from './meshData';

/**
 * Centre (area-weighted) of the flat face that triangle `tri` belongs to: all
 * triangles reachable from it through shared edges that lie in the same
 * plane. Used to centre text or a hole on a face.
 */
export function flatFaceCentre(mesh: MeshData, tri: number): [number, number, number] {
  const p = mesh.positions;
  const idx = mesh.indices;
  const triCount = idx.length / 3;
  const normal = (t: number) => {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const n = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const len = Math.hypot(n[0], n[1], n[2]);
    return { n: n.map((v) => v / (len || 1)), area: len / 2 };
  };
  // Triangles per edge (vertex indices are shared in our meshes).
  const edgeTris = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const u = idx[t * 3 + k], v = idx[t * 3 + ((k + 1) % 3)];
      const key = u < v ? u * 67108864 + v : v * 67108864 + u;
      const list = edgeTris.get(key);
      if (list) list.push(t);
      else edgeTris.set(key, [t]);
    }
  }
  const n0 = normal(tri).n;
  const seen = new Set([tri]);
  const queue = [tri];
  let cx = 0, cy = 0, cz = 0, total = 0;
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
    for (let k = 0; k < 3; k++) {
      const u = idx[t * 3 + k], v = idx[t * 3 + ((k + 1) % 3)];
      for (const nb of edgeTris.get(u < v ? u * 67108864 + v : v * 67108864 + u) ?? []) {
        if (seen.has(nb)) continue;
        const n = normal(nb).n;
        if (n[0] * n0[0] + n[1] * n0[1] + n[2] * n0[2] < 0.9999) continue; // not in the same plane
        seen.add(nb);
        queue.push(nb);
      }
    }
  }
  return total > 0 ? [cx / total, cy / total, cz / total] : [p[idx[tri * 3] * 3], p[idx[tri * 3] * 3 + 1], p[idx[tri * 3] * 3 + 2]];
}
