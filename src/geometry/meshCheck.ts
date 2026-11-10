import type { MeshData } from './meshData';

/**
 * Mesh analysis and repair on plain triangle data. These work on any mesh,
 * including broken imports that Manifold refuses to load, which is exactly
 * when they are needed.
 */

/** Edge key for vertex indices below 2^26 (67 million), well within float precision. */
const edgeKey = (a: number, b: number) => (a < b ? a * 67108864 + b : b * 67108864 + a);

/**
 * Merge vertices closer than `eps` (mm) and drop triangles that collapse.
 * File formats like STL repeat each corner per triangle; neighbours only
 * become connected after welding.
 */
export function weld(mesh: MeshData, eps = 1e-4): MeshData {
  const p = mesh.positions;
  const map = new Map<string, number>();
  const remap = new Uint32Array(p.length / 3);
  const out: number[] = [];
  for (let i = 0; i < p.length / 3; i++) {
    const key = `${Math.round(p[i * 3] / eps)},${Math.round(p[i * 3 + 1] / eps)},${Math.round(p[i * 3 + 2] / eps)}`;
    let idx = map.get(key);
    if (idx === undefined) {
      idx = out.length / 3;
      map.set(key, idx);
      out.push(p[i * 3], p[i * 3 + 1], p[i * 3 + 2]);
    }
    remap[i] = idx;
  }
  const tris: number[] = [];
  const seen = new Set<string>();
  for (let t = 0; t < mesh.indices.length; t += 3) {
    const a = remap[mesh.indices[t]], b = remap[mesh.indices[t + 1]], c = remap[mesh.indices[t + 2]];
    if (a === b || b === c || a === c) continue; // collapsed
    // Exact duplicate triangles (same corners, either winding) are dropped too.
    const key = [a, b, c].sort((x, y) => x - y).join(',');
    if (seen.has(key)) continue;
    seen.add(key);
    tris.push(a, b, c);
  }
  return { positions: new Float32Array(out), indices: new Uint32Array(tris) };
}

/**
 * Weld as little as needed: the smallest distance (from 1 nm up to 1 µm)
 * that leaves no open or non-manifold edges, else the one that leaves the
 * fewest. Welding further than needed merges the corners of genuinely small
 * triangles (rounded edges have many) and tears the surface it should mend.
 */
export function gentleWeld(mesh: MeshData): { mesh: MeshData; report: MeshReport } {
  let best: { mesh: MeshData; report: MeshReport } | null = null;
  for (const eps of [1e-6, 1e-5, 1e-4, 1e-3]) {
    const welded = weld(mesh, eps);
    const report = analyze(welded);
    if (report.openEdges === 0 && report.nonManifoldEdges === 0) return { mesh: welded, report };
    const bad = report.openEdges + report.nonManifoldEdges;
    if (!best || bad < best.report.openEdges + best.report.nonManifoldEdges) best = { mesh: welded, report };
  }
  return best!;
}

/**
 * Number of separate pieces: groups of triangles connected through shared
 * vertices that enclose some volume. The inside surface of a hollow (a sphere
 * subtracted from inside a cube) faces inward, so its volume is negative and
 * it is part of the piece around it, not a piece of its own.
 */
export function countPieces(mesh: MeshData): number {
  const n = mesh.positions.length / 3;
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  const idx = mesh.indices;
  for (let t = 0; t < idx.length; t += 3) {
    const a = find(idx[t]);
    parent[find(idx[t + 1])] = a;
    parent[find(idx[t + 2])] = a;
  }
  // Signed volume of each connected surface (tetrahedra against the origin).
  const volume = new Map<number, number>();
  const p = mesh.positions;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const v = p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
    const root = find(idx[t]);
    volume.set(root, (volume.get(root) ?? 0) + v);
  }
  return [...volume.values()].filter((v) => v > 0).length;
}

export interface MeshReport {
  triangles: number;
  /** Edges used by only one triangle: holes / open surfaces */
  openEdges: number;
  /** Edges shared by three or more triangles */
  nonManifoldEdges: number;
  /** Edges whose two triangles disagree about which side is outside */
  flippedEdges: number;
  /** Signed volume (mm³); negative means the whole mesh is inside out */
  signedVolume: number;
}

/** Count edge problems and compute the signed volume (mesh should be welded first). */
export function analyze(mesh: MeshData): MeshReport {
  const idx = mesh.indices;
  const p = mesh.positions;
  // For each undirected edge: how many triangles use it, and the net direction.
  const count = new Map<number, number>();
  const direction = new Map<number, number>();
  let volume = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const v = [idx[t], idx[t + 1], idx[t + 2]];
    for (let k = 0; k < 3; k++) {
      const a = v[k], b = v[(k + 1) % 3];
      const key = edgeKey(a, b);
      count.set(key, (count.get(key) ?? 0) + 1);
      direction.set(key, (direction.get(key) ?? 0) + (a < b ? 1 : -1));
    }
    // Signed tetrahedron volume against the origin.
    const ax = p[v[0] * 3], ay = p[v[0] * 3 + 1], az = p[v[0] * 3 + 2];
    const bx = p[v[1] * 3], by = p[v[1] * 3 + 1], bz = p[v[1] * 3 + 2];
    const cx = p[v[2] * 3], cy = p[v[2] * 3 + 1], cz = p[v[2] * 3 + 2];
    volume += (ax * (by * cz - bz * cy) - ay * (bx * cz - bz * cx) + az * (bx * cy - by * cx)) / 6;
  }
  let open = 0, nonManifold = 0, flipped = 0;
  for (const [key, n] of count) {
    if (n === 1) open++;
    else if (n > 2) nonManifold++;
    else if (direction.get(key) !== 0) flipped++; // both triangles walk the edge the same way
  }
  return { triangles: idx.length / 3, openEdges: open, nonManifoldEdges: nonManifold, flippedEdges: flipped, signedVolume: volume };
}

