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
export function extrudeToPlane(
  wasm: ManifoldToplevel,
  item: PlacedMesh,
  /** a level plane at this height, or any plane (point + unit normal pointing up-ish) */
  plane: number | { point: Vec3; normal: Vec3 },
  floor = 0,
): Piece {
  const point: Vec3 = typeof plane === 'number' ? [0, 0, plane] : plane.point;
  const normal: Vec3 = typeof plane === 'number' ? [0, 0, 1] : plane.normal;
  const height = point[2];
  if (!(height > floor)) throw new Error('Put the plane above the plate');
  if (!(normal[2] > 0.1)) throw new Error('Tilt the plane less: it must face upwards');
  const level = Math.abs(normal[0]) < 1e-9 && Math.abs(normal[1]) < 1e-9;
  const solid = meshDataToManifold(wasm, item.mesh, item.matrix);
  const owned: { delete(): void }[] = [solid];
  const keep = <T extends { delete(): void }>(m: T): T => {
    owned.push(m);
    return m;
  };
  try {
    // A tilted plane z = height - (a·(x - px) + b·(y - py)): shearing the solid by
    // z' = z + a·x + b·y + c makes the plane z' = 0 without moving x or y, so one
    // ordinary slice gives the cross-section already in plan view.
    const a = normal[0] / normal[2], b = normal[1] / normal[2];
    const c = -(height + a * point[0] + b * point[1]);
    const section = keep(level
      ? solid.slice(height)
      : keep(solid.transform([1, 0, a, 0, 0, 1, b, 0, 0, 0, 1, 0, 0, 0, c, 1])).slice(0));
    if (section.isEmpty() || section.area() <= 1e-9) throw new Error('Move the plane so it cuts through the object');
    const offset = normal[0] * point[0] + normal[1] * point[1] + normal[2] * point[2];
    const top = keep(solid.trimByPlane(normal, offset));
    // The column reaches a hair (1 µm) into the part above, so the two fuse into
    // one solid instead of only touching at the plane.
    let column;
    if (level) {
      column = keep(keep(section.extrude(height - floor + 0.001)).translate([0, 0, floor]));
    } else {
      // Tall enough to pass the plane's highest point over the footprint, then
      // cut off along the plane so it ends exactly there.
      const box = section.bounds();
      let top2 = -Infinity;
      for (const x of [box.min[0], box.max[0]]) {
        for (const y of [box.min[1], box.max[1]]) top2 = Math.max(top2, height - (a * (x - point[0]) + b * (y - point[1])));
      }
      if (!(top2 > floor)) throw new Error('Move the plane so it cuts through the object');
      const tall = keep(keep(section.extrude(top2 - floor + 0.01)).translate([0, 0, floor]));
      column = keep(tall.trimByPlane([-normal[0], -normal[1], -normal[2]], -(offset + 0.001)));
      if (column.isEmpty()) throw new Error('Move the plane so it cuts through the object');
    }
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