import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { Piece } from './cut';
import { edgeFrame, findEdgesPlaced, type EdgeSegment, type V3 } from './edges';
import { edgesFit, edgeTreatment } from './features';
import { manifoldToMeshData, meshDataToManifold, type PlacedMesh } from './meshData';
import { shellsOf } from './meshCheck';

const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Is the face next to this edge visible from outside, with nothing in front of it? */
function faceIsOutside(solid: Manifold, s: EdgeSegment, across: V3, normal: V3, reach: number): boolean {
  // A point on the face, a little way in from the middle of the edge, lifted just off the surface.
  const into = 0.05;
  const from: V3 = [0, 1, 2].map((k) => (s.a[k] + s.b[k]) / 2 + across[k] * into + normal[k] * 1e-3) as V3;
  const to: V3 = [0, 1, 2].map((k) => from[k] + normal[k] * reach) as V3;
  return solid.rayCast(from, to).length === 0;
}

/** Beyond this many edges the one-by-one search for edges that fit is not tried (the check is quadratic). */
const MAX_SEARCH = 80;

/**
 * The edges Soften rounds: the straight, outside edges of the object's
 * outer surface. An edge counts when it sticks out (convex), runs straight (all
 * the pieces of its chain are parallel) and both its faces are seen from
 * outside: the walls of a hollow, and the inner edge of an opening's rim, have a
 * face that looks into the hollow, so they stay as they are. Edges that cannot
 * take the radius (too short, faces too narrow, or in the way of another edge's
 * rounding) are left out, longest edges first, and counted.
 */
export function outerBoxEdges(wasm: ManifoldToplevel, solid: Manifold, item: PlacedMesh, radius: number): { segments: EdgeSegment[]; skipped: number } {
  const set = findEdgesPlaced(item);
  const box = solid.boundingBox();
  const reach = 2 * Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) + 1;
  const length = (s: EdgeSegment) => Math.hypot(s.b[0] - s.a[0], s.b[1] - s.a[1], s.b[2] - s.a[2]);
  const runs: EdgeSegment[][] = [];
  for (const chain of set.chains) {
    const parts = chain.map((i) => set.segments[i]);
    if (!parts.every((s) => s.convex)) continue;
    const u = edgeFrame(parts[0]).u;
    if (!parts.every((s) => Math.abs(dot(edgeFrame(s).u, u)) > 0.9995)) continue; // curved: left alone
    const outside = parts.every((s) => {
      const f = edgeFrame(s);
      return faceIsOutside(solid, s, f.t1, s.n1, reach) && faceIsOutside(solid, s, f.t2, s.n2, reach);
    });
    if (outside) runs.push(parts);
  }
  const all = runs.flat();
  // The usual case: everything fits at once.
  if (all.length === 0 || edgesFit(wasm, solid, all, 'fillet', radius)) return { segments: all, skipped: 0 };
  if (runs.length > MAX_SEARCH) return { segments: all, skipped: 0 }; // the operation reports what is wrong
  // Otherwise add the edges one by one, the longest first, and leave out each one that does not fit with those taken.
  runs.sort((x, y) => y.reduce((n, s) => n + length(s), 0) - x.reduce((n, s) => n + length(s), 0));
  const taken: EdgeSegment[] = [];
  let skipped = 0;
  for (const run of runs) {
    if (edgesFit(wasm, solid, [...taken, ...run], 'fillet', radius)) taken.push(...run);
    else skipped++;
  }
  return { segments: taken, skipped };
}

const TOO_THICK = 'This radius is too large for the walls of this object. Use a smaller one.';

const unit = (v: V3): V3 => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const pointKey = (p: V3) => p.map((v) => Math.round(v * 1e4)).join(',');

/**
 * Does the material behind every rounded edge and corner stay thicker than the
 * rounding cuts deep? Along the middle of an edge the rounding reaches
 * r (1 / sin(half the angle) - 1) into the material; at a corner where three
 * faces meet its sphere reaches r (sqrt(3) - 1). Where the wall behind is
 * thinner (a hollow's wall), the rounding would break through it.
 */
function wallsHold(solid: Manifold, segments: EdgeSegment[], radius: number): boolean {
  const reach = 2 * (() => { const b = solid.boundingBox(); return Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]); })() + 1;
  const margin = 0.1;
  /** Thickness of the material from p (on the surface) straight in along `inward` */
  const thickness = (p: V3, inward: V3): number => {
    const from: V3 = [p[0] + inward[0] * 1e-3, p[1] + inward[1] * 1e-3, p[2] + inward[2] * 1e-3];
    const to: V3 = [from[0] + inward[0] * reach, from[1] + inward[1] * reach, from[2] + inward[2] * reach];
    // (A hit's `distance` is a fraction of the ray, so the length is taken from its position.)
    const hits = solid.rayCast(from, to).map((h) => Math.hypot(h.position[0] - from[0], h.position[1] - from[1], h.position[2] - from[2]));
    return hits.length === 0 ? Infinity : Math.min(...hits) + 1e-3;
  };
  const corners = new Map<string, { at: V3; normals: V3[] }>();
  for (const s of segments) {
    const f = edgeFrame(s);
    const out = unit([s.n1[0] + s.n2[0], s.n1[1] + s.n2[1], s.n1[2] + s.n2[2]]);
    const mid: V3 = [(s.a[0] + s.b[0]) / 2, (s.a[1] + s.b[1]) / 2, (s.a[2] + s.b[2]) / 2];
    const depth = radius * (1 / Math.sin(f.angle / 2) - 1);
    if (thickness(mid, [-out[0], -out[1], -out[2]]) < depth + margin) return false;
    for (const end of [s.a, s.b]) {
      const c = corners.get(pointKey(end)) ?? { at: end, normals: [] };
      for (const n of [s.n1, s.n2]) if (!c.normals.some((m) => dot(m, n) > 0.999)) c.normals.push(n);
      corners.set(pointKey(end), c);
    }
  }
  for (const c of corners.values()) {
    if (c.normals.length < 3) continue; // a corner of two faces is the edge's own cut
    const out = unit(c.normals.reduce((sum, n) => [sum[0] + n[0], sum[1] + n[1], sum[2] + n[2]] as V3, [0, 0, 0] as V3));
    if (thickness(c.at, [-out[0], -out[1], -out[2]]) < radius * (Math.sqrt(3) - 1) + margin) return false;
  }
  return true;
}

/** Round every straight outer edge in one go (see outerBoxEdges); `skipped` is how many edges were left sharp because they were too small. */
export function roundBox(wasm: ManifoldToplevel, item: PlacedMesh, radius: number): { piece: Piece; skipped: number } {
  if (!(radius > 0)) throw new Error('The radius must be more than 0');
  const solid = meshDataToManifold(wasm, item.mesh, item.matrix);
  try {
    const { segments, skipped } = outerBoxEdges(wasm, solid, item, radius);
    if (segments.length === 0) {
      throw new Error(skipped > 0 ? 'The radius is too large for the edges of this object. Use a smaller one.' : 'There are no straight outer edges to round.');
    }
    if (!wallsHold(solid, segments, radius)) throw new Error(TOO_THICK);
    const piece = edgeTreatment(wasm, item, segments, 'fillet', radius);
    // A rounding that cuts through a thin wall opens the hollow or leaves loose slivers: the surfaces are then not the same count as before.
    if (shellsOf(piece.mesh).length !== shellsOf(manifoldToMeshData(solid)).length) throw new Error(TOO_THICK);
    return { piece, skipped };
  } finally {
    solid.delete();
  }
}
