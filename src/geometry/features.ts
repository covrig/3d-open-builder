import type { Manifold, ManifoldToplevel, Mat4, Vec3 } from 'manifold-3d';
import type { Piece } from './cut';
import { edgeFrame, findEdges, type EdgeSegment, type V3 } from './edges';
import { manifoldToMeshData, meshDataToManifold, type MeshData, type PlacedMesh } from './meshData';
import { recenter } from './meshOps';
import { solidPieces } from './pieces';
import { threadStandIn, type ThreadInfo } from './threads';
import { triangleNormal } from './triangles';

const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * Moves that put a row of `count` items (the first being the original) centred
 * on `point` along `dir` (unit vector), `spacing` apart. Item k sits at offset
 * (k - (count - 1) / 2) * spacing from the point; each move is measured from
 * `from`, the centre of what is being repeated. Index 0 is the original's move.
 */
export function centredRowMoves(count: number, spacing: number, dir: V3, point: V3, from: V3): V3[] {
  return Array.from({ length: count }, (_, k) => {
    const off = (k - (count - 1) / 2) * spacing;
    return [point[0] + dir[0] * off - from[0], point[1] + dir[1] * off - from[1], point[2] + dir[2] * off - from[2]] as V3;
  });
}

/** Column-major matrix whose Z axis is `z`, placed at `origin`. */
function frameMatrix(z: V3, origin: V3): Mat4 {
  const helper: V3 = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const x = norm(cross(helper, z));
  const y = cross(z, x);
  return [x[0], x[1], x[2], 0, y[0], y[1], y[2], 0, z[0], z[1], z[2], 0, origin[0], origin[1], origin[2], 1];
}

function toPiece(m: Manifold): Piece {
  const status = m.status();
  if (status !== 'NoError') throw new Error(`The operation failed (${status})`);
  if (m.isEmpty()) throw new Error('Nothing would be left of the object');
  const { mesh, center } = recenter(manifoldToMeshData(m));
  return { mesh, center };
}

/** Run `build` with a list that frees every Manifold put in it afterwards. */
function withCleanup<T>(build: (keep: <M extends Manifold>(m: M) => M) => T): T {
  const owned: Manifold[] = [];
  try {
    return build((m) => (owned.push(m), m));
  } finally {
    for (const m of owned) m.delete();
  }
}

/** How far along each face a chamfer or fillet of this size reaches from the edge. */
const legOf = (kind: 'chamfer' | 'fillet', size: number, angle: number) =>
  kind === 'chamfer' ? size : size / Math.tan(angle / 2);

/** Two directions for counting how often a ray crosses the surface (neither lies along a model axis). */
const RAY_A: V3 = [0.2673, 0.5345, 0.8018];
const RAY_B: V3 = [-0.6362, 0.2712, -0.7239];

/**
 * Is the point inside the solid? Counts the surface crossings on a ray out of
 * the solid's bounding box: odd means inside. Two rays must agree; if they do
 * not (one ran along an edge), a tiny cube at the point decides.
 */
function pointInside(wasm: ManifoldToplevel, solid: Manifold, p: V3, reach: number): boolean {
  const crossings = (d: V3) => solid.rayCast(p, [p[0] + d[0] * reach, p[1] + d[1] * reach, p[2] + d[2] * reach]).length;
  const a = crossings(RAY_A) % 2 === 1;
  const b = crossings(RAY_B) % 2 === 1;
  if (a === b) return a;
  const cube = wasm.Manifold.cube([2e-4, 2e-4, 2e-4], true).translate(p);
  const hit = solid.intersect(cube);
  const inside = hit.volume() > 0;
  cube.delete();
  hit.delete();
  return inside;
}

/** Two face normals closer than this (cosine of 5 degrees) are the same flat face */
const FACE_STEADY = Math.cos((5 * Math.PI) / 180);
const TOO_LARGE = 'This size is too large for the faces next to the picked edge. Use a smaller one.';
/**
 * Next to an open end of a rim: how far from the end (in legs, plus two segments)
 * the surface may stray from the tool, and how far (in legs). A tilted tube
 * cut off at a crease measured 0.12 legs; the sphere-hole rims are closed loops.
 */
const END_REACH = 2;
const END_BEND = 0.4;
/** How far (in legs) beyond the faces a tool reaches where they bend near a rim end; more than END_BEND */
const TOOL_MARGIN = 0.6;
const NOT_FLAT = 'The surface next to this edge is curved or bumpy, so a clean bevel or round is not possible. Pick other edges or use a smaller size.';

/**
 * How far the surface lies from where the tool's face will be. The tool runs
 * straight along each face from the edge; on a faceted curve (the rim of a hole
 * in a ball-shaped hollow, a scan) the next triangles bend away from that
 * straight line, and the cut then digs notches or leaves teeth along the rim.
 * `p` is the point at the end of the leg, `n` the face's normal there. The
 * nearest surface along the normal is measured from `p` (checked a little to
 * either side too, in case the ray runs along a triangle edge); Infinity if
 * there is none. Flat faces, cylinders and cones come out at exactly 0.
 */
function surfaceOff(solid: Manifold, p: V3, n: V3, leg: number, u: V3, length: number): number {
  const range = Math.max(0.5, leg);
  for (const shift of [0, 0.02, -0.02]) {
    const q = add(p, u, shift * length);
    const hits = solid.rayCast(add(q, n, range), add(q, n, -range));
    if (hits.length === 0) continue;
    return Math.min(...hits.map((h) => Math.abs((h.position[0] - q[0]) * n[0] + (h.position[1] - q[1]) * n[1] + (h.position[2] - q[2]) * n[2])));
  }
  return Infinity;
}

/**
 * How a convex surface falls away from a straight tool leg. On a faceted ball
 * or dome the leg runs along the facet's plane and leaves the solid by about
 * leg^2 / (2 R); that is no fault of the tool (it is cut off by the real
 * surface and the chamfer plane simply meets it a little early), unlike a
 * face that ends or a bumpy one. The surface must lie below the leg end `p`
 * (measured along the face normal `n`) by no more than the sag the surface's
 * own bend predicts, leg * sin(bend) / 2 (a circle: sag = leg * angle / 2),
 * with some slack for facet noise, and the bend must be gentle (BEND_LIMIT):
 * a face that just ends, or a step, bends much more or leaves nothing below.
 * Only asked where the leg end is outside the solid; concave surfaces, whose
 * leg stays in the material, never come here.
 */
