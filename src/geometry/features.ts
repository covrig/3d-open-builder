import type { Manifold, ManifoldToplevel, Mat4, Vec3 } from 'manifold-3d';
import type { Piece } from './cut';
import { edgeFrame, type EdgeSegment, type V3 } from './edges';
import { manifoldToMeshData, meshDataToManifold, type PlacedMesh } from './meshData';
import { recenter } from './meshOps';
import { threadStandIn, type ThreadInfo } from './threads';

const add = (a: V3, b: V3, s = 1): V3 => [a[0] + b[0] * s, a[1] + b[1] * s, a[2] + b[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

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

/**
 * Chamfer or fillet along edges (world space). For each edge a tool shape is
 * built in the corner between its two faces: a triangular prism (chamfer) or
 * that prism minus a cylinder tangent to both faces (fillet). Tools on
 * outside edges are cut away; tools in inside corners are added, which fills
 * the corner. Curved edges are handled piece by piece.
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
  const { Manifold } = wasm;
  // Which picked segments meet at each point (to tell curve joints from corners).
  const key = (p: V3) => p.map((v) => Math.round(v * 1e4)).join(',');
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
    return others.length === 1 && Math.abs(dot3(frames[i].u, frames[others[0]].u)) > Math.cos(Math.PI / 4);
  };

  return withCleanup((keep) => {
    const solid = keep(meshDataToManifold(wasm, item.mesh, item.matrix));
    const remove: Manifold[] = [];
    const fill: Manifold[] = [];
    /** Each segment's tool corners (null where the fold is too sharp for a tool) */
    const prisms: (Vec3[] | null)[] = segments.map(() => null);
    const segmentTools: (Manifold | null)[] = segments.map(() => null);
    /** Fillet edges handled as part of a chain */
    const inChain = new Set<number>();
    segments.forEach((s, i) => {
      const f = frames[i];
      // Very sharp folds would need enormously long tools (the source of spikes); skip them.
      if (f.angle < 0.35 || f.angle > Math.PI - 0.05) return;
      // Distance from the edge along each face where the chamfer/fillet ends.
      const leg = kind === 'chamfer' ? size : size / Math.tan(f.angle / 2);
      // On curves, overlap the neighbouring piece slightly so no slivers remain;
      // at corners and ends stop exactly at the end point.
      const overlap = Math.min(f.length * 0.08, size * 0.5) + 1e-3;
      // At a corner, an outside edge's tool runs on past the end: whatever it
      // reaches there lies beyond this edge's chamfer within the two faces, so
      // the cut ends on the neighbouring face itself (exact at any corner angle;
      // ending square to the edge only fits where that face is at 90°).
      const corner = leg * 3 + size;
      const extA = !s.convex ? 0 : continues(i, s.a) ? overlap : corner;
      const extB = !s.convex ? 0 : continues(i, s.b) ? overlap : corner;
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
      const pts: Vec3[] = [ridge(a), onFace1(a), onFace2(a), ridge(b), onFace1(b), onFace2(b)];
      let tool = keep(Manifold.hull(pts));
      prisms[i] = pts;
      if (kind === 'fillet') {
        const bisector = norm(add(f.t1, f.t2));
        const centre = add(a, bisector, size / Math.sin(f.angle / 2));
        const cylinder = keep(keep(Manifold.cylinder(f.length + extA + extB, size, size, 48)).transform(frameMatrix(f.u, centre)));
        tool = keep(tool.subtract(cylinder));
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
    for (const [pk, list] of at) {
      if (list.length !== 2) continue;
      const [i, j] = list;
      if (!prisms[i] || !prisms[j] || segments[i].convex !== segments[j].convex) continue;
      const shared = key(segments[i].a) === pk ? segments[i].a : segments[i].b;
      if (!continues(i, shared)) continue;
      parent[find(i)] = find(j);
      const hull = keep(Manifold.hull([...prisms[i]!, ...prisms[j]!]));
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
    return toPiece(dropSlivers(wasm, keep, result, solid));
  });
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
  const before = original.decompose().map(keep).length;
  const parts = result.decompose().map(keep);
  if (parts.length <= before) return result;
  const total = original.volume();
  const sized = parts.map((m) => ({ m, v: m.volume() })).sort((x, y) => y.v - x.v);
  const kept = sized.filter((p, i) => i < before || p.v > total * 0.01).map((p) => p.m);
  return keep(wasm.Manifold.compose(kept));
}

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
 * Raised (emboss) or recessed (deboss) text on a face. `polygons` are the
 * glyph outlines in the face plane (mm, centred on the clicked point);
 * `frame` places that plane: its Z axis is the face normal.
 */
export function textOnFace(
  wasm: ManifoldToplevel,
  item: PlacedMesh,
  o: { polygons: [number, number][][]; depth: number; mode: 'emboss' | 'deboss'; frame: Mat4 },
): Piece {
  if (o.polygons.length === 0) throw new Error('Type some text');
  if (!(o.depth > 0)) throw new Error('The height or depth must be more than 0');
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
      const xs = o.polygons.flat();
      const reach = Math.hypot(
        Math.max(...xs.map((p) => Math.abs(p[0]))),
        Math.max(...xs.map((p) => Math.abs(p[1]))),
      ) + o.depth + 1;
      const columns = keep(keep(keep(Manifold.extrude(section, 2 * reach)).translate([0, 0, -reach])).transform(o.frame));
      const n: Vec3 = [o.frame[8], o.frame[9], o.frame[10]];
      const shift = (d: number) => keep(solid.translate([n[0] * d, n[1] * d, n[2] * d]));
      if (o.mode === 'emboss') {
        // Material within `depth` outside the surface, under the letters.
        return toPiece(keep(solid.add(keep(columns.intersect(shift(o.depth))))));
      }
      // Remove the material within `depth` inside the surface, under the letters.
      return toPiece(keep(solid.subtract(keep(columns.subtract(shift(-o.depth))))));
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
      const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
      const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
      let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
      const len = Math.hypot(nx, ny, nz);
      if (len === 0) continue;
      nx /= len; ny /= len; nz /= len;
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

/**
 * Hollow the object, keeping walls `thickness` thick. The inside surface is
 * the object shrunk by a sphere of that radius (an exact inward offset).
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
    // A modest sphere keeps this fast; corners inside come out slightly faceted.
    const ball = keep(Manifold.sphere(thickness, 16));
    const inner = keep(inside.minkowskiDifference(ball));
    if (inner.isEmpty()) throw new Error('The walls are thicker than the object; use a smaller thickness');
    return toPiece(keep(solid.subtract(inner)));
  });
}
