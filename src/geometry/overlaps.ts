import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { matrixKey, meshDataToManifold, type PlacedMesh } from './meshData';
import { triangleNormal } from './triangles';

/** Stop looking for more overlaps once the pairs worked out add up to this many triangles. */
const TRIANGLE_BUDGET = 600_000;
/** Faces of the two objects at less than this angle aren't a crossing (cos 1°): shared flat faces give no line. */
const SAME_PLANE = Math.cos(Math.PI / 180);

type Box = [number, number, number, number, number, number];

function worldBox({ mesh, matrix: e }: PlacedMesh): Box {
  const b: Box = [Infinity, Infinity, Infinity, -Infinity, -Infinity, -Infinity];
  const p = mesh.positions;
  for (let i = 0; i < p.length; i += 3) {
    const x = p[i], y = p[i + 1], z = p[i + 2];
    const w = [e[0] * x + e[4] * y + e[8] * z + e[12], e[1] * x + e[5] * y + e[9] * z + e[13], e[2] * x + e[6] * y + e[10] * z + e[14]];
    for (let k = 0; k < 3; k++) {
      b[k] = Math.min(b[k], w[k]);
      b[k + 3] = Math.max(b[k + 3], w[k]);
    }
  }
  return b;
}

/** Edges of an object steeper than this (degrees) between two faces are real edges, as in findEdges. */
const SHARP = Math.cos((30 * Math.PI) / 180);

/** What a set of overlaps gave: crossing curves, and edges of objects that run inside another object (6 numbers per segment). */
export interface OverlapResult {
  crossings: Float32Array;
  inner: Float32Array;
}

/** What each pair of placed objects gave last time, so only new or moved pairs are worked out again. `inner` is null until asked for. */
const pairCache = new Map<string, { crossings: Float32Array; inner: Float32Array | null; triangles: number }>();

/** Forget every remembered pair (for tests). */
export function clearOverlapCache(): void {
  pairCache.clear();
}

/** Identity of an object as placed; null when its mesh has no id (then nothing is remembered). */
const placement = ({ mesh, matrix }: PlacedMesh): string | null => (mesh.id === undefined ? null : `${mesh.id}:${matrixKey(matrix)}`);

const overlap = (a: Box, b: Box) => a[0] < b[3] && b[0] < a[3] && a[1] < b[4] && b[1] < a[4] && a[2] < b[5] && b[2] < a[5];

/**
 * Lines where the surfaces of overlapping objects cross (two cubes pushed into
 * each other), in world space, 6 numbers per segment. For each pair whose
 * boxes overlap, the shared part A∩B is worked out; Manifold remembers which
 * input every triangle of the result came from, so the crossing is exactly
 * the edges between a triangle of A and a triangle of B. Objects that only
 * touch share no volume and give no line.
 *
 * With `withInner`, also the edges of one object that run inside the other
 * (the cube's corner edge inside a cylinder): sharp edges of A∩B between two
 * triangles of the same original, so they are real edges of that object.
 * Otherwise `inner` is empty and not worked out (a pair remembered without
 * them is worked out again when they are asked for).
 */
export function overlapLines(wasm: ManifoldToplevel, items: PlacedMesh[], withInner: boolean): OverlapResult {
  const boxes = items.map(worldBox);
  const solids = new Map<number, Manifold | null>();
  const owned: Manifold[] = [];
  /** The object as a solid tagged as its own original (null if its mesh isn't a valid solid). */
  const solid = (i: number): Manifold | null => {
    if (!solids.has(i)) {
      let m: Manifold | null = null;
      try {
        const base = meshDataToManifold(wasm, items[i].mesh, items[i].matrix);
        owned.push(base);
        m = base.asOriginal();
        owned.push(m);
      } catch {
        m = null;
      }
      solids.set(i, m);
    }
    return solids.get(i)!;
  };
  const out: number[] = [];
  const outInner: number[] = [];
  const result = () => ({ crossings: new Float32Array(out), inner: new Float32Array(outInner) });
  let triangles = 0;
  const places = items.map(placement);
  /** Cache keys of the pairs met in this call; the others are forgotten at the end. */
  const seen = new Set<string>();
  try {
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        if (!overlap(boxes[i], boxes[j])) continue;
        const pi = places[i], pj = places[j];
        const key = pi !== null && pj !== null ? (pi < pj ? `${pi}|${pj}` : `${pj}|${pi}`) : null;
        const known = key === null ? undefined : pairCache.get(key);
        if (key !== null) seen.add(key);
        if (known && (known.inner || !withInner)) {
          triangles += known.triangles;
          if (triangles > TRIANGLE_BUDGET) return result();
          for (let k = 0; k < known.crossings.length; k++) out.push(known.crossings[k]);
          if (known.inner) for (let k = 0; k < known.inner.length; k++) outInner.push(known.inner[k]);
          continue;
        }
        const a = solid(i), b = solid(j);
        if (!a || !b) continue;
        const pairTriangles = a.numTri() + b.numTri();
        triangles += pairTriangles;
        if (triangles > TRIANGLE_BUDGET) return result();
        const both = a.intersect(b);
        owned.push(both);
        const segments: number[] = [], inner: number[] | null = withInner ? [] : null;
        if (!both.isEmpty()) crossings(both, a.originalID(), b.originalID(), segments, inner);
        const found = { crossings: new Float32Array(segments), inner: inner && new Float32Array(mergeCollinear(inner)), triangles: pairTriangles };
        if (key !== null) pairCache.set(key, found);
        for (let k = 0; k < found.crossings.length; k++) out.push(found.crossings[k]);
        if (found.inner) for (let k = 0; k < found.inner.length; k++) outInner.push(found.inner[k]);
      }
    }
    return result();
  } finally {
    for (const k of [...pairCache.keys()]) if (!seen.has(k)) pairCache.delete(k);
    for (const m of owned) m.delete();
  }
}