const BEND_LIMIT = Math.sin((30 * Math.PI) / 180);
function fallsAwayGently(solid: Manifold, p: V3, n: V3, leg: number, u: V3, length: number): boolean {
  const range = Math.max(0.5, leg);
  for (const shift of [0, 0.02, -0.02]) {
    const q = add(p, u, shift * length);
    const hits = solid.rayCast(add(q, n, range), add(q, n, -range));
    if (hits.length === 0) continue;
    const below = (h: (typeof hits)[number]) => (q[0] - h.position[0]) * n[0] + (q[1] - h.position[1]) * n[1] + (q[2] - h.position[2]) * n[2];
    const h = hits.reduce((x, y) => (Math.abs(below(x)) <= Math.abs(below(y)) ? x : y));
    const sin = Math.sqrt(Math.max(0, 1 - dot3(h.normal as V3, n) ** 2));
    return below(h) >= 0 && sin <= BEND_LIMIT && below(h) <= 2.5 * (leg * sin) / 2 + 0.01;
  }
  return false;
}

/**
 * Where a picked rim stops: end points where no picked segment carries on
 * smoothly (a rim that runs into a crease or a cut plane, or into other picked
 * edges at a corner). A face can pinch to nothing there (a slanted cut through
 * a bent tube), so the tool leg reaches past it onto the bend. A closed loop,
 * such as the rim of a hole, has none.
 */
function openEnds(segments: EdgeSegment[], key: (p: V3) => string): V3[] {
  const seen = new Map<string, { p: V3; dirs: V3[] }>();
  for (const s of segments) {
    const f = edgeFrame(s);
    for (const [p, d] of [[s.a, f.u], [s.b, [-f.u[0], -f.u[1], -f.u[2]]]] as [V3, V3][]) {
      const k = key(p);
      const known = seen.get(k);
      if (known) known.dirs.push(d);
      else seen.set(k, { p, dirs: [d] });
    }
  }
  // Two segments leaving a point in nearly opposite directions are a smooth joint.
  const smooth = (d: V3[]) => d.length === 2 && -dot3(d[0], d[1]) > Math.cos(CURVE_TURN);
  return [...seen.values()].filter((e) => !smooth(e.dirs)).map((e) => e.p);
}

/**
 * Refuse sizes the geometry cannot take, before anything is cut. Each picked
 * edge's two faces must still be there at the tool's reach (checked at the
 * middle and a quarter in from both ends: a face that narrows to an acute
 * corner may be shorter than the reach right at the end), and the tools of two edges must not cut into
 * the same material (opposite edges of a face whose legs add up to more than
 * the face is wide). Legs that exactly meet are fine.
 */
function checkSizes(
  wasm: ManifoldToplevel,
  keep: <M extends Manifold>(m: M) => M,
  solid: Manifold,
  segments: EdgeSegment[],
  frames: ReturnType<typeof edgeFrame>[],
  legs: (number | null)[],
  key: (p: V3) => string,
): Set<EdgeSegment> {
  /** Segments next to a rim end where a face bends away from the tool (see TOOL_MARGIN) */
  const bent = new Set<EdgeSegment>();
  const box = solid.boundingBox();
  const reach = 2 * Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) + 1;
  const inside = (p: V3) => pointInside(wasm, solid, p, reach);
  const near = 1e-3;
  const ends = openEnds(segments, key);
  segments.forEach((s, i) => {
    const leg = legs[i];
    if (leg === null) return;
    const f = frames[i];
    for (const at of [0.5, 0.25, 0.75]) {
      const p = add(s.a, f.u, f.length * at);
      for (const [t, n] of [[f.t1, s.n1], [f.t2, s.n2]] as [V3, V3][]) {
        const along = add(p, t, leg * 0.999);
        const ok = s.convex
          ? inside(add(along, n, -near))
          : !inside(add(along, n, near)) && inside(add(along, n, -near));
        if (!ok) {
          if (s.convex && fallsAwayGently(solid, along, n, leg, f.u, f.length)) continue;
          throw new Error(TOO_LARGE);
        }
        if (s.convex) {
          const off = surfaceOff(solid, along, n, leg, f.u, f.length);
          if (off > Math.max(0.01, 0.03 * leg)) {
            // Next to the end of an open rim a small, bounded bend is allowed (it only
            // trims the last stretch); anywhere else, or a bigger one, makes teeth.
            const close = ends.some((e) => Math.hypot(p[0] - e[0], p[1] - e[1], p[2] - e[2]) <= END_REACH * leg + 2 * f.length);
            if (!close || off > END_BEND * leg) throw new Error(NOT_FLAT);
            bent.add(s);
          }
        }
      }
    }
  });
  // The plain tools (no offsets), compared two at a time when their boxes overlap.
  const plain = segments.map((s, i) => {
    const leg = legs[i];
    if (leg === null) return null;
    const f = frames[i];
    const pts: Vec3[] = [s.a, add(s.a, f.t1, leg), add(s.a, f.t2, leg), s.b, add(s.b, f.t1, leg), add(s.b, f.t2, leg)];
    const lo = [0, 1, 2].map((k) => Math.min(...pts.map((q) => q[k])));
    const hi = [0, 1, 2].map((k) => Math.max(...pts.map((q) => q[k])));
    return { pts, lo, hi, hull: null as Manifold | null, volume: 0 };
  });
  const hullOf = (t: NonNullable<(typeof plain)[number]>) => {
    if (!t.hull) {
      t.hull = keep(wasm.Manifold.hull(t.pts));
      t.volume = t.hull.volume();
    }
    return t.hull;
  };
  const group = segments.map((_, i) => i);
  const link = (i: number): number => (group[i] === i ? i : (group[i] = link(group[i])));
  const meeting = new Map<string, number[]>();
  segments.forEach((s, i) => { for (const p of [s.a, s.b]) { const k = key(p); meeting.set(k, [...(meeting.get(k) ?? []), i]); } });
  for (const [, list] of meeting) {
    if (list.length === 2 && Math.abs(dot3(frames[list[0]].u, frames[list[1]].u)) > Math.cos(CURVE_TURN)) group[link(list[0])] = link(list[1]);
  }
  for (let i = 0; i < segments.length; i++) {
    const ti = plain[i];
    if (!ti) continue;
    for (let j = i + 1; j < segments.length; j++) {
      const tj = plain[j];
      if (!tj) continue;
      const ends = [key(segments[i].a), key(segments[i].b)];
      if (ends.includes(key(segments[j].a)) || ends.includes(key(segments[j].b))) continue;
      if ([0, 1, 2].some((k) => ti.lo[k] >= tj.hi[k] - 1e-9 || tj.lo[k] >= ti.hi[k] - 1e-9)) continue;
      const both = keep(hullOf(ti).intersect(hullOf(tj)));
      // Along one smooth rim the tools of segments a few steps apart share a sliver where the
      // facets are irregular; that cuts the same material twice, which is harmless.
      const sliver = link(i) === link(j) ? 1e-3 : 1e-6;
      // Where neither face stays the same along a smooth chain, both are curved: the crease
      // two earlier rounds leave where they meet. Its tools overlap each other though the
      // rounding is fine, so only there is that left to the result.
      const creased = link(i) === link(j) && [segments[i].n1, segments[i].n2].every((a) => [segments[j].n1, segments[j].n2].every((b) => dot3(a, b) < FACE_STEADY));
      if (!creased && both.volume() > sliver * Math.min(ti.volume, tj.volume)) throw new Error(TOO_LARGE);
    }
  }
  return bent;
}

/** Rounded point key: the same point from two edges (or two meshes) gives the same text. */
const key = (p: V3) => p.map((v) => Math.round(v * 1e4)).join(',');

/**
 * Can these edges take a chamfer or fillet of this size together? The same checks
 * as the real operation (each edge's faces long enough and flat enough, no two
 * tools cutting the same material), without cutting anything. False when they
 * cannot; folds that are too sharp or too flat for a tool count as false too.
 */
export function edgesFit(wasm: ManifoldToplevel, solid: Manifold, edges: EdgeSegment[], kind: 'chamfer' | 'fillet', size: number): boolean {
  const frames = edges.map(edgeFrame);
  if (frames.some((f) => f.angle < 0.35 || f.angle > Math.PI - 0.05)) return false;
  return withCleanup((keep) => {
    try {
      checkSizes(wasm, keep, solid, edges, frames, frames.map((f) => legOf(kind, size, f.angle)), key);
      return true;
    } catch (e) {
      if (e instanceof Error && (e.message === TOO_LARGE || e.message === NOT_FLAT)) return false;
      throw e;
    }
  });
}

/**
 * Chamfer or fillet along edges (world space). For each edge a tool shape is
 * built in the corner between its two faces: a triangular prism (chamfer) or
 * that prism minus a cylinder tangent to both faces (fillet). Tools on
 * outside edges are cut away; tools in inside corners are added, which fills
 * the corner. Curved edges are handled piece by piece.
 *
 * Where a picked outside edge ends at a picked inside edge (the rim of a
 * pocket and the corner running down from it), the two cannot be cut
 * independently: filling the inside corner changes the outline the rim
 * continues along (a chamfer fill turns the rim through a diagonal, a fillet
 * fill through an arc). So the inside edges are done first, then the outside
 * edges are looked up again on the filled solid (see carryOver) and cut with
 * the new edges joining them, so the rim runs round the corner in one piece.
 */
export function edgeTreatment(
  wasm: ManifoldToplevel,
  item: PlacedMesh,
  segments: EdgeSegment[],
  kind: 'chamfer' | 'fillet',
  size: number,
): Piece {
  if (segments.length === 0) throw new Error('Pick at least one edge');
  if (!(size > 0)) throw new Error('The size must be more than 0');
  return withCleanup((keep) => {
    const solid = keep(meshDataToManifold(wasm, item.mesh, item.matrix));
    const frames = segments.map(edgeFrame);
    const bent = checkSizes(wasm, keep, solid, segments, frames, frames.map((f) => (f.angle < 0.35 || f.angle > Math.PI - 0.05 ? null : legOf(kind, size, f.angle))), key);
    const inside = segments.filter((s) => !s.convex);
    const outside = segments.filter((s) => s.convex);
    const ends = (s: EdgeSegment) => [key(s.a), key(s.b)];
    const meet = outside.some((o) => inside.some((i) => ends(o).some((k) => ends(i).includes(k))));
    let result: Manifold;
    if (!meet) {
      result = treat(wasm, keep, solid, segments, kind, size, bent);
    } else {
      const filled = treat(wasm, keep, solid, inside, kind, size, bent);
      const next = carryOver(solid, filled, outside);
      result = next.length ? treat(wasm, keep, filled, next, kind, size, bent) : filled;
    }
    return toPiece(dropSlivers(wasm, keep, result, solid));
  });
}

/**
 * The picked outside edges as they stand on `filled` (the solid after the
 * inside corners were filled). An edge may be shorter now (the fill ate its
 * end), so every sharp outside edge of `filled` lying on a picked one with the
 * same two faces counts. The fill also made new edges where it meets the face
 * the rim runs along: those that continue a matched edge from a point that was
 * not a corner of the original solid (the diagonal of a chamfer fill, the
 * facets of a round) join the picked edges, so the rim carries on round it.
 */
function carryOver(
  original: Manifold,
  filled: Manifold,
  picked: EdgeSegment[],
): EdgeSegment[] {
  const sharp = findEdges(manifoldToMeshData(filled)).segments.filter((e) => e.convex);
  const before = manifoldToMeshData(original);
  const old = new Set<string>();
  for (let i = 0; i < before.positions.length; i += 3) old.add(key([before.positions[i], before.positions[i + 1], before.positions[i + 2]]));
  const known = findEdges(before).segments;
  const facing = (a: V3, b: V3) => dot3(a, b) > 0.999;
  const sameFaces = (x: EdgeSegment, y: EdgeSegment) =>
    (facing(x.n1, y.n1) && facing(x.n2, y.n2)) || (facing(x.n1, y.n2) && facing(x.n2, y.n1));
  const frameOf = new Map<EdgeSegment, ReturnType<typeof edgeFrame>>();
  const onLine = (p: EdgeSegment, q: V3) => {
    let f = frameOf.get(p);
    if (!f) frameOf.set(p, (f = edgeFrame(p)));
    const d: V3 = [q[0] - p.a[0], q[1] - p.a[1], q[2] - p.a[2]];
    const along = dot3(d, f.u);
    const off = Math.hypot(d[0] - f.u[0] * along, d[1] - f.u[1] * along, d[2] - f.u[2] * along);
    return off < 1e-3 && along > -1e-3 && along < f.length + 1e-3;
  };
  const taken = new Set<EdgeSegment>(sharp.filter((e) => picked.some((p) => sameFaces(p, e) && onLine(p, e.a) && onLine(p, e.b))));
  for (let grew = true; grew;) {
    grew = false;
    for (const e of sharp) {
      // An edge the solid already had (the rest of a rim) is only picked if the user picked it.
      if (taken.has(e) || known.some((p) => sameFaces(p, e) && onLine(p, e.a) && onLine(p, e.b))) continue;
      const joins = [...taken].some((m) =>
        [e.a, e.b].some((p) => !old.has(key(p)) && (key(p) === key(m.a) || key(p) === key(m.b))) &&
        [e.n1, e.n2].some((n) => [m.n1, m.n2].some((o) => facing(n, o))));
      if (joins) { taken.add(e); grew = true; }
    }
  }
  return [...taken];
}

