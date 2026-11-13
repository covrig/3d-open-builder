import type { CrossSection, Manifold, ManifoldToplevel, Vec3 } from 'manifold-3d';
import { manifoldToMeshData, meshDataToManifold, type MeshData, type PlacedMesh } from './meshData';
import { recenter } from './meshOps';
import { solidPieces } from './pieces';

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

/** The separate solid pieces of a manifold (largest first; a hollow stays with its piece), none if it is empty. */
function piecesOf(m: Manifold): Piece[] {
  if (m.isEmpty()) return [];
  const parts = solidPieces(m);
  try {
    return parts.map(toPiece).filter((p): p is Piece => p !== null);
  } finally {
    for (const part of parts) part.delete();
  }
}

/**
 * Cut an object with the plane {p : p·normal = offset} (normal is a unit
 * vector, world space). Returns the pieces on the side the normal points to
 * and on the other side: each loose piece on its own, largest first. A side
 * is empty if the plane misses it.
 */
export function splitByPlane(
  wasm: ManifoldToplevel,
  item: PlacedMesh,
  normal: Vec3,
  offset: number,
): { positive: Piece[]; negative: Piece[] } {
  const solid = meshDataToManifold(wasm, item.mesh, item.matrix);
  const [pos, neg] = solid.splitByPlane(normal, offset);
  try {
    return { positive: piecesOf(pos), negative: piecesOf(neg) };
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
): Piece[] {
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
    const result = keep(extrudeDirect(wasm, solid, normal, offset, floor)
      ?? extrudeByBoolean(solid, section, normal, offset, point, height, floor, level, a, b, keep));
    const status = result.status();
    if (status !== 'NoError') throw new Error(`Extrude failed (${status})`);
    // Loose parts (a cut through a ring, say) come back one piece each, largest first.
    const pieces = piecesOf(result);
    if (pieces.length === 0) throw new Error('Nothing is left to extrude');
    return pieces;
  } finally {
    for (const m of owned) m.delete();
  }
}

/**
 * Build the extruded object straight from the mesh of the part above the
 * plane: that part's cap (the triangles lying in the plane, facing down) is
 * copied down to the plate, and walls join the cap's outline to the copy. No
 * overlap and no boolean, so no sliver steps. Returns null if the result is
 * not accepted as a solid (say, the outline touches itself at a point); the
 * caller then falls back to extrudeByBoolean.
 */
function extrudeDirect(wasm: ManifoldToplevel, solid: Manifold, normal: Vec3, offset: number, floor: number): Manifold | null {
  const [upper, lower] = solid.splitByPlane(normal, offset);
  lower.delete();
  try {
    if (upper.isEmpty()) return null;
    const { positions: p, indices: ix } = manifoldToMeshData(upper);
    let scale = 1;
    for (let i = 0; i < p.length; i++) scale = Math.max(scale, Math.abs(p[i]));
    const tol = 1e-6 * scale;
    const onPlane = (v: number) => Math.abs(normal[0] * p[v * 3] + normal[1] * p[v * 3 + 1] + normal[2] * p[v * 3 + 2] - offset) <= tol;
    const cap: number[] = [];
    for (let t = 0; t < ix.length; t += 3) {
      const [a, b, c] = [ix[t], ix[t + 1], ix[t + 2]];
      if (!onPlane(a) || !onPlane(b) || !onPlane(c)) continue;
      const ux = p[b * 3] - p[a * 3], uy = p[b * 3 + 1] - p[a * 3 + 1], uz = p[b * 3 + 2] - p[a * 3 + 2];
      const vx = p[c * 3] - p[a * 3], vy = p[c * 3 + 1] - p[a * 3 + 1], vz = p[c * 3 + 2] - p[a * 3 + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len > 0 && (nx * normal[0] + ny * normal[1] + nz * normal[2]) / len < -0.99) cap.push(t);
    }
    if (cap.length === 0) throw new Error('Move the plane so it cuts through the object');
    // The cap's outline: edges whose reverse edge is in no other cap triangle.
    const edgeKey = (u: number, v: number) => u * 4294967296 + v;
    const directed = new Set<number>();
    for (const t of cap) for (let k = 0; k < 3; k++) directed.add(edgeKey(ix[t + k], ix[t + ((k + 1) % 3)]));
    const outline: [number, number][] = [];
    for (const t of cap) {
      for (let k = 0; k < 3; k++) {
        const u = ix[t + k], v = ix[t + ((k + 1) % 3)];
        if (!directed.has(edgeKey(v, u))) outline.push([u, v]);
      }
    }
    // One copy of each cap vertex on the plate.
    const count = p.length / 3;
    const down = new Map<number, number>();
    const positions: number[] = Array.from(p);
    const copyOf = (v: number) => {
      let d = down.get(v);
      if (d === undefined) {
        if (!(p[v * 3 + 2] > floor + 1e-9)) throw new Error('Move the plane so it cuts through the object');
        d = count + down.size;
        down.set(v, d);
        positions.push(p[v * 3], p[v * 3 + 1], floor);
      }
      return d;
    };
    const capSet = new Set(cap);
    const indices: number[] = [];
    for (let t = 0; t < ix.length; t += 3) if (!capSet.has(t)) indices.push(ix[t], ix[t + 1], ix[t + 2]);
    for (const [a, b] of outline) {
      const a2 = copyOf(a), b2 = copyOf(b);
      indices.push(a, b, b2, a, b2, a2);
    }
    for (const t of cap) indices.push(copyOf(ix[t]), copyOf(ix[t + 1]), copyOf(ix[t + 2]));
    try {
      const m = meshDataToManifold(wasm, { positions: new Float32Array(positions), indices: new Uint32Array(indices) });
      if (m.volume() > 0) return m;
      m.delete();
    } catch {
      // Not accepted as a solid: the caller uses the other method.
    }
    return null;
  } finally {
    upper.delete();
  }
}

/** The older way: a column from the plate up to the plane, added to the part above it. */
function extrudeByBoolean(
  solid: Manifold,
  section: CrossSection,
  normal: Vec3,
  offset: number,
  point: Vec3,
  height: number,
  floor: number,
  level: boolean,
  a: number,
  b: number,
  keep: <T extends { delete(): void }>(m: T) => T,
): Manifold {
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
  return top.isEmpty() ? column : top.add(column);
}
