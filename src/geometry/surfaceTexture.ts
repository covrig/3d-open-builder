import type { CrossSection, Manifold, ManifoldToplevel, Mat4 } from 'manifold-3d';
import type { Piece } from './cut';
import { toPiece, withCleanup } from './features';
import { flatFaceRegion } from './faceRegion';
import { bakeMesh, manifoldToMeshData, meshDataToManifold, type PlacedMesh } from './meshData';
import { shellsOf } from './meshCheck';
import type { V3 } from './edges';

export type TexturePattern = 'pyramids' | 'dots' | 'ribs' | 'hexagons';
export type TextureFaces = 'one' | 'outer';

export interface SurfaceTextureOptions {
  pattern: TexturePattern;
  /** Distance between the middles of neighbouring features, mm */
  cell: number;
  /** Space between neighbouring features at the base, mm */
  gap: number;
  /** How far the features stand out of the face (raised) or go into it (cut in), mm */
  depth: number;
  mode: 'raised' | 'cut';
  /** Turn of the pattern on the face, degrees */
  angle: number;
  /** Space left free along the edges of the face, mm */
  margin: number;
  faces: TextureFaces;
  /** The clicked point on the face and the face's outward direction (world) */
  point: V3;
  normal: V3;
}

/** What a printer can still make: the narrowest feature at its base or tip, the narrowest gap, the shallowest relief. */
export const TEXTURE_LIMITS = { minFeature: 0.8, minTip: 0.4, minGap: 0.4, minDepth: 0.3, maxDepth: 5, minWall: 0.8, maxTriangles: 200_000, maxTiles: 6000 };

/** The features start this far inside the object (raised) or stand out of it (cut in), so they join the surface with no coplanar faces. */
const OVERLAP = 0.2;
/** A face smaller than this many cells in area is left alone when several faces are textured. */
const MIN_FACE_CELLS = 4;

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const unit = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

interface Face {
  /** Outward direction and a point in the middle of the face */
  normal: V3;
  centre: V3;
  triangles: number[];
  area: number;
  /** A real flat face (its border has corners). Not flat: a coplanar patch whose border runs smoothly into neighbours, like the top of a softened cube or one facet of a cylinder. */
  flat: boolean;
}

/** Face frame: Z along the outward direction, X level on upright faces. */
function frameOf(normal: V3, origin: V3): { x: V3; y: V3; matrix: Mat4 } {
  const x = Math.abs(normal[2]) > 0.9 ? unit(sub([1, 0, 0], scaled(normal, normal[0]))) : unit(cross([0, 0, 1], normal));
  const y = cross(normal, x);
  return { x, y, matrix: [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, normal[0], normal[1], normal[2], 0, origin[0], origin[1], origin[2], 1] };
}
const scaled = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];

type WorldMesh = { positions: Float32Array; indices: Uint32Array };

/** The coplanar patch of faces that triangle `t` belongs to: its triangles, outward direction, area and a point well inside it. */
function faceOfTriangle(world: WorldMesh, t: number): Face {
  const P = world.positions, I = world.indices;
  const pt = (i: number): V3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  const triNormal = (u: number): { n: V3; area: number } => {
    const a = pt(I[u * 3]), b = pt(I[u * 3 + 1]), c = pt(I[u * 3 + 2]);
    const n = cross(sub(b, a), sub(c, a));
    const l = Math.hypot(n[0], n[1], n[2]);
    return { n: l > 0 ? [n[0] / l, n[1] / l, n[2] / l] : [0, 0, 1], area: l / 2 };
  };
  const region = flatFaceRegion(world, t);
  let area = 0, best = t, bestArea = -1;
  for (const r of region.triangles) {
    const a = triNormal(r).area;
    area += a;
    if (a > bestArea) { bestArea = a; best = r; }
  }
  const corners = [0, 1, 2].map((k) => pt(I[best * 3 + k]));
  // The middle of the biggest triangle: always on the face, even when the face is an L or has a hole in the middle.
  const inner: V3 = [0, 1, 2].map((k) => (corners[0][k] + corners[1][k] + corners[2][k]) / 3) as V3;
  return { normal: triNormal(best).n, centre: inner, triangles: [...region.triangles], area, flat: region.flat };
}