/** The cutting and filling for the given edges, on an already built solid. */
function treat(
  wasm: ManifoldToplevel,
  keep: <M extends Manifold>(m: M) => M,
  solid: Manifold,
  segments: EdgeSegment[],
  kind: 'chamfer' | 'fillet',
  size: number,
  bent: Set<EdgeSegment> = new Set(),
): Manifold {
  const { Manifold } = wasm;
  // Which picked segments meet at each point (to tell curve joints from corners).
  const at = new Map<string, number[]>();
  segments.forEach((s, i) => {
    for (const p of [s.a, s.b]) {
      const list = at.get(key(p));
      if (list) list.push(i);
      else at.set(key(p), [i]);
    }
  });
  const frames = segments.map(edgeFrame);
  /** True if the edge carries on smoothly at p (a curve), not ending or turning a corner. */
  const continues = (i: number, p: V3) => {
    const others = (at.get(key(p)) ?? []).filter((j) => j !== i);
    return others.length === 1 && Math.abs(dot3(frames[i].u, frames[others[0]].u)) > Math.cos(CURVE_TURN);
  };

  const remove: Manifold[] = [];
  const fill: Manifold[] = [];
  /** Each segment's tool corners (null where the fold is too sharp for a tool) */
  const prisms: (Vec3[] | null)[] = segments.map(() => null);
  const segmentTools: (Manifold | null)[] = segments.map(() => null);
  /** How far each segment's tool runs past its end points (a, b) */
  const reachPast: { a: number; b: number }[] = segments.map(() => ({ a: 0, b: 0 }));
  /** Fillet edges handled as part of a chain */
  const inChain = new Set<number>();
  const probeCubes = (i: number) => Math.min(legOf(kind, size, frames[i].angle), 0.05);
  /** Is there solid just past end p of segment i, in the corner between its faces? */
  const solidPast = (i: number, p: V3, out: V3) => {
    const f = frames[i];
    const probe = probeCubes(i);
    const at = add(add(p, out, probe), norm(add(f.t1, f.t2)), probe);
    const cube = keep(keep(Manifold.cube([probe / 2, probe / 2, probe / 2], true)).translate(at));
    return keep(solid.intersect(cube)).volume() > 0;
  };
  /**
   * Past end p of outside edge i (direction `out`), is there nothing on the edge line
   * itself and nothing just under either of its two faces? Then the faces end at p and
   * whatever solid stands past it lies only in the corner between them.
   */
  const box = solid.boundingBox();
  const reachAll = 2 * Math.hypot(box.max[0] - box.min[0], box.max[1] - box.min[1], box.max[2] - box.min[2]) + 1;
  const leftoverWedge = (i: number, p: V3, out: V3) => {
    const s = segments[i];
    const probe = probeCubes(i);
    const beyond = add(p, out, probe);
    const tiny = 1e-3;
    return [add(beyond, add(s.n1, s.n2), -tiny), add(beyond, s.n1, -tiny), add(beyond, s.n2, -tiny)]
      .every((q) => !pointInside(wasm, solid, q, reachAll));
  };
  const usable = (i: number) => frames[i].angle >= 0.35 && frames[i].angle <= Math.PI - 0.05;
  /** The picked edges that are not part of a curve (no end carries on smoothly) */
  const lone = (i: number) => usable(i) && !continues(i, segments[i].a) && !continues(i, segments[i].b);
  /**
   * The mitre plane at end p of segment i, when exactly one other picked edge
   * j ends there at an inside corner on a face they share. Both sides must
   * see solid past the end, so each makes the same decision.
   */
  const mitres = new Map<string, { normal: V3; offset: number }>();
  const mitreAt = (i: number, p: V3, out: V3) => {
    const k = `${i}@${key(p)}`;
    if (mitres.has(k)) return true;
    const list = at.get(key(p)) ?? [];
    if (list.length !== 2) return false;
    const j = list.find((x) => x !== i)!;
    const si = segments[i], sj = segments[j];
    if (j === i || !si.convex || !sj.convex || !lone(i) || !lone(j)) return false;
    const shares = [si.n1, si.n2].some((a) => [sj.n1, sj.n2].some((b) => dot3(a, b) > 0.999));
    if (!shares) return false;
    const dj = key(sj.a) === key(p) ? frames[j].u : ([-frames[j].u[0], -frames[j].u[1], -frames[j].u[2]] as V3);
    if (!solidPast(j, p, [-dj[0], -dj[1], -dj[2]])) return false;
    const di = [-out[0], -out[1], -out[2]] as V3; // from the shared point along edge i
    const n = norm([di[0] - dj[0], di[1] - dj[1], di[2] - dj[2]]);
    if (Math.hypot(di[0] - dj[0], di[1] - dj[1], di[2] - dj[2]) < 0.2) return false; // near parallel
    mitres.set(k, { normal: n, offset: dot3(n, p) });
    return true;
  };
  segments.forEach((s, i) => {
    const f = frames[i];
    // Very sharp folds would need enormously long tools (the source of spikes); skip them.
    if (f.angle < 0.35 || f.angle > Math.PI - 0.05) return;
    // Distance from the edge along each face where the chamfer/fillet ends.
    const leg = legOf(kind, size, f.angle);
    // On curves, overlap the neighbouring piece slightly so no slivers remain;
    // at corners and ends stop exactly at the end point.
    const overlap = Math.min(f.length * 0.08, size * 0.5) + 1e-3;
    // At a corner, an outside edge's tool runs on past the end: whatever it
    // reaches there lies beyond this edge's chamfer within the two faces, so
    // the cut ends on the neighbouring face itself (exact at any corner angle;
    // ending square to the edge only fits where that face is at 90°).
    const corner = leg * 3 + size;
    // But at an inside (reflex) corner of the solid, just past the end lies more
    // material (the face carries on there): the tool must stop square, or it
    // would cut a groove into that face. Where exactly one other picked edge
    // turns that corner on the same face, both tools instead run past the
    // corner and are cut off along the mitre plane, so the two chamfers (or
    // rounds) meet in a clean line.
    const extend = (p: V3, out: V3) => {
      if (continues(i, p)) return overlap;
      if (!solidPast(i, p, out)) return corner;
      // An edge that ends at a corner already cut by an earlier bevel or round (the third
      // edge of a cube corner whose other two edges were done first): only a leftover
      // wedge of the old corner stands past the end, between the two faces, which now stop
      // at the cut. The tool runs on through it, so the three cuts meet cleanly.
      if (s.convex && leftoverWedge(i, p, out)) return corner;
      return mitreAt(i, p, out) ? corner : 0;
    };
    const extA = !s.convex ? 0 : extend(s.a, [-f.u[0], -f.u[1], -f.u[2]]);
    const extB = !s.convex ? 0 : extend(s.b, f.u);
    const a = add(s.a, f.u, -extA), b = add(s.b, f.u, extB);
    // The tool's sides would lie exactly in the two faces and its ridge on the
    // edge; such touching surfaces can leave paper-thin plates standing. Push
    // the sides a hair out of the solid (into it, for a filled inside corner):
    // the ridge moves off the edge, and the two far corners slide along the
    // chamfer line past the faces, so the chamfer surface itself stays exact.
    const m = (s.convex ? 1 : -1) * EPS_OFFSET;
    const ridge = (p: V3) => add(p, add(s.n1, s.n2), m);
    const across = norm([f.t1[0] - f.t2[0], f.t1[1] - f.t2[1], f.t1[2] - f.t2[2]]);
    const onFace1 = (p: V3) => add(add(p, f.t1, leg), across, EPS_OFFSET * 4);
    const onFace2 = (p: V3) => add(add(p, f.t2, leg), across, -EPS_OFFSET * 4);
    // Where a face bends away from the tool next to a rim end, the solid still
    // stands out past the tool's side (a thin plate or a step beside the
    // chamfer). The chamfer line is carried on past both legs, so the plane
    // cuts through whatever is there and leaves no ledge: all of it lies
    // beyond that plane. The ridge stays where it is.
    const spread = bent.has(s) ? TOOL_MARGIN * leg : 0;
    const carried = (p: V3, face: V3, other: V3) => {
      if (spread === 0) return p;
      const d = norm([p[0] - other[0], p[1] - other[1], p[2] - other[2]]);
      return add(p, d, spread / Math.max(0.3, dot3(d, face)));
    };
    const ridgeA = ridge(a), ridgeB = ridge(b);
    const [a1, a2, b1, b2] = [onFace1(a), onFace2(a), onFace1(b), onFace2(b)];
    const pts: Vec3[] = [ridgeA, carried(a1, s.n1, a2), carried(a2, s.n2, a1), ridgeB, carried(b1, s.n1, b2), carried(b2, s.n2, b1)];
    let tool = keep(Manifold.hull(pts));
    prisms[i] = pts;
    reachPast[i] = { a: extA, b: extB };
    if (kind === 'fillet') {
      const bisector = norm(add(f.t1, f.t2));
      const centre = add(a, bisector, size / Math.sin(f.angle / 2));
      const cylinder = keep(keep(Manifold.cylinder(f.length + extA + extB, size, size, 48)).transform(frameMatrix(f.u, centre)));
      tool = keep(tool.subtract(cylinder));
    }
    for (const p of [s.a, s.b]) {
      const m = mitres.get(`${i}@${key(p)}`);
      if (m) tool = keep(tool.trimByPlane(m.normal, m.offset));
    }
    segmentTools[i] = tool;
  });
  // Joints along a curve (a cylinder rim is many short straight pieces):
  // neighbouring tools meet at an angle and leave a thin wedge between them,
  // which would stay standing as a fin. Each joint gets the hull of the two
  // tools. A fillet then needs the rounding put back along the whole curve:
  // its edges are grouped into chains, and each chain's tools (with their
  // joints) lose what the rolling ball sweeps along it in one operation.
  const parent = segments.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const jointTools = new Map<number, Manifold[]>();
  /** Mitre discs of the rolling ball's path at each joint, by point key */
  const nodes = new Map<string, { centre: V3; normal: V3 }>();
  const axisPoint = (k: number, p: V3): V3 => {
    const f = frames[k];
    return add(p, norm(add(f.t1, f.t2)), size / Math.sin(f.angle / 2));
  };
  const into = (k: number, p: V3): V3 => {
    const u = frames[k].u;
    return key(segments[k].a) === key(p) ? u : [-u[0], -u[1], -u[2]];
  };
  /**
   * The three corners of segment k's tool where it meets the joint at `p`:
   * its end cross-section brought back to p, then pushed a little into its
   * own segment so the joint overlaps the tool. (The hull of whole tools
   * would span two segments and cut inside the chamfer line on a curve.)
   */
  const jointEnd = (k: number, p: V3, other: number): Vec3[] => {
    const atA = key(segments[k].a) === key(p);
    const d = into(k, p);
    const push = (atA ? reachPast[k].a : reachPast[k].b) + Math.min(frames[k].length, frames[other].length) * 0.05;
    return (atA ? prisms[k]!.slice(0, 3) : prisms[k]!.slice(3, 6)).map((q) => add(q, d, push) as Vec3);
  };
  for (const [pk, list] of at) {
    if (list.length !== 2) continue;
    const [i, j] = list;
    if (!prisms[i] || !prisms[j] || segments[i].convex !== segments[j].convex) continue;
    const shared = key(segments[i].a) === pk ? segments[i].a : segments[i].b;
    if (!continues(i, shared)) continue;
    parent[find(i)] = find(j);
    const hull = keep(Manifold.hull([...jointEnd(i, shared, j), ...jointEnd(j, shared, i)]));
    jointTools.set(i, [...(jointTools.get(i) ?? []), hull]);
    if (kind === 'fillet') {
      const ai = axisPoint(i, shared), aj = axisPoint(j, shared);
      const di = into(i, shared), dj = into(j, shared);
      nodes.set(pk, {
        centre: [(ai[0] + aj[0]) / 2, (ai[1] + aj[1]) / 2, (ai[2] + aj[2]) / 2],
        normal: norm([dj[0] - di[0], dj[1] - di[1], dj[2] - di[2]]),
      });
    }
  }
  const groups = new Map<number, number[]>();
  segments.forEach((_, i) => {
    if (!prisms[i]) return;
    const g = find(i);
    groups.set(g, [...(groups.get(g) ?? []), i]);
  });
  for (const members of groups.values()) {
    const joints = members.flatMap((i) => jointTools.get(i) ?? []);
    if (joints.length === 0) continue; // a lone edge: its own tool is enough
    const side = segments[members[0]].convex ? remove : fill;
    if (kind === 'chamfer') {
      side.push(...joints);
      continue;
    }
    // The chain's fillet: corner region minus the ball's sweep, mitred at the joints.
    const disc = (centre: V3, normal: V3) =>
      keep(keep(Manifold.cylinder(1e-3, size, size, 48)).transform(frameMatrix(normal, centre)));
    const corner = keep(Manifold.union([...members.map((i) => keep(Manifold.hull(prisms[i]!))), ...joints]));
    const pieces = members.map((i) => {
      const s = segments[i];
      const end = (p: V3, sign: number) => {
        const node = nodes.get(key(p));
        if (node) return disc(node.centre, node.normal);
        // A chain end: the ball stops square with the edge.
        return disc(add(axisPoint(i, p), frames[i].u, sign * 1e-3), frames[i].u);
      };
      return keep(Manifold.hull([end(s.a, -1), end(s.b, 1)]));
    });
    side.push(keep(corner.subtract(keep(Manifold.union(pieces)))));
    for (const i of members) inChain.add(i);
  }
  segmentTools.forEach((tool, i) => {
    if (tool && !inChain.has(i)) (segments[i].convex ? remove : fill).push(tool);
  });
  // Fillet corners where three picked edges meet: round them with a sphere.
  if (kind === 'fillet') {
    for (const [, list] of at) {
      if (list.length !== 3) continue;
      const corner = cornerTool(wasm, keep, segments, list, size);
      if (corner) (segments[list[0]].convex ? remove : fill).push(corner);
    }
  }
  let result = solid;
  if (remove.length) result = keep(result.subtract(keep(Manifold.union(remove))));
  if (fill.length) result = keep(result.add(keep(Manifold.union(fill))));
  return result;
}

