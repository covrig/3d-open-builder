import type { Manifold, ManifoldToplevel, Vec3 } from 'manifold-3d';
import { manifoldToMeshData, meshDataToManifold, type MeshData, type PlacedMesh } from './meshData';
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
 * Extrude down with a plane at `height`: the object above the plane stays as
 * it is; below it, the object is replaced by its cross-section at the plane,
 * pushed straight down to the plate (z = floor). One slice, one extrusion and
 * one join, so it is quick whatever the object (threads included).
 */
export function extrudeToPlane(wasm: ManifoldToplevel, item: PlacedMesh, height: number, floor = 0): Piece {
  if (!(height > floor)) throw new Error('Put the plane above the plate');
  const solid = meshDataToManifold(wasm, item.mesh, item.matrix);
  const owned: { delete(): void }[] = [solid];
  const keep = <T extends { delete(): void }>(m: T): T => {
    owned.push(m);
    return m;
  };
  try {
    const section = keep(solid.slice(height));
    if (section.isEmpty() || section.area() <= 1e-9) throw new Error('Move the plane so it cuts through the object');
    const top = keep(solid.trimByPlane([0, 0, 1], height));
    // The column reaches a hair (1 µm) into the part above, so the two fuse into
    // one solid instead of only touching at the plane.
    const column = keep(keep(section.extrude(height - floor + 0.001)).translate([0, 0, floor]));
    const result = keep(top.isEmpty() ? column : top.add(column));
    const status = result.status();
    if (status !== 'NoError') throw new Error(`Extrude failed (${status})`);
    const piece = toPiece(result);
    if (!piece) throw new Error('Nothing is left to extrude');
    return piece;
  } finally {
    for (const m of owned) m.delete();
  }
}