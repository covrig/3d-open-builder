import type { Manifold, ManifoldToplevel, Vec3 } from 'manifold-3d';
import { bakeMesh, manifoldToMeshData, meshDataToManifold, type MeshData, type PlacedMesh } from './meshData';
import { recenter } from './meshOps';

export interface Piece {
  /** centred on its own bounding box */
  mesh: MeshData;
  /** world position of that centre */
  center: [number, number, number];
}

export function toPiece(m: Manifold): Piece | null {
  if (m.isEmpty()) return null;
  const { mesh, center } = recenter(manifoldToMeshData(m));
  return { mesh, center };
}

/**
 * Cut an object with the plane {p : p·normal = offset} (normal is a unit
 * vector, world space). Returns the piece on the side the normal points to
 * and the piece on the other side; either is null if the plane misses.
 */
export function splitByPlane(
  wasm: ManifoldToplevel,
  item: PlacedMesh,
  normal: Vec3,
  offset: number,
): { positive: Piece | null; negative: Piece | null } {
  const solid = meshDataToManifold(wasm, item.mesh, item.matrix);
  const [pos, neg] = solid.splitByPlane(normal, offset);
  try {
    return { positive: toPiece(pos), negative: toPiece(neg) };
  } finally {
    solid.delete();
    pos.delete();
    neg.delete();
  }
}

/**
 * Extend an object straight down to the plate (z = floor), filling the space
 * under every downward-facing surface, like a solid support.
 *
 * Each downward-facing triangle sweeps a prism down to the floor (the hull of
 * the triangle and its shadow); the union of the object with all prisms is
 * exactly the object's downward sweep.
 */
export function extrudeDown(wasm: ManifoldToplevel, item: PlacedMesh, floor = 0): Piece | null {
  const world = bakeMesh(item);
  const p = world.positions;
  const idx = world.indices;
  const parts: Manifold[] = [meshDataToManifold(wasm, world)];
  try {
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
      // z of the triangle normal (no need to normalise for the sign)
      const nz = (p[b] - p[a]) * (p[c + 1] - p[a + 1]) - (p[b + 1] - p[a + 1]) * (p[c] - p[a]);
      if (nz >= -1e-9) continue; // not facing down
      const tri: Vec3[] = [a, b, c].map((i) => [p[i], p[i + 1], p[i + 2]] as Vec3);
      if (tri.every((v) => v[2] <= floor + 1e-4)) continue; // already on the plate
      const shadow = tri.map((v) => [v[0], v[1], floor] as Vec3);
      parts.push(wasm.Manifold.hull([...tri, ...shadow]));
    }
    const merged = wasm.Manifold.union(parts);
    const trimmed = merged.trimByPlane([0, 0, 1], floor);
    merged.delete();
    try {
      const status = trimmed.status();
      if (status !== 'NoError') throw new Error(`Extrude failed (${status})`);
      return toPiece(trimmed);
    } finally {
      trimmed.delete();
    }
  } finally {
    for (const m of parts) m.delete();
  }
}