/**
 * Edge tools on faceted curves (cylinder rims, cone and pyramid edges) can
 * cut tiny loose slivers off where neighbouring tools meet. Remove pieces
 * the original did not have: keep as many pieces as it had (the largest)
 * plus any other piece of real size.
 */
function dropSlivers(
  wasm: ManifoldToplevel,
  keep: <M extends Manifold>(m: M) => M,
  result: Manifold,
  original: Manifold,
): Manifold {
  // Pieces with their hollows (a shelled object's inside is not a piece of its own).
  const before = solidPieces(original).map(keep).length;
  const parts = solidPieces(result).map(keep);
  if (parts.length <= before) return result;
  const total = original.volume();
  const sized = parts.map((m) => ({ m, v: m.volume() })).sort((x, y) => y.v - x.v);
  const kept = sized.filter((p, i) => i < before || p.v > total * 0.01).map((p) => p.m);
  return keep(wasm.Manifold.compose(kept));
}

/**
 * Edges of a faceted curve turn by less than this at each joint. Turns of 40
 * degrees and more are corners: a corner of 45 degrees (the diagonal a
 * chamfered inside corner leaves in a rim) must not be decided by rounding.
 */
const CURVE_TURN = (40 * Math.PI) / 180;

/** How far (mm) edge tools reach past the faces they cut along */
const EPS_OFFSET = 0.002;

