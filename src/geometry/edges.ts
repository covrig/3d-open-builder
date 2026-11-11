import { weld } from './meshCheck';
import { bakeMesh, matrixKey, type MeshData, type PlacedMesh } from './meshData';

export type V3 = [number, number, number];

/** A sharp edge between two faces, with what's needed to build a chamfer, fillet or gusset on it. */
export interface EdgeSegment {
  a: V3;
  b: V3;
  /** Outward normals of the two faces */
  n1: V3;
  n2: V3;
  /**
   * The corner of each face's triangle that is not on the edge. It is always
   * clearly to one side of the edge, which tells which way each face runs
   * (a triangle's centre can lie almost on the edge for long thin triangles).
   */
  c1: V3;
  c2: V3;
  /** Outside edge (material removed by a chamfer) vs inside corner (material added) */
  convex: boolean;
}

export interface EdgeSet {
  segments: EdgeSegment[];
  /** Runs of segments that continue smoothly (a cube edge, a cylinder rim) */
  chains: number[][];
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => {
  const l = Math.hypot(a[0], a[1], a[2]) || 1;
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * Sharp edges of a (world-space) mesh: edges where the two faces meet at more
 * than `minAngle` degrees, grouped into chains for picking.
 */
export function findEdges(mesh: MeshData, minAngle = 30): EdgeSet {
  const m = weld(mesh);
  const p = m.positions;
  const idx = m.indices;
  const pt = (i: number): V3 => [p[i * 3], p[i * 3 + 1], p[i * 3 + 2]];
  const normals: V3[] = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = pt(idx[t]), b = pt(idx[t + 1]), c = pt(idx[t + 2]);
    normals.push(norm(cross(sub(b, a), sub(c, a))));
  }
  /** Corner of triangle t that is not u or v. */
  const opposite = (t: number, u: number, v: number): V3 => {
    for (let k = 0; k < 3; k++) {
      const i = idx[t * 3 + k];
      if (i !== u && i !== v) return pt(i);
    }
    return pt(idx[t * 3]);
  };
  const edgeTris = new Map<number, number[]>();
  for (let t = 0; t < idx.length / 3; t++) {
    for (let k = 0; k < 3; k++) {
      const u = idx[t * 3 + k], v = idx[t * 3 + ((k + 1) % 3)];
      const key = u < v ? u * 67108864 + v : v * 67108864 + u;
      const list = edgeTris.get(key);
      if (list) list.push(t);
      else edgeTris.set(key, [t]);
    }
  }
  const cosLimit = Math.cos((minAngle * Math.PI) / 180);
  const segments: EdgeSegment[] = [];
  const ends: [number, number][] = [];
  for (const [key, tris] of edgeTris) {
    if (tris.length !== 2) continue;
    const [t1, t2] = tris;
    if (dot(normals[t1], normals[t2]) > cosLimit) continue; // nearly flat: not a feature edge
    const u = Math.floor(key / 67108864), v = key % 67108864;
    const o1 = opposite(t1, u, v), o2 = opposite(t2, u, v);
    segments.push({
      a: pt(u), b: pt(v),
      n1: normals[t1], n2: normals[t2],
      c1: o1, c2: o2,
      // Face 2 runs below face 1's plane: the edge sticks out.
      convex: dot(normals[t1], sub(o2, pt(u))) < 0,
    });
    ends.push([u, v]);
  }
  // Chains: join segments that meet at a vertex shared by exactly two sharp
  // segments and continue in nearly the same direction.
  const atVertex = new Map<number, number[]>();
  ends.forEach(([u, v], i) => {
    for (const w of [u, v]) {
      const list = atVertex.get(w);
      if (list) list.push(i);
      else atVertex.set(w, [i]);
    }
  });
  const parent = segments.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (const list of atVertex.values()) {
    if (list.length !== 2) continue;
    const [i, j] = list;
    const di = norm(sub(segments[i].b, segments[i].a));
    const dj = norm(sub(segments[j].b, segments[j].a));
    if (Math.abs(dot(di, dj)) > Math.cos((45 * Math.PI) / 180)) parent[find(i)] = find(j);
  }
  const groups = new Map<number, number[]>();
  segments.forEach((_, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(i);
    else groups.set(r, [i]);
  });
  return { segments, chains: [...groups.values()] };
}

/** Edge sets of recently opened objects by id and placement, oldest first. */
const edgeCache = new Map<string, EdgeSet>();
const EDGE_CACHE_SIZE = 6;

/** Sharp edges of an object as placed in the scene; the last few answers are remembered for meshes with an id. */
export function findEdgesPlaced(item: PlacedMesh, minAngle = 30): EdgeSet {
  const id = item.mesh.id;
  const key = id === undefined ? null : `${id}:${matrixKey(item.matrix)}:${minAngle}`;
  const known = key === null ? undefined : edgeCache.get(key);
  if (known) return known;
  const set = findEdges(bakeMesh(item), minAngle);
  if (key !== null) {
    edgeCache.set(key, set);
    if (edgeCache.size > EDGE_CACHE_SIZE) edgeCache.delete(edgeCache.keys().next().value!);
  }
  return set;
}

/** Directions across the two faces, pointing away from the edge, plus the edge direction. */
export function edgeFrame(s: EdgeSegment) {
  const u = norm(sub(s.b, s.a));
  let t1 = norm(cross(u, s.n1));
  if (dot(t1, sub(s.c1, s.a)) < 0) t1 = [-t1[0], -t1[1], -t1[2]];
  let t2 = norm(cross(u, s.n2));
  if (dot(t2, sub(s.c2, s.a)) < 0) t2 = [-t2[0], -t2[1], -t2[2]];
  const angle = Math.acos(Math.max(-1, Math.min(1, dot(t1, t2))));
  return { u, t1, t2, angle, length: Math.hypot(...sub(s.b, s.a)) };
}