/**
 * Add the edges of `both` that lie between a triangle from original A and one
 * from B to `out`, and the sharp edges between two triangles of the same
 * original to `inner` (unless that is null).
 */
function crossings(both: Manifold, idA: number, idB: number, out: number[], inner: number[] | null): void {
  const mesh = both.getMesh();
  const tri = mesh.triVerts;
  const p = mesh.vertProperties;
  const np = mesh.numProp;
  const triCount = tri.length / 3;
  // Which input each triangle came from: 0 = A, 1 = B, -1 = neither.
  const source = new Int8Array(triCount).fill(-1);
  for (let r = 0; r < mesh.runOriginalID.length; r++) {
    const id = mesh.runOriginalID[r];
    const s = id === idA ? 0 : id === idB ? 1 : -1;
    for (let t = mesh.runIndex[r] / 3; t < mesh.runIndex[r + 1] / 3; t++) source[t] = s;
  }
  // Vertices with the same position are one point (a vertex may be repeated for its properties).
  const ids = new Map<string, number>();
  const pointId = (v: number) => {
    const key = `${p[v * np]},${p[v * np + 1]},${p[v * np + 2]}`;
    let id = ids.get(key);
    if (id === undefined) ids.set(key, (id = ids.size));
    return id;
  };
  const normal = (t: number): [number, number, number] => {
    const [a, b, c] = [tri[t * 3] * np, tri[t * 3 + 1] * np, tri[t * 3 + 2] * np];
    const n: [number, number, number] = [0, 0, 0];
    triangleNormal(p, a, b, c, n);
    const len = Math.hypot(...n) || 1;
    return [n[0] / len, n[1] / len, n[2] / len];
  };
  const firstTri = new Map<number, number>();
  for (let t = 0; t < triCount; t++) {
    if (source[t] < 0) continue;
    for (let k = 0; k < 3; k++) {
      const va = tri[t * 3 + k], vb = tri[t * 3 + ((k + 1) % 3)];
      const ia = pointId(va), ib = pointId(vb);
      const key = ia < ib ? ia * 67108864 + ib : ib * 67108864 + ia;
      const other = firstTri.get(key);
      if (other === undefined) {
        firstTri.set(key, t);
        continue;
      }
      const n1 = normal(t), n2 = normal(other);
      const dot = n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2];
      if (source[other] === source[t]) {
        // Two faces of one object that meet at an angle: a real edge of it, lying inside the other.
        if (inner && dot <= SHARP) inner.push(p[va * np], p[va * np + 1], p[va * np + 2], p[vb * np], p[vb * np + 1], p[vb * np + 2]);
        continue;
      }
      if (dot > SAME_PLANE) continue;
      out.push(p[va * np], p[va * np + 1], p[va * np + 2], p[vb * np], p[vb * np + 1], p[vb * np + 2]);
    }
  }
}

/** Join segments that meet end to end in a straight line (an edge split by the triangulation), so the dashes run on across the joins. */
function mergeCollinear(segs: number[]): number[] {
  const count = segs.length / 6;
  if (count < 2) return segs;
  const at = new Map<string, number[]>();
  const keyOf = (i: number, end: number) => `${segs[i * 6 + end * 3]},${segs[i * 6 + end * 3 + 1]},${segs[i * 6 + end * 3 + 2]}`;
  for (let i = 0; i < count; i++) {
    for (let e = 0; e < 2; e++) {
      const k = keyOf(i, e);
      const list = at.get(k);
      if (list) list.push(i);
      else at.set(k, [i]);
    }
  }
  const used = new Uint8Array(count);
  const out: number[] = [];
  /** Unit direction of segment `i`, leaving from its end `from`. */
  const dir = (i: number, from: number): [number, number, number] => {
    const o = i * 6;
    const f = from * 3, g = (1 - from) * 3;
    const v: [number, number, number] = [segs[o + g] - segs[o + f], segs[o + g + 1] - segs[o + f + 1], segs[o + g + 2] - segs[o + f + 2]];
    const len = Math.hypot(...v) || 1;
    return [v[0] / len, v[1] / len, v[2] / len];
  };
  /** Follow the chain from end `end` of segment `i` while exactly one other unused segment continues straight on; returns the far point. */
  const extend = (i: number, end: number): [number, number, number] => {
    let cur = i, e = end; // e: the end of `cur` we are walking toward
    for (;;) {
      const o = cur * 6 + e * 3;
      const point: [number, number, number] = [segs[o], segs[o + 1], segs[o + 2]];
      const list = at.get(keyOf(cur, e))!;
      if (list.length !== 2) return point;
      const next = list[0] === cur ? list[1] : list[0];
      if (used[next]) return point;
      const ne = keyOf(next, 0) === keyOf(cur, e) ? 0 : 1; // the end of `next` we join at
      const d1 = dir(cur, 1 - e), d2 = dir(next, ne);
      if (d1[0] * d2[0] + d1[1] * d2[1] + d1[2] * d2[2] < 0.99999) return point;
      used[next] = 1;
      cur = next;
      e = 1 - ne;
    }
  };
  for (let i = 0; i < count; i++) {
    if (used[i]) continue;
    used[i] = 1;
    const a = extend(i, 0), b = extend(i, 1);
    out.push(a[0], a[1], a[2], b[0], b[1], b[2]);
  }
  return out;
}
