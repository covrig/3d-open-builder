import * as THREE from 'three';

/** Edges meeting at more than this angle make a corner (a curved rim's small bends don't). */
const CORNER_DEG = 20;

export interface EdgeFeatures {
  /** Real corners, 3 numbers each: where sharp edges meet at a clear angle, or three or more meet */
  corners: Float32Array;
  /** Middles of straight edges running from corner to corner, 3 numbers each */
  mids: Float32Array;
}

/**
 * Snap targets on sharp edges (segments as EdgesGeometry gives them: x1 y1 z1
 * x2 y2 z2 each). Curved rims are stored as many short pieces with small
 * bends; their points are neither corners nor the middles of real edges.
 * Pieces continuing in a straight line (as booleans often leave an edge)
 * count as one edge, so its middle is the middle of the whole edge.
 */
export function edgeFeatures(segs: Float32Array): EdgeFeatures {
  const n = segs.length / 6;
  const point = (s: number, end: 0 | 1) => new THREE.Vector3(segs[s * 6 + end * 3], segs[s * 6 + end * 3 + 1], segs[s * 6 + end * 3 + 2]);
  // Rounded to 0.0001 mm; "+ 0" turns -0 into 0, so a point at -0.0000000001 matches one at 0.
  const r = (x: number) => Math.round(x * 1e4) / 1e4 + 0;
  const key = (v: THREE.Vector3) => `${r(v.x)},${r(v.y)},${r(v.z)}`;
  const at = new Map<string, number[]>();
  for (let s = 0; s < n; s++) {
    for (const end of [0, 1] as const) {
      const k = key(point(s, end));
      if (!at.has(k)) at.set(k, []);
      at.get(k)!.push(s);
    }
  }
  /** The other end of segment s, seen from point v */
  const otherEnd = (s: number, v: THREE.Vector3) => {
    const p = point(s, 0);
    return key(p) === key(v) ? point(s, 1) : p;
  };

  // A corner: an edge ends there, three or more meet, or the two that meet bend clearly.
  const cornerKeys = new Set<string>();
  const corners: number[] = [];
  for (const [k, list] of at) {
    const v = point(list[0], key(point(list[0], 0)) === k ? 0 : 1);
    let corner = list.length !== 2;
    if (!corner) {
      const u = otherEnd(list[0], v).sub(v).normalize();
      const w = otherEnd(list[1], v).sub(v).normalize();
      // Straight on: u and w point opposite ways. The bend is how far from that they are.
      corner = THREE.MathUtils.radToDeg(u.angleTo(w.clone().negate())) > CORNER_DEG;
    }
    if (corner) {
      cornerKeys.add(k);
      corners.push(v.x, v.y, v.z);
    }
  }

  const used = new Uint8Array(n);
  const mids: number[] = [];
  for (let s = 0; s < n; s++) {
    if (used[s]) continue;
    used[s] = 1;
    const a = point(s, 0), b = point(s, 1);
    const dir = b.clone().sub(a).normalize();
    // Walk on from one end while exactly one more piece continues straight on.
    const extend = (tip: THREE.Vector3): THREE.Vector3 => {
      for (;;) {
        const here = at.get(key(tip)) ?? [];
        if (here.length !== 2) return tip;
        const next = here.find((t) => !used[t]);
        if (next === undefined) return tip;
        const far = otherEnd(next, tip);
        if (far.clone().sub(tip).normalize().cross(dir).length() > 1e-3) return tip;
        used[next] = 1;
        tip = far;
      }
    };
    const end1 = extend(b), end0 = extend(a);
    // Only a real edge, from corner to corner, has a middle worth snapping to.
    if (cornerKeys.has(key(end0)) && cornerKeys.has(key(end1))) {
      mids.push((end0.x + end1.x) / 2, (end0.y + end1.y) / 2, (end0.z + end1.z) / 2);
    }
  }
  return { corners: new Float32Array(corners), mids: new Float32Array(mids) };
}