const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/**
 * Where three filleted edges meet at a corner, the edge tools leave the very
 * corner square. The rounded corner is a piece of sphere touching all three
 * faces: its centre sits `r` inside each face plane. The tool is the corner
 * region (hull of the corner, the sphere centre and where the sphere touches
 * the faces and edges) minus that sphere. Only for corners whose three edges
 * are all outside or all inside edges.
 */
function cornerTool(
  wasm: ManifoldToplevel,
  keep: <M extends Manifold>(m: M) => M,
  segments: EdgeSegment[],
  list: number[],
  r: number,
): Manifold | null {
  const segs = list.map((i) => segments[i]);
  if (!segs.every((s) => s.convex === segs[0].convex)) return null;
  // The corner point is the endpoint all three share.
  const k = (p: V3) => p.map((v) => Math.round(v * 1e4)).join(',');
  const firstKeys = [k(segs[0].a), k(segs[0].b)];
  const vKey = firstKeys.find((fk) => segs.every((s) => k(s.a) === fk || k(s.b) === fk));
  if (!vKey) return null;
  const V = k(segs[0].a) === vKey ? segs[0].a : segs[0].b;
  // The three distinct face normals around the corner.
  const normals: V3[] = [];
  for (const s of segs) {
    for (const n of [s.n1, s.n2]) if (!normals.some((m) => dot3(m, n) > 0.999)) normals.push(n);
  }
  if (normals.length !== 3) return null;
  // Centre: r inside each face for an outside corner, r outside (in the empty space) for an inside one.
  const sign = segs[0].convex ? -1 : 1;
  const [n1, n2, n3] = normals;
  const rhs = normals.map((n) => dot3(n, V) + sign * r);
  const det = dot3(n1, cross(n2, n3));
  if (Math.abs(det) < 1e-6) return null;
  const centre = add(add(
    cross(n2, n3).map((v) => (v * rhs[0]) / det) as V3,
    cross(n3, n1).map((v) => (v * rhs[1]) / det) as V3),
    cross(n1, n2).map((v) => (v * rhs[2]) / det) as V3);
  // Region near the corner: the corner, the centre, its feet on the three faces and three edges.
  const pts: Vec3[] = [V, centre];
  for (const n of normals) pts.push(add(centre, n, -sign * r));
  for (const s of segs) {
    const other = k(s.a) === vKey ? s.b : s.a;
    const dir = norm([other[0] - V[0], other[1] - V[1], other[2] - V[2]]);
    const t = dot3([centre[0] - V[0], centre[1] - V[1], centre[2] - V[2]], dir);
    pts.push(add(V, dir, t));
  }
  const region = keep(wasm.Manifold.hull(pts));
  const ball = keep(keep(wasm.Manifold.sphere(r, 48)).translate(centre));
  return keep(region.subtract(ball));
}

/**
 * Triangular gusset in an inside corner: legs along each wall, given
 * thickness, centred at `position` (0..1) along the picked edge.
 */
export function gusset(
  wasm: ManifoldToplevel,
  item: PlacedMesh,
  edge: EdgeSegment,
  o: { leg1: number; leg2: number; thickness: number; position: number },
): Piece {
  if (!(o.leg1 > 0)) throw new Error('Leg 1 must be more than 0');
  if (!(o.leg2 > 0)) throw new Error('Leg 2 must be more than 0');
  if (!(o.thickness > 0)) throw new Error('The thickness must be more than 0');
  if (edge.convex) throw new Error('Pick an inside corner (where two walls meet), not an outside edge');
  const f = edgeFrame(edge);
  const { Manifold } = wasm;
  return withCleanup((keep) => {
    const solid = keep(meshDataToManifold(wasm, item.mesh, item.matrix));
    const mid = add(edge.a, f.u, f.length * Math.min(1, Math.max(0, o.position)));
    // Sink the corner slightly into the walls so the gusset fuses with them.
    const corner = add(mid, norm(add(f.t1, f.t2)), -0.05);
    const half = o.thickness / 2;
    const pts: Vec3[] = [];
    for (const side of [-half, half]) {
      const c = add(corner, f.u, side);
      pts.push(c, add(c, f.t1, o.leg1), add(c, f.t2, o.leg2));
    }
    return toPiece(keep(solid.add(keep(Manifold.hull(pts)))));
  });
}

/**
 * Is the surface under the text too busy for it (a thread, a small rounded
 * edge)? Looks only at the triangles near the letters: those touching the
 * letters' footprint and within a little more than the depth of the face.
 * Many of them leaning more than 45 degrees away from the face normal, or a
 * huge number of triangles, means the letter columns cannot follow it. Plain
 * flat faces and gently curved ones (a cylinder's side) stay well clear.
 */
