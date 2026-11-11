import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import { matrixKey, meshDataToManifold, type PlacedMesh } from './meshData';

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

/** What each pair of placed objects gave last time, so only new or moved pairs are worked out again. */
const pairCache = new Map<string, { segments: Float32Array; triangles: number }>();

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
 */
export function overlapLines(wasm: ManifoldToplevel, items: PlacedMesh[]): Float32Array {
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
        if (known) {
          triangles += known.triangles;
          if (triangles > TRIANGLE_BUDGET) return new Float32Array(out);
          for (let k = 0; k < known.segments.length; k++) out.push(known.segments[k]);
          continue;
        }
        const a = solid(i), b = solid(j);
        if (!a || !b) continue;
        const pairTriangles = a.numTri() + b.numTri();
        triangles += pairTriangles;
        if (triangles > TRIANGLE_BUDGET) return new Float32Array(out);
        const both = a.intersect(b);
        owned.push(both);
        const segments: number[] = [];
        if (!both.isEmpty()) crossings(both, a.originalID(), b.originalID(), segments);
        if (key !== null) pairCache.set(key, { segments: new Float32Array(segments), triangles: pairTriangles });
        for (let k = 0; k < segments.length; k++) out.push(segments[k]);
      }
    }
    return new Float32Array(out);
  } finally {
    for (const k of [...pairCache.keys()]) if (!seen.has(k)) pairCache.delete(k);
    for (const m of owned) m.delete();
  }
}

/** Add the edges of `both` that lie between a triangle from original A and one from B. */
function crossings(both: Manifold, idA: number, idB: number, out: number[]): void {
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
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const n: [number, number, number] = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
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
      if (source[other] === source[t]) continue;
      const n1 = normal(t), n2 = normal(other);
      if (n1[0] * n2[0] + n1[1] * n2[1] + n1[2] * n2[2] > SAME_PLANE) continue;
      out.push(p[va * np], p[va * np + 1], p[va * np + 2], p[vb * np], p[vb * np + 1], p[vb * np + 2]);
    }
  }
}
