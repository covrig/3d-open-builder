import * as THREE from 'three';

/** Edges meeting at more than this angle make a corner (a curved rim's small bends don't). */
const CORNER_DEG = 20;
/** Edge ends closer than this (mm) are the same point. */
const SAME_POINT = 1e-5;

export interface EdgeFeatures {
  /** Real corners, 3 numbers each: where sharp edges meet at a clear angle, or three or more meet */
  corners: Float32Array;
  /** Middles of straight edges running from corner to corner, 3 numbers each */
  mids: Float32Array;
}

/**
 * Snap targets on sharp edges (segments as EdgesGeometry or a cut gives them:
 * x1 y1 z1 x2 y2 z2 each). Curved rims are stored as many short pieces with
 * small bends; their points are neither corners nor the middles of real
 * edges. Pieces continuing in a straight line (as booleans often leave an
 * edge) count as one edge, so its middle is the middle of the whole edge.
 *
 * End points are matched by distance, not by rounding (two points a hair
 * apart can round differently), and pieces of zero length or given twice are
 * ignored: either would make a point look like a meeting of three edges.
 * `sharp` (one flag per segment end, as a cut gives it) limits corners to
 * points on sharp mesh edges: a cut through a smooth but coarsely divided
 * surface (a sphere near its poles) bends at every mesh edge it crosses, yet
 * has no corners.
 */
export function edgeFeatures(segs: Float32Array, sharp?: Uint8Array): EdgeFeatures {
  // Unique points: a grid of SAME_POINT-sized cells, looking in the neighbouring cells too.
  const points: THREE.Vector3[] = [];
  const grid = new Map<string, number[]>();
  const cell = (v: number) => Math.floor(v / SAME_POINT);
  const idOf = (v: THREE.Vector3): number => {
    const [cx, cy, cz] = [cell(v.x), cell(v.y), cell(v.z)];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (let dz = -1; dz <= 1; dz++) {
      for (const id of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
        if (points[id].distanceTo(v) < SAME_POINT) return id;
      }
    }
    const k = `${cx},${cy},${cz}`;
    if (!grid.has(k)) grid.set(k, []);
    grid.get(k)!.push(points.length);
    points.push(v.clone());
    return points.length - 1;
  };

  // Edges as pairs of point ids, without zero-length or repeated ones.
  const edges: [number, number][] = [];
  const seen = new Set<string>();
  const onSharp: boolean[] = [];
  const v = new THREE.Vector3();
  for (let i = 0; i + 5 < segs.length; i += 6) {
    const a = idOf(v.set(segs[i], segs[i + 1], segs[i + 2]));
    const b = idOf(v.set(segs[i + 3], segs[i + 4], segs[i + 5]));
    if (sharp) {
      onSharp[a] ||= sharp[i / 3] === 1;
      onSharp[b] ||= sharp[i / 3 + 1] === 1;
    }
    const key = a < b ? `${a},${b}` : `${b},${a}`;
    if (a === b || seen.has(key)) continue;
    seen.add(key);
    edges.push([a, b]);
  }
  const at = points.map((): number[] => []);
  edges.forEach(([a, b], e) => {
    at[a].push(e);
    at[b].push(e);
  });
  const other = (e: number, p: number) => (edges[e][0] === p ? edges[e][1] : edges[e][0]);

  // A corner: an edge ends there, three or more meet, or the two that meet bend clearly.
  const isCorner = points.map((p, i) => {
    const list = at[i];
    if (list.length === 0 || (sharp && !onSharp[i])) return false;
    if (list.length !== 2) return true;
    const u = points[other(list[0], i)].clone().sub(p).normalize();
    const w = points[other(list[1], i)].clone().sub(p).normalize();
    // Straight on: u and w point opposite ways. The bend is how far from that they are.
    return THREE.MathUtils.radToDeg(u.angleTo(w.negate())) > CORNER_DEG;
  });
  const corners: number[] = [];
  points.forEach((p, i) => {
    if (isCorner[i]) corners.push(p.x, p.y, p.z);
  });

  // Straight edges: walk on from each end while exactly one more piece continues straight on.
  const used = new Uint8Array(edges.length);
  const mids: number[] = [];
  edges.forEach(([a, b], e) => {
    if (used[e]) return;
    used[e] = 1;
    const dir = points[b].clone().sub(points[a]).normalize();
    const extend = (tip: number): number => {
      for (;;) {
        if (at[tip].length !== 2) return tip;
        const next = at[tip].find((n) => !used[n]);
        if (next === undefined) return tip;
        const far = other(next, tip);
        if (points[far].clone().sub(points[tip]).normalize().cross(dir).length() > 1e-3) return tip;
        used[next] = 1;
        tip = far;
      }
    };
    const end1 = extend(b), end0 = extend(a);
    // Only a real edge, from corner to corner, has a middle worth snapping to.
    if (isCorner[end0] && isCorner[end1]) {
      const m = points[end0].clone().add(points[end1]).multiplyScalar(0.5);
      mids.push(m.x, m.y, m.z);
    }
  });
  return { corners: new Float32Array(corners), mids: new Float32Array(mids) };
}