/**
 * Make neighbouring triangles agree on which side is outside, then turn each
 * connected piece so its outside faces outward (positive volume).
 */
export function orient(mesh: MeshData): MeshData {
  const idx = mesh.indices.slice();
  const triCount = idx.length / 3;
  const edgeTris = new Map<number, number[]>();
  for (let t = 0; t < triCount; t++) {
    for (let k = 0; k < 3; k++) {
      const key = edgeKey(idx[t * 3 + k], idx[t * 3 + ((k + 1) % 3)]);
      const list = edgeTris.get(key);
      if (list) list.push(t);
      else edgeTris.set(key, [t]);
    }
  }
  /** True if triangle t walks a→b (in that order). */
  const walks = (t: number, a: number, b: number) => {
    for (let k = 0; k < 3; k++) if (idx[t * 3 + k] === a && idx[t * 3 + ((k + 1) % 3)] === b) return true;
    return false;
  };
  const flip = (t: number) => {
    const tmp = idx[t * 3 + 1];
    idx[t * 3 + 1] = idx[t * 3 + 2];
    idx[t * 3 + 2] = tmp;
  };
  const component = new Int32Array(triCount).fill(-1);
  let components = 0;
  for (let seed = 0; seed < triCount; seed++) {
    if (component[seed] >= 0) continue;
    const id = components++;
    component[seed] = id;
    const queue = [seed];
    while (queue.length) {
      const t = queue.pop()!;
      for (let k = 0; k < 3; k++) {
        const a = idx[t * 3 + k], b = idx[t * 3 + ((k + 1) % 3)];
        const list = edgeTris.get(edgeKey(a, b))!;
        if (list.length !== 2) continue; // only follow clean two-triangle edges
        const n = list[0] === t ? list[1] : list[0];
        if (component[n] >= 0) continue;
        // A consistent neighbour walks the shared edge the other way (b→a).
        if (walks(n, a, b)) flip(n);
        component[n] = id;
        queue.push(n);
      }
    }
  }
  // Turn inside-out pieces right way out.
  const vol = new Float64Array(components);
  const p = mesh.positions;
  for (let t = 0; t < triCount; t++) {
    const [a, b, c] = [idx[t * 3] * 3, idx[t * 3 + 1] * 3, idx[t * 3 + 2] * 3];
    vol[component[t]] +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  for (let t = 0; t < triCount; t++) if (vol[component[t]] < 0) flip(t);
  return { positions: mesh.positions, indices: idx };
}

/**
 * Close holes: follow each loop of open edges and fill it with a fan of
 * triangles around the loop's centre. Good for the small gaps typical of
 * broken exports; very large or twisted holes may need manual work.
 */
export function fillHoles(mesh: MeshData): { mesh: MeshData; holes: number } {
  const idx = mesh.indices;
  const directed = new Set<number>();
  // Directed half-edge a→b stored as a*2^26+b (a and b may be in either order).
  const half = (a: number, b: number) => a * 67108864 + b;
  for (let t = 0; t < idx.length; t += 3) {
    for (let k = 0; k < 3; k++) directed.add(half(idx[t + k], idx[t + ((k + 1) % 3)]));
  }
  // Open edges: a→b with no b→a. The hole is on the other side, walked b→a.
  const next = new Map<number, number>();
  for (let t = 0; t < idx.length; t += 3) {
    for (let k = 0; k < 3; k++) {
      const a = idx[t + k], b = idx[t + ((k + 1) % 3)];
      if (!directed.has(half(b, a))) next.set(b, a);
    }
  }
  const positions = Array.from(mesh.positions);
  const tris = Array.from(idx);
  let holes = 0;
  const visited = new Set<number>();
  for (const start of next.keys()) {
    if (visited.has(start)) continue;
    const loop: number[] = [];
    let v: number | undefined = start;
    while (v !== undefined && !visited.has(v)) {
      visited.add(v);
      loop.push(v);
      v = next.get(v);
    }
    if (v !== start || loop.length < 3) continue; // not a closed loop
    holes++;
    let cx = 0, cy = 0, cz = 0;
    for (const i of loop) {
      cx += positions[i * 3];
      cy += positions[i * 3 + 1];
      cz += positions[i * 3 + 2];
    }
    const c = positions.length / 3;
    positions.push(cx / loop.length, cy / loop.length, cz / loop.length);
    for (let i = 0; i < loop.length; i++) tris.push(loop[i], loop[(i + 1) % loop.length], c);
  }
  return { mesh: { positions: new Float32Array(positions), indices: new Uint32Array(tris) }, holes };
}