/** How wide a face is across its narrower direction (bounding box in the face's own plane), mm. A facet of a round surface is only a few mm wide. */
function narrow(world: WorldMesh, face: Face): number {
  const frame = frameOf(face.normal, face.centre);
  const P = world.positions, I = world.indices;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const t of face.triangles) {
    for (let k = 0; k < 3; k++) {
      const i = I[t * 3 + k] * 3;
      const w: V3 = [P[i] - face.centre[0], P[i + 1] - face.centre[1], P[i + 2] - face.centre[2]];
      const x = dot(w, frame.x), y = dot(w, frame.y);
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  return Math.min(x1 - x0, y1 - y0);
}

/** The face that has this point on it (and faces this way). */
function faceAt(world: WorldMesh, point: V3, normal: V3): Face | undefined {
  const P = world.positions, I = world.indices;
  const pt = (i: number): V3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  const want = unit(normal);
  for (let t = 0; t < I.length / 3; t++) {
    const a = pt(I[t * 3]), b = pt(I[t * 3 + 1]), c = pt(I[t * 3 + 2]);
    const n = unit(cross(sub(b, a), sub(c, a)));
    if (dot(n, want) < 0.999 || Math.abs(dot(sub(point, a), n)) > 0.05) continue;
    // Is the point inside the triangle (in its plane)?
    const v0 = sub(c, a), v1 = sub(b, a), v2 = sub(point, a);
    const d00 = dot(v0, v0), d01 = dot(v0, v1), d11 = dot(v1, v1), d20 = dot(v2, v0), d21 = dot(v2, v1);
    const den = d00 * d11 - d01 * d01;
    if (Math.abs(den) < 1e-12) continue;
    const u = (d11 * d20 - d01 * d21) / den, v = (d00 * d21 - d01 * d20) / den;
    if (u < -1e-3 || v < -1e-3 || u + v > 1 + 1e-3) continue;
    return faceOfTriangle(world, t);
  }
  return undefined;
}

/** Is the direction out of this face free of the object (an outer face, not a hollow's wall)? */
function facesOut(solid: Manifold, face: { centre: V3; normal: V3 }, reach: number): boolean {
  const from: V3 = [face.centre[0] + face.normal[0] * 1e-3, face.centre[1] + face.normal[1] * 1e-3, face.centre[2] + face.normal[2] * 1e-3];
  const to: V3 = [from[0] + face.normal[0] * reach, from[1] + face.normal[1] * reach, from[2] + face.normal[2] * reach];
  return solid.rayCast(from, to).length === 0;
}

/** How thick the material is straight in from a point on a face (Infinity when the ray leaves nothing behind it). */
function wallBehind(solid: Manifold, face: { centre: V3; normal: V3 }, reach: number): number {
  const into: V3 = [-face.normal[0], -face.normal[1], -face.normal[2]];
  const from: V3 = [face.centre[0] + into[0] * 1e-3, face.centre[1] + into[1] * 1e-3, face.centre[2] + into[2] * 1e-3];
  const to: V3 = [from[0] + into[0] * reach, from[1] + into[1] * reach, from[2] + into[2] * reach];
  const hits = solid.rayCast(from, to).map((h) => Math.hypot(h.position[0] - from[0], h.position[1] - from[1], h.position[2] - from[2]));
  return hits.length === 0 ? Infinity : Math.min(...hits) + 1e-3;
}

/** One feature, standing on z = 0 (base), reaching up `depth`, wider at the bottom (it starts OVERLAP below z = 0) and narrowing at 45 degrees. */
function tileOf(wasm: ManifoldToplevel, keep: <M extends { delete(): void }>(m: M) => M, o: SurfaceTextureOptions, length: number, overlap = OVERLAP): { tile: Manifold; triangles: number } {
  const { Manifold, CrossSection } = wasm;
  const b = o.cell - o.gap;
  const height = o.depth + overlap;
  const bottom = b + 2 * overlap;
  const top = Math.max(TEXTURE_LIMITS.minTip, b - 2 * o.depth);
  const k = top / bottom;
  let shape: CrossSection;
  let triangles: number;
  // (Always a pair: Manifold's extrude takes a lone number wrongly, giving a different taper.)
  let scale: [number, number] = [k, k];
  switch (o.pattern) {
    case 'pyramids':
      shape = keep(CrossSection.square([bottom, bottom], true));
      triangles = 12;
      break;
    case 'dots':
      shape = keep(CrossSection.circle(bottom / 2, 16));
      triangles = 16 * 2 + 14 * 2;
      break;
    case 'hexagons':
      // Flat sides facing the neighbours: b is the distance across the flats.
      shape = keep(keep(CrossSection.circle(bottom / Math.sqrt(3), 6)).rotate(30));
      triangles = 20;
      break;
    case 'ribs':
      shape = keep(CrossSection.square([bottom, length], true));
      scale = [k, 1];
      triangles = 12;
      break;
  }
  return { tile: keep(keep(Manifold.extrude(shape, height, 0, 0, scale)).translate(0, 0, -overlap)), triangles };
}

/** Centres of the features over a rectangle (|x| <= half[0], |y| <= half[1], before the pattern's turn). */
function layout(o: SurfaceTextureOptions, half: [number, number]): [number, number][] {
  const s = o.cell;
  const out: [number, number][] = [];
  if (o.pattern === 'ribs') {
    for (let x = -Math.floor(half[0] / s) * s; x <= half[0] + 1e-9; x += s) out.push([x, 0]);
    return out;
  }
  if (o.pattern === 'pyramids') {
    for (let i = -Math.floor(half[0] / s); i * s <= half[0]; i++) for (let j = -Math.floor(half[1] / s); j * s <= half[1]; j++) out.push([i * s, j * s]);
    return out;
  }
  // Hexagonal packing: rows s * sqrt(3) / 2 apart, every other row shifted by half a cell.
  const rowH = (s * Math.sqrt(3)) / 2;
  for (let j = -Math.floor(half[1] / rowH); j * rowH <= half[1]; j++) {
    const shift = Math.abs(j) % 2 === 1 ? s / 2 : 0;
    for (let i = -Math.floor(half[0] / s) - 1; i * s + shift <= half[0]; i++) {
      const x = i * s + shift;
      if (x >= -half[0]) out.push([x, j * rowH]);
    }
  }
  return out;
}

/** The face's outline in its own plane (every triangle added together), as a cross-section. */
function outlineOf(wasm: ManifoldToplevel, world: WorldMesh, face: Face, frame: { x: V3; y: V3 }, origin: V3): CrossSection {
  const P = world.positions, I = world.indices;
  const polygons: [number, number][][] = [];
  for (const t of face.triangles) {
    const pts = [0, 1, 2].map((k) => {
      const w: V3 = [P[I[t * 3 + k] * 3] - origin[0], P[I[t * 3 + k] * 3 + 1] - origin[1], P[I[t * 3 + k] * 3 + 2] - origin[2]];
      return [dot(w, frame.x), dot(w, frame.y)] as [number, number];
    });
    const area = (pts[1][0] - pts[0][0]) * (pts[2][1] - pts[0][1]) - (pts[2][0] - pts[0][0]) * (pts[1][1] - pts[0][1]);
    if (Math.abs(area) < 1e-12) continue;
    polygons.push(area > 0 ? pts : [pts[0], pts[2], pts[1]]);
  }
  return new wasm.CrossSection(polygons, 'NonZero');
}

// --- Round walls (cylinders and tubes) ----------------------------------------------

/** A complete, closed cylinder wall: the axis, the circle, and how far along the axis it runs. */
interface Wall {
  /** Axis direction (unit) and two unit vectors across it, with u x w = axis */
  axis: V3;
  u: V3;
  w: V3;
  /** The point of the axis at axial position 0 (a position is the dot product with the axis) */
  origin: V3;
  radius: number;
  vMin: number;
  vMax: number;
  triangles: number[];
  area: number;
  /** A point exactly on the wall and the outward direction there (for the checks that look out of or into it) */
  sample: { centre: V3; normal: V3 };
}

/** Triangle normals and which triangles share each edge, worked out once per mesh. */
interface MeshInfo { normals: Float64Array; edgeTris: Map<number, number[]> }
const infoCache = new WeakMap<WorldMesh, MeshInfo>();
function infoOf(world: WorldMesh): MeshInfo {
  let info = infoCache.get(world);
  if (info) return info;
  const P = world.positions, I = world.indices;
  const T = I.length / 3;
  const normals = new Float64Array(T * 3);
  const edgeTris = new Map<number, number[]>();
  for (let t = 0; t < T; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
    const n = cross([P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]], [P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]]);
    const l = Math.hypot(n[0], n[1], n[2]) || 1;
    normals[t * 3] = n[0] / l; normals[t * 3 + 1] = n[1] / l; normals[t * 3 + 2] = n[2] / l;
    for (let k = 0; k < 3; k++) {
      const u = I[t * 3 + k], v = I[t * 3 + ((k + 1) % 3)];
      const key = u < v ? u * 67108864 + v : v * 67108864 + u;
      const list = edgeTris.get(key);
      if (list) list.push(t);
      else edgeTris.set(key, [t]);
    }
  }
  info = { normals, edgeTris };
  infoCache.set(world, info);
  return info;
}