function faceTooComplex(item: PlacedMesh, frame: Mat4, polygons: [number, number][][], depth: number): boolean {
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const poly of polygons) {
    for (const [x, y] of poly) {
      x0 = Math.min(x0, x); x1 = Math.max(x1, x);
      y0 = Math.min(y0, y); y1 = Math.max(y1, y);
    }
  }
  const zLimit = depth + 1;
  const m = item.matrix, P = item.mesh.positions, I = item.mesh.indices;
  // Vertex into the face frame (frame columns: x, y, face normal, origin; it is a rigid placement).
  const local = (i: number, out: number[]) => {
    const x = P[3 * i], y = P[3 * i + 1], z = P[3 * i + 2];
    const wx = m[0] * x + m[4] * y + m[8] * z + m[12] - frame[12];
    const wy = m[1] * x + m[5] * y + m[9] * z + m[13] - frame[13];
    const wz = m[2] * x + m[6] * y + m[10] * z + m[14] - frame[14];
    out[0] = wx * frame[0] + wy * frame[1] + wz * frame[2];
    out[1] = wx * frame[4] + wy * frame[5] + wz * frame[6];
    out[2] = wx * frame[8] + wy * frame[9] + wz * frame[10];
  };
  const a = [0, 0, 0], b = [0, 0, 0], c = [0, 0, 0];
  const cos45 = Math.SQRT1_2;
  let near = 0, stray = 0;
  for (let t = 0; t < I.length; t += 3) {
    local(I[t], a); local(I[t + 1], b); local(I[t + 2], c);
    if (Math.max(a[0], b[0], c[0]) < x0 || Math.min(a[0], b[0], c[0]) > x1) continue;
    if (Math.max(a[1], b[1], c[1]) < y0 || Math.min(a[1], b[1], c[1]) > y1) continue;
    if (Math.max(a[2], b[2], c[2]) < -zLimit || Math.min(a[2], b[2], c[2]) > zLimit) continue;
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len < 1e-12) continue;
    near++;
    // Cosine to the face normal. Triangles facing right away (a thin plate's back) are not "busy".
    const cosine = nz / len;
    if (cosine < cos45 && cosine > -0.9) stray++;
  }
  return near > 20000 || (near >= 30 && stray > 0.25 * near);
}

/**
 * The separate parts of `under` (the letters' material, all surfaces), cut down
 * to those on the clicked face. Each part's extent along the face normal is
 * measured from the clicked point (z = 0 in the face frame). The part nearest
 * z = 0 starts a cluster; parts whose extent lies within one `depth` of the
 * cluster join it, until none does. Letters that step up or down along a
 * curved face chain together; a second surface further away does not join.
 */
function lettersOnClickedFace(
  keep: <M extends Manifold>(m: M) => M,
  under: Manifold,
  frame: Mat4,
  depth: number,
): Manifold[] {
  const parts = under.decompose().map(keep);
  const spans = parts.map((part) => {
    const g = part.getMesh();
    const stride = g.numProp;
    let lo = Infinity, hi = -Infinity;
    for (let v = 0; v < g.vertProperties.length; v += stride) {
      const z = (g.vertProperties[v] - frame[12]) * frame[8]
        + (g.vertProperties[v + 1] - frame[13]) * frame[9]
        + (g.vertProperties[v + 2] - frame[14]) * frame[10];
      lo = Math.min(lo, z);
      hi = Math.max(hi, z);
    }
    return { lo, hi };
  }).map((s, i) => ({ ...s, i })).filter((s) => s.lo <= s.hi);
  if (spans.length === 0) return [];
  const gap = (s: { lo: number; hi: number }) => (s.lo > 0 ? s.lo : s.hi < 0 ? -s.hi : 0);
  const first = spans.reduce((best, s) => (gap(s) < gap(best) ? s : best));
  const used = new Set([first.i]);
  let lo = first.lo, hi = first.hi;
  for (let grew = true; grew;) {
    grew = false;
    for (const s of spans) {
      if (used.has(s.i) || s.lo > hi + depth + 1e-6 || s.hi < lo - depth - 1e-6) continue;
      used.add(s.i);
      lo = Math.min(lo, s.lo);
      hi = Math.max(hi, s.hi);
      grew = true;
    }
  }
  return parts.filter((_, i) => used.has(i));
}

/**
 * Raised (emboss) or recessed (deboss) text on a face. `polygons` are the
 * glyph outlines in the face plane (mm, centred on the clicked point);
 * `frame` places that plane: its Z axis is the face normal.
 */
export function textOnFace(
  wasm: ManifoldToplevel,
  item: PlacedMesh,
  o: { polygons: [number, number][][]; depth: number; mode: 'emboss' | 'deboss'; frame: Mat4 },
): Piece & { letters: MeshData } {
  if (o.polygons.length === 0) throw new Error('Type some text');
  if (!(o.depth > 0)) throw new Error('The height or depth must be more than 0');
  if (faceTooComplex(item, o.frame, o.polygons, o.depth)) {
    throw new Error('This face is too complex for text (e.g. a thread or a small rounded edge): pick a flat or gently curved face.');
  }
  const { Manifold, CrossSection } = wasm;
  return withCleanup((keep) => {
    const solid = keep(meshDataToManifold(wasm, item.mesh, item.matrix));
    // Font outlines run one way around solid parts and the other way around
    // holes, so non-zero filling keeps the holes in O and A while also filling
    // places where a letter is drawn from overlapping outlines.
    const section = new CrossSection(o.polygons, 'NonZero');
    try {
      // The letters follow the surface, so they sit right on round faces too:
      // tall letter columns along the face normal are cut to the layer between
      // the surface and the surface pushed out (emboss) or in (deboss) by the
      // depth. Over the text's width a curved surface drops away by at most
      // that width, so columns reaching that far each way always meet it.
      // (A loop, not Math.max(...points): long texts have too many points to spread.)
      let reachX = 0, reachY = 0;
      for (const poly of o.polygons) for (const p of poly) {
        reachX = Math.max(reachX, Math.abs(p[0]));
        reachY = Math.max(reachY, Math.abs(p[1]));
      }
      const reach = Math.hypot(reachX, reachY) + o.depth + 1;
      const columns = keep(keep(keep(Manifold.extrude(section, 2 * reach)).translate([0, 0, -reach])).transform(o.frame));
      const n: Vec3 = [o.frame[8], o.frame[9], o.frame[10]];
      const shift = (d: number) => keep(solid.translate([n[0] * d, n[1] * d, n[2] * d]));
      const emboss = o.mode === 'emboss';
      // What the letters are made of, under all of the columns: material within
      // `depth` outside the surface (emboss), or within it (deboss).
      const under = emboss
        ? keep(keep(columns.intersect(shift(o.depth))).subtract(solid))
        : keep(solid.intersect(keep(columns.subtract(shift(-o.depth)))));
      // Other surfaces under the columns (a floor inside a hollow, a lower
      // plate) get a copy too: keep only the letters on the clicked surface.
      const kept = lettersOnClickedFace(keep, under, o.frame, o.depth);
      if (kept.length === 0) throw new Error('The text does not reach this face. Click the face again.');
      // The letters' own solid (world space) is returned too, so the tool can
      // draw it in a strong colour while the text is being placed.
      const letters = keep(Manifold.compose(kept));
      return { ...toPiece(keep(emboss ? solid.add(letters) : solid.subtract(letters))), letters: manifoldToMeshData(letters) };
    } finally {
      section.delete();
    }
  });
}

const fmtMm = (v: number) => `${Math.round(v * 100) / 100} mm`;

/** Directions to look around a point: the 6 axes and the 8 cube corners. */
const LOOK: Vec3[] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
  ...[-1, 1].flatMap((x) => [-1, 1].flatMap((y) => [-1, 1].map((z) => [x / Math.sqrt(3), y / Math.sqrt(3), z / Math.sqrt(3)] as Vec3))),
];

/**
 * Is there room for a hollow with walls `t` thick: a point inside that is
 * more than `t` from the surface? Rays go inward from sampled faces; the
 * middle of each chord at least 2t long is where room is likeliest, and from
 * there the surface is looked for in 14 directions. Looking in only some
 * directions can overestimate the room (then the hollowing simply runs, and
 * still reports an empty result if nothing fits), so a refusal means none of
 * up to a few thousand likeliest spots has room.
 */
export function wallsFit(m: Manifold, t: number): boolean {
  const box = m.boundingBox();
  const size = [0, 1, 2].map((k) => box.max[k] - box.min[k]);
  if (Math.min(...size) <= 2 * t) return false;
  const reach = Math.hypot(...size) + 1;
  const n = [0, 0, 0];
  const g = m.getMesh();
  const p = g.vertProperties, idx = g.triVerts, np = g.numProp;
  const triCount = idx.length / 3;
  /** Distance from `from` to the first surface hit going to `to` (past `skip`), or null. */
  const firstHit = (from: Vec3, to: Vec3, skip = 0): number | null => {
    for (const h of m.rayCast(from, to)) {
      const d = Math.hypot(h.position[0] - from[0], h.position[1] - from[1], h.position[2] - from[2]);
      if (d > skip) return d;
    }
    return null;
  };
  const room = (c: Vec3): boolean => {
    for (const d of LOOK) {
      const hit = firstHit(c, [c[0] + d[0] * reach, c[1] + d[1] * reach, c[2] + d[2] * reach]);
      if (hit === null || hit <= t) return false;
    }
    return true;
  };
  for (const samples of [400, 4000]) {
    const step = Math.max(1, Math.floor(triCount / samples));
    for (let i = 0; i < triCount; i += step) {
      const [a, b, c] = [idx[i * 3] * np, idx[i * 3 + 1] * np, idx[i * 3 + 2] * np];
      triangleNormal(p, a, b, c, n);
      const len = Math.hypot(n[0], n[1], n[2]);
      if (len === 0) continue;
      const nx = n[0] / len, ny = n[1] / len, nz = n[2] / len;
      const cx = (p[a] + p[b] + p[c]) / 3, cy = (p[a + 1] + p[b + 1] + p[c + 1]) / 3, cz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
      const start: Vec3 = [cx - nx * 1e-3, cy - ny * 1e-3, cz - nz * 1e-3];
      const chord = firstHit(start, [cx - nx * reach, cy - ny * reach, cz - nz * reach], 1e-3);
      if (chord === null || chord < 2 * t) continue;
      const half = chord / 2;
      if (room([start[0] - nx * half, start[1] - ny * half, start[2] - nz * half])) return true;
    }
    if (step === 1) break;
  }
  return false;
}

/**
 * Shrinking the surface by a ball takes time in proportion to its triangles
 * (about 20 s for 10,000). Above this many, Shell refuses rather than run for
 * minutes, unless the object is a bolt, nut or rod with a plain stand-in.
 */
export const SHELL_MAX_TRIANGLES = 20_000;

/** Segments of the ball that shrinks the object for Shell */
const BALL_SEGMENTS = 16;
let ballInnerRadius: number | null = null;

/**
 * How far the flat sides of a unit ball with BALL_SEGMENTS segments are from its
 * centre: the smallest distance from the centre to the plane of any triangle.
 * The ball is a polyhedron with its corners on the sphere, so between corners
 * it is smaller than a true sphere by up to this much.
 */
function ballInner(wasm: ManifoldToplevel): number {
  if (ballInnerRadius === null) {
    const ball = wasm.Manifold.sphere(1, BALL_SEGMENTS);
    const g = ball.getMesh();
    const p = g.vertProperties, stride = g.numProp, idx = g.triVerts;
    let least = Infinity;
    for (let t = 0; t < idx.length; t += 3) {
      const a = idx[t] * stride, b = idx[t + 1] * stride, c = idx[t + 2] * stride;
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len < 1e-12) continue;
      least = Math.min(least, Math.abs(p[a] * nx + p[a + 1] * ny + p[a + 2] * nz) / len);
    }
    ball.delete();
    ballInnerRadius = least;
  }
  return ballInnerRadius;
}

/**
 * Hollow the object, keeping walls `thickness` thick. The inside surface is
 * the object shrunk by a ball that holds a sphere of that radius.
 * For a bolt, nut or rod (`thread` given), the inside comes from a plain
 * stand-in without the thread (see threadStandIn): just as safe for the wall
 * thickness, and far quicker. The outside keeps every detail either way.
 */
export function shell(wasm: ManifoldToplevel, item: PlacedMesh, thickness: number, thread?: ThreadInfo): Piece {
  if (!(thickness > 0)) throw new Error('The wall thickness must be more than 0');
  const { Manifold } = wasm;
  return withCleanup((keep) => {
    const solid = keep(meshDataToManifold(wasm, item.mesh, item.matrix));
    const inside = thread ? keep(keep(threadStandIn(wasm, thread)).transform(Array.from(item.matrix) as Mat4)) : solid;
    if (!thread && solid.numTri() > SHELL_MAX_TRIANGLES) {
      throw new Error(`This object has ${solid.numTri().toLocaleString()} triangles; hollowing it would take minutes. Shell works on up to ${SHELL_MAX_TRIANGLES.toLocaleString()}.`);
    }
    // Quick answer before the slow part: if no point inside is more than one
    // wall thickness from the surface, there is no room for a hollow at all.
    if (!wallsFit(inside, thickness)) {
      throw new Error(`The walls don't fit: no part of this object is thicker than ${fmtMm(2 * thickness)} (two walls of ${fmtMm(thickness)}), so nothing would be hollowed. Use thinner walls.`);
    }
    // A modest ball keeps this fast; corners inside come out slightly faceted. It is
    // scaled up until its flat sides are `thickness` from its centre, so it holds a
    // true sphere of that radius: no wall comes out thinner than asked (some a little thicker).
    const ball = keep(Manifold.sphere(thickness / ballInner(wasm), BALL_SEGMENTS));
    const inner = keep(inside.minkowskiDifference(ball));
    if (inner.isEmpty()) throw new Error('The walls are thicker than the object; use a smaller thickness');
    return toPiece(keep(solid.subtract(inner)));
  });
}