/** How far a wall's triangle normals may stray from square to the axis, how far its points may lie off the circle, and how much its area may differ from the ring's perimeter times its length. */
const WALL_NORMAL_TOL = 0.02;
const WALL_RADIUS_TOL = 0.01;
const WALL_AREA_TOL = 0.005;
const MIN_WALL_TRIANGLES = 12;

/**
 * The complete cylinder wall that triangle `t` belongs to, or undefined. The axis
 * is one of the triangle's edges (a facet of a cylinder has an edge along it);
 * the wall is every triangle reachable from it whose normal is square to that
 * axis (the end caps and the fillets of a softened cylinder are not), and it
 * counts only when all its points lie on one circle and it closes all the way
 * round with no openings: its area is the ring's perimeter times its length.
 */
function cylinderWallAt(world: WorldMesh, t: number): Wall | undefined {
  const P = world.positions, I = world.indices;
  const { normals, edgeTris } = infoOf(world);
  const pt = (i: number): V3 => [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
  const normalOf = (tri: number): V3 => [normals[tri * 3], normals[tri * 3 + 1], normals[tri * 3 + 2]];
  // Where this facet meets the next one lies along the axis: the line the two planes share. (The triangle's own edges
  // may all run slantwise when the wall was cut up irregularly by an earlier operation, so they come second.)
  const axes: V3[] = [];
  for (let e = 0; e < 3; e++) {
    const u = I[t * 3 + e], v = I[t * 3 + ((e + 1) % 3)];
    for (const nb of edgeTris.get(u < v ? u * 67108864 + v : v * 67108864 + u) ?? []) {
      if (nb === t) continue;
      const c = cross(normalOf(t), normalOf(nb));
      if (Math.hypot(c[0], c[1], c[2]) > 1e-4) axes.push(unit(c));
    }
  }
  for (let e = 0; e < 3; e++) axes.push(unit(sub(pt(I[t * 3 + ((e + 1) % 3)]), pt(I[t * 3 + e]))));
  for (const axis of axes) {
    const square = (tri: number) => Math.abs(normals[tri * 3] * axis[0] + normals[tri * 3 + 1] * axis[1] + normals[tri * 3 + 2] * axis[2]) < WALL_NORMAL_TOL;
    if (!square(t)) continue;
    const seen = new Set([t]);
    const queue = [t];
    while (queue.length) {
      const c = queue.pop()!;
      for (let k = 0; k < 3; k++) {
        const u = I[c * 3 + k], v = I[c * 3 + ((k + 1) % 3)];
        for (const nb of edgeTris.get(u < v ? u * 67108864 + v : v * 67108864 + u) ?? []) {
          if (seen.has(nb) || !square(nb)) continue;
          seen.add(nb);
          queue.push(nb);
        }
      }
    }
    if (seen.size < MIN_WALL_TRIANGLES) continue;
    const wall = fitWall(world, [...seen], axis);
    if (wall) return wall;
  }
  return undefined;
}

function fitWall(world: WorldMesh, triangles: number[], axis: V3): Wall | undefined {
  const P = world.positions, I = world.indices;
  const helper: V3 = Math.abs(axis[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = unit(cross(helper, axis));
  const w = cross(axis, u);
  const ids = new Set<number>();
  for (const t of triangles) for (let k = 0; k < 3; k++) ids.add(I[t * 3 + k]);
  const pts = [...ids].map((i) => {
    const p: V3 = [P[i * 3], P[i * 3 + 1], P[i * 3 + 2]];
    return { x: dot(p, u), y: dot(p, w), z: dot(p, axis) };
  });
  // The circle through the points (least squares on x^2 + y^2 = A x + B y + C).
  let sxx = 0, sxy = 0, sx = 0, syy = 0, sy = 0, n = 0, rx = 0, ry = 0, r1 = 0;
  for (const p of pts) {
    const q = p.x * p.x + p.y * p.y;
    sxx += p.x * p.x; sxy += p.x * p.y; sx += p.x; syy += p.y * p.y; sy += p.y; n++;
    rx += q * p.x; ry += q * p.y; r1 += q;
  }
  const det3 = (m: number[][]) => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const M = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
  const D = det3(M);
  if (Math.abs(D) < 1e-9) return undefined;
  const rhs = [rx, ry, r1];
  const solve = (k: number) => det3(M.map((row, i) => row.map((v, j) => (j === k ? rhs[i] : v)))) / D;
  const a = solve(0) / 2, b = solve(1) / 2, c = solve(2);
  const radius = Math.sqrt(c + a * a + b * b);
  if (!(radius > 0) || pts.some((p) => Math.abs(Math.hypot(p.x - a, p.y - b) - radius) > WALL_RADIUS_TOL * radius + 1e-4)) return undefined;
  const vMin = Math.min(...pts.map((p) => p.z)), vMax = Math.max(...pts.map((p) => p.z));
  const length = vMax - vMin;
  if (!(length > 1e-3)) return undefined;
  // The ring of points at one end: it must run all the way round, and its perimeter times the length is the wall's area.
  const ring = pts.filter((p) => Math.abs(p.z - vMin) < 1e-3).map((p) => Math.atan2(p.y - b, p.x - a)).sort((m, k) => m - k);
  if (ring.length < 5) return undefined;
  let perimeter = 0, widest = 0;
  for (let i = 0; i < ring.length; i++) {
    const next = i + 1 < ring.length ? ring[i + 1] : ring[0] + 2 * Math.PI;
    widest = Math.max(widest, next - ring[i]);
    perimeter += 2 * radius * Math.sin((next - ring[i]) / 2);
  }
  if (widest > 1.2) return undefined; // only part of the way round
  let area = 0;
  for (const t of triangles) {
    const A = [0, 1, 2].map((k) => [P[I[t * 3 + k] * 3], P[I[t * 3 + k] * 3 + 1], P[I[t * 3 + k] * 3 + 2]] as V3);
    const cr = cross(sub(A[1], A[0]), sub(A[2], A[0]));
    area += Math.hypot(cr[0], cr[1], cr[2]) / 2;
  }
  if (Math.abs(area - perimeter * length) > WALL_AREA_TOL * perimeter * length) return undefined; // openings, or a step in its length
  // Facing out, away from the axis (the bore of a tube faces in).
  const t0 = triangles[0];
  const here: V3 = [0, 1, 2].map((k) => ([0, 1, 2].reduce((s, j) => s + P[I[t0 * 3 + j] * 3 + k], 0)) / 3) as V3;
  const nrm = infoOf(world).normals;
  const n0: V3 = [nrm[t0 * 3], nrm[t0 * 3 + 1], nrm[t0 * 3 + 2]];
  if ((dot(here, u) - a) * dot(n0, u) + (dot(here, w) - b) * dot(n0, w) <= 0) return undefined;
  return { axis, u, w, origin: [a * u[0] + b * w[0], a * u[1] + b * w[1], a * u[2] + b * w[2]], radius, vMin, vMax, triangles, area, sample: { centre: here, normal: n0 } };
}

/** A point exactly on the wall and the outward direction there. */
function wallMiddle(wall: Wall): { centre: V3; normal: V3 } {
  return wall.sample;
}

/** The features over a whole wall, stood on it round the circle (the cell is adjusted so the pattern closes). */
function wallFeatures(
  wasm: ManifoldToplevel,
  keep: <M extends { delete(): void }>(m: M) => M,
  o: SurfaceTextureOptions,
  wall: Wall,
  count: (tiles: number, triangles: number) => void,
): Manifold[] {
  const b = o.cell - o.gap;
  const r = wall.radius;
  const columns = Math.round((2 * Math.PI * r) / o.cell);
  if (columns < 4) throw new Error('The cylinder is too thin for this pattern. Use a smaller cell.');
  const along = o.cell * (o.pattern === 'hexagons' || o.pattern === 'dots' ? Math.sqrt(3) / 2 : 1);
  const half = (wall.vMax - wall.vMin) / 2 - o.margin - (o.pattern === 'ribs' ? 0 : b / 2);
  const band = wall.vMax - wall.vMin - 2 * o.margin;
  if (half < 0 || (o.pattern === 'ribs' && band < o.cell)) throw new Error('The margin leaves no room on this wall. Use a smaller margin.');
  const mid = (wall.vMin + wall.vMax) / 2;
  const reachRows = Math.floor(half / along);
  const rows = o.pattern === 'ribs' ? [0] : Array.from({ length: 2 * reachRows + 1 }, (_, i) => i - reachRows);
  // Along a curve the flat base of a feature lifts off the surface by about b^2 / 8r at its corners: start it deeper in.
  const overlap = Math.max(OVERLAP, (b * b) / (8 * r) + 0.1);
  const { tile, triangles: perTile } = tileOf(wasm, keep, o, band, overlap);
  const total = rows.length * columns;
  count(total, total * perTile);
  if (total > TEXTURE_LIMITS.maxTiles || total * perTile > TEXTURE_LIMITS.maxTriangles) {
    throw new Error(`This pattern would have ${total.toLocaleString()} features: use a larger cell, or texture one face.`);
  }
  const upright = o.mode === 'cut' ? keep(tile.rotate([180, 0, 0])) : tile;
  const oriented = o.angle % 360 === 0 ? upright : keep(upright.rotate(0, 0, o.angle));
  const copies: Manifold[] = [];
  const step = (2 * Math.PI) / columns;
  for (const j of rows) {
    const shift = o.pattern !== 'pyramids' && o.pattern !== 'ribs' && Math.abs(j) % 2 === 1 ? step / 2 : 0;
    for (let i = 0; i < columns; i++) {
      const theta = i * step + shift;
      const c = Math.cos(theta), s = Math.sin(theta);
      const nrm: V3 = [0, 1, 2].map((k) => c * wall.u[k] + s * wall.w[k]) as V3;
      const tan: V3 = [0, 1, 2].map((k) => -s * wall.u[k] + c * wall.w[k]) as V3;
      const v = mid + j * along;
      const at: V3 = [0, 1, 2].map((k) => wall.origin[k] + r * nrm[k] + v * wall.axis[k]) as V3;
      copies.push(keep(oriented.transform([tan[0], tan[1], tan[2], 0, wall.axis[0], wall.axis[1], wall.axis[2], 0, nrm[0], nrm[1], nrm[2], 0, at[0], at[1], at[2], 1])));
    }
  }
  return copies;
}

function check(o: SurfaceTextureOptions): void {
  const L = TEXTURE_LIMITS;
  const b = o.cell - o.gap;
  if (![o.cell, o.gap, o.depth, o.angle, o.margin].every(Number.isFinite)) throw new Error('Enter a number in every box');
  if (o.depth < L.minDepth) throw new Error(`The height or depth is too small to print: use at least ${L.minDepth} mm.`);
  if (o.depth > L.maxDepth) throw new Error(`The height or depth is too large for a texture: use at most ${L.maxDepth} mm.`);
  if (o.gap < L.minGap) throw new Error(`The gap is too small to print: use at least ${L.minGap} mm.`);
  if (b < L.minFeature) throw new Error(`The features are too small to print: the cell minus the gap must be at least ${L.minFeature} mm.`);
  if (o.margin < 0) throw new Error('The margin cannot be negative.');
}

/**
 * A texture you can feel: a pattern of small raised bumps or cut-in dents over a
 * flat face (or all the outer faces, or all the sides). Every feature narrows at
 * 45 degrees, so none overhangs more than a printer can bridge, and the pattern
 * stays a margin away from the face's edges. A complete cylinder wall is wrapped; other curved faces are left as they are.
 */
export function surfaceTexture(wasm: ManifoldToplevel, item: PlacedMesh, o: SurfaceTextureOptions): Piece & { tiles: number; faces: number } {
  check(o);
  const { Manifold } = wasm;
  const world = bakeMesh(item);
  return withCleanup((keep) => {
    const solid = keep(meshDataToManifold(wasm, item.mesh, item.matrix));
    const box = solid.boundingBox();
    const reach = 2 * Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) + 1;
    const minArea = MIN_FACE_CELLS * o.cell * o.cell;
    // A flat face (or a flat patch of a rounded object), or the complete wall of a cylinder or tube.
    const surfaces: ({ face: Face } | { wall: Wall })[] = [];
    if (o.faces === 'one') {
      const f = faceAt(world, o.point, o.normal);
      if (!f) throw new Error('Click a face of the object.');
      if (f.flat || narrow(world, f) >= 3 * o.cell) {
        surfaces.push({ face: f });
      } else {
        // Too narrow to be a face of its own: a facet of a round surface. A complete cylinder wall can be wrapped; nothing else here.
        const wall = cylinderWallAt(world, f.triangles[0]);
        if (!wall) throw new Error('This face is too narrow for the pattern, and it is not part of a complete round wall (the outside of a cylinder or tube, with no openings). Use a smaller cell.');
        surfaces.push({ wall });
      }
    } else {
      const seen = new Set<number>();
      for (let t = 0; t < world.indices.length / 3; t++) {
        if (seen.has(t)) continue;
        const f = faceOfTriangle(world, t);
        for (const r of f.triangles) seen.add(r);
        if (f.flat || narrow(world, f) >= 3 * o.cell) {
          if (f.area >= minArea && f.normal[2] > -0.95 && facesOut(solid, f, reach)) surfaces.push({ face: f });
          continue;
        }
        const wall = cylinderWallAt(world, t);
        if (!wall) continue;
        for (const r of wall.triangles) seen.add(r);
        if (wall.area >= minArea && facesOut(solid, wallMiddle(wall), reach)) surfaces.push({ wall });
      }
      if (surfaces.length === 0) throw new Error('There are no faces big enough for this pattern.');
    }
    const pieces: Manifold[] = [];
    let tiles = 0, triangles = 0;
    for (const surface of surfaces) {
      if ('wall' in surface) {
        const wall = surface.wall;
        if (o.mode === 'cut') {
          const thick = wallBehind(solid, wallMiddle(wall), reach);
          if (thick < o.depth + TEXTURE_LIMITS.minWall) {
            if (o.faces === 'one') throw new Error(`The wall is ${Math.round(thick * 100) / 100} mm thick: too thin for dents ${o.depth} mm deep. Use a smaller depth.`);
            continue;
          }
        }
        const copies = wallFeatures(wasm, keep, o, wall, (n, tr) => { tiles += n; triangles += tr; });
        pieces.push(keep(Manifold.compose(copies)));
        continue;
      }
      const face = surface.face;
      if (o.mode === 'cut') {
        const wall = wallBehind(solid, face, reach);
        if (wall < o.depth + TEXTURE_LIMITS.minWall) {
          if (o.faces === 'one') throw new Error(`The wall behind this face is ${Math.round(wall * 100) / 100} mm thick: too thin for dents ${o.depth} mm deep. Use a smaller depth.`);
          continue;
        }
      }
      const frame = frameOf(face.normal, face.centre);
      const outline = keep(outlineOf(wasm, world, face, frame, face.centre));
      const inset = keep(o.margin > 0 ? outline.offset(-o.margin, 'Miter', 2) : outline);
      if (inset.isEmpty()) {
        if (o.faces === 'one') throw new Error('The margin leaves no room on this face. Use a smaller margin.');
        continue;
      }
      const r = inset.bounds();
      const centre: [number, number] = [(r.min[0] + r.max[0]) / 2, (r.min[1] + r.max[1]) / 2];
      const reachHalf = Math.hypot(r.max[0] - r.min[0], r.max[1] - r.min[1]) / 2 + o.cell;
      const { tile, triangles: perTile } = tileOf(wasm, keep, o, 2 * reachHalf);
      // Feature centres over a square that holds the face at any turn, kept where they land near the face's box.
      const a = (o.angle * Math.PI) / 180, ca = Math.cos(a), sa = Math.sin(a);
      const spots = layout(o, [reachHalf, reachHalf]).map(([x, y]) => [x * ca - y * sa + centre[0], x * sa + y * ca + centre[1]] as [number, number])
        .filter(([x, y]) => o.pattern === 'ribs' || (x >= r.min[0] - o.cell && x <= r.max[0] + o.cell && y >= r.min[1] - o.cell && y <= r.max[1] + o.cell));
      tiles += spots.length;
      triangles += spots.length * perTile;
      if (tiles > TEXTURE_LIMITS.maxTiles || triangles > TEXTURE_LIMITS.maxTriangles) {
        throw new Error(`This pattern would have ${tiles.toLocaleString()} features: use a larger cell, or texture one face.`);
      }
      // A cut-in feature is the raised one turned upside down; every feature turns with the pattern (ribs are one long bar each).
      const upright = o.mode === 'cut' ? keep(tile.rotate([180, 0, 0])) : tile;
      const oriented = o.angle % 360 === 0 ? upright : keep(upright.rotate(0, 0, o.angle));
      const copies = spots.map(([x, y]) => keep(oriented.translate(x, y, 0)));
      if (copies.length === 0) continue;
      const all = keep(Manifold.compose(copies));
      const span = o.depth + OVERLAP + 1;
      const prism = keep(keep(Manifold.extrude(inset, 2 * span)).translate(0, 0, -span));
      const clipped = keep(all.intersect(prism));
      if (clipped.isEmpty()) continue;
      pieces.push(keep(clipped.transform(frame.matrix)));
    }
    if (pieces.length === 0) throw new Error('The pattern does not fit on the face. Use a smaller cell or margin.');
    const merged = keep(Manifold.compose(pieces));
    const result = keep(o.mode === 'raised' ? solid.add(merged) : solid.subtract(merged));
    const before = shellsOf(manifoldToMeshData(solid)).length;
    if (shellsOf(manifoldToMeshData(result)).length !== before || result.genus() !== solid.genus()) {
      throw new Error('The cut-in texture goes through a thin wall. Use a smaller depth.');
    }
    return { ...toPiece(result), tiles, faces: pieces.length };
  });
}
