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
 *
 * Points are compared by real distance, so two corners a hair apart merge
 * even when a grid line runs between them. Points are hashed into cells twice
 * as wide as `eps`: whatever lies within `eps` of a point is in its own cell or
 * in the one neighbour (per axis) on the side the point is nearer to.
 */
export function weld(mesh: MeshData, eps = 1e-4): MeshData {
  const p = mesh.positions;
  const count = p.length / 3;
  const cell = eps * 2;
  const eps2 = eps * eps;
  const remap = new Uint32Array(count);
  // Kept points; each cell (by hash) heads a chain of the kept points in it.
  // A hash clash only adds candidates: every candidate is checked by distance.
  const out: number[] = [];
  const next: number[] = [];
  const head = new Map<number, number>();
  const hash = (ix: number, iy: number, iz: number) =>
    Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791);
  /** First kept point within eps found in the chain of this cell, or -1. */
  const search = (h: number, x: number, y: number, z: number): number => {
    let k = head.get(h) ?? -1;
    while (k >= 0) {
      const dx = out[k * 3] - x, dy = out[k * 3 + 1] - y, dz = out[k * 3 + 2] - z;
      if (dx * dx + dy * dy + dz * dz <= eps2) return k;
      k = next[k];
    }
    return -1;
  };
  for (let i = 0; i < count; i++) {
    const x = p[i * 3], y = p[i * 3 + 1], z = p[i * 3 + 2];
    const fx = Math.floor(x / cell), fy = Math.floor(y / cell), fz = Math.floor(z / cell);
    const own = hash(fx, fy, fz);
    let found = search(own, x, y, z); // repeated corners nearly always sit in their own cell
    if (found < 0) {
      // The neighbour on the nearer side of each axis: all that can hold a point within eps.
      const sx = x / cell - fx < 0.5 ? -1 : 1, sy = y / cell - fy < 0.5 ? -1 : 1, sz = z / cell - fz < 0.5 ? -1 : 1;
      for (let m = 1; m < 8 && found < 0; m++) {
        found = search(hash(fx + (m & 1 ? sx : 0), fy + (m & 2 ? sy : 0), fz + (m & 4 ? sz : 0)), x, y, z);
      }
    }
    if (found < 0) {
      found = out.length / 3;
      out.push(x, y, z);
      next.push(head.get(own) ?? -1);
      head.set(own, found);
    }
    remap[i] = found;
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

/** One connected surface of a mesh: triangles joined through shared vertices. */
export interface Shell {
  /** Triangle numbers (the first corner of triangle t is at index 3 * t) */
  tris: Uint32Array;
  /** Signed volume (mm³): positive faces outward; negative is a hollow's inside or an inside-out part */
  volume: number;
  min: [number, number, number];
  max: [number, number, number];
}

/** The connected shells of a mesh (it is expected to be welded). */
export function shellsOf(mesh: MeshData): Shell[] {
  const idx = mesh.indices;
  const p = mesh.positions;
  const n = p.length / 3;
  const triCount = idx.length / 3;
  const parent = new Int32Array(n).map((_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]];
    return i;
  };
  for (let t = 0; t < idx.length; t += 3) {
    const a = find(idx[t]);
    parent[find(idx[t + 1])] = a;
    parent[find(idx[t + 2])] = a;
  }
  // Number the shells in order of their first triangle and count their triangles.
  const shellOfRoot = new Int32Array(n).fill(-1);
  const shellOfTri = new Int32Array(triCount);
  const counts: number[] = [];
  for (let t = 0; t < triCount; t++) {
    const root = find(idx[t * 3]);
    let s = shellOfRoot[root];
    if (s < 0) {
      s = counts.length;
      shellOfRoot[root] = s;
      counts.push(0);
    }
    shellOfTri[t] = s;
    counts[s]++;
  }
  const shells: Shell[] = counts.map((c) => ({
    tris: new Uint32Array(c),
    volume: 0,
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  }));
  const filled = new Uint32Array(counts.length);
  for (let t = 0; t < triCount; t++) {
    const s = shellOfTri[t];
    const sh = shells[s];
    sh.tris[filled[s]++] = t;
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    sh.volume += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
    for (const o of [a, b, c]) {
      for (let k = 0; k < 3; k++) {
        if (p[o + k] < sh.min[k]) sh.min[k] = p[o + k];
        if (p[o + k] > sh.max[k]) sh.max[k] = p[o + k];
      }
    }
  }
  return shells;
}

/** Ray directions for the inside test: not along any axis, and pointing different ways. */
const RAY_DIRECTIONS = ([[0.5377, 0.2912, 0.7914], [-0.3317, 0.8412, -0.4271], [0.2279, -0.5413, -0.8085]] as const).map(([x, y, z]) => {
  const len = Math.hypot(x, y, z);
  return [x / len, y / len, z / len] as const;
});

/** How many of the shell's triangles a ray from (ox, oy, oz) along (dx, dy, dz) crosses ahead of its start. */
function crossings(mesh: MeshData, tris: Uint32Array, ox: number, oy: number, oz: number, dx: number, dy: number, dz: number): number {
  const p = mesh.positions, idx = mesh.indices;
  let hits = 0;
  for (let i = 0; i < tris.length; i++) {
    const a = idx[tris[i] * 3] * 3, b = idx[tris[i] * 3 + 1] * 3, c = idx[tris[i] * 3 + 2] * 3;
    // Moeller-Trumbore
    const e1x = p[b] - p[a], e1y = p[b + 1] - p[a + 1], e1z = p[b + 2] - p[a + 2];
    const e2x = p[c] - p[a], e2y = p[c + 1] - p[a + 1], e2z = p[c + 2] - p[a + 2];
    const hx = dy * e2z - dz * e2y, hy = dz * e2x - dx * e2z, hz = dx * e2y - dy * e2x;
    const det = e1x * hx + e1y * hy + e1z * hz;
    if (Math.abs(det) < 1e-18) continue; // parallel to the ray
    const f = 1 / det;
    const sx = ox - p[a], sy = oy - p[a + 1], sz = oz - p[a + 2];
    const u = f * (sx * hx + sy * hy + sz * hz);
    if (u < 0 || u > 1) continue;
    const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
    const v = f * (dx * qx + dy * qy + dz * qz);
    if (v < 0 || u + v > 1) continue;
    if (f * (e2x * qx + e2y * qy + e2z * qz) > 1e-9) hits++;
  }
  return hits;
}

/** Is the point inside the shell? An odd number of crossings means inside. Three rays vote, so one grazing an edge cannot decide. */
function pointInShell(mesh: MeshData, shell: Shell, x: number, y: number, z: number): boolean {
  let votes = 0;
  for (let r = 0; r < RAY_DIRECTIONS.length; r++) {
    const [dx, dy, dz] = RAY_DIRECTIONS[r];
    if (crossings(mesh, shell.tris, x, y, z, dx, dy, dz) % 2 === 1) votes++;
    if (r === 1 && votes !== 1) break; // the first two agree: the third cannot change the result
  }
  return votes >= 2;
}

/** Does shell `a` fully contain shell `b`? Shells that only partly overlap do not contain each other. */
function containsShell(mesh: MeshData, a: Shell, b: Shell): boolean {
  const eps = 1e-6;
  for (let k = 0; k < 3; k++) if (b.min[k] < a.min[k] - eps || b.max[k] > a.max[k] + eps) return false;
  const idx = mesh.indices, p = mesh.positions;
  const corners = b.tris.length * 3;
  const samples = Math.min(16, corners);
  for (let s = 0; s < samples; s++) {
    const c = Math.floor((s * corners) / samples); // evenly spread over the corner list
    const v = idx[b.tris[Math.floor(c / 3)] * 3 + (c % 3)] * 3;
    if (!pointInShell(mesh, a, p[v], p[v + 1], p[v + 2])) return false;
  }
  return true;
}

/**
 * How the shells sit inside each other. `depth` is the number of shells that
 * fully contain a shell; `parent` is the innermost of them (-1 for none).
 * Even depth is an outside surface; odd depth is a hollow (the inside of a
 * shelled object), and a part floating in a hollow is even again. It counts
 * ray crossings, so it does not depend on which way the faces point.
 */
export function nestShells(mesh: MeshData, shells: Shell[]): { depth: number[]; parent: number[] } {
  const containers: number[][] = shells.map(() => []);
  for (let b = 0; b < shells.length; b++) {
    for (let a = 0; a < shells.length; a++) {
      // A container always has the larger volume (this also keeps two identical shells from holding each other).
      if (a === b || Math.abs(shells[a].volume) <= Math.abs(shells[b].volume)) continue;
      if (containsShell(mesh, shells[a], shells[b])) containers[b].push(a);
    }
  }
  const depth = containers.map((c) => c.length);
  const parent = containers.map((c) => c.reduce((best, a) => (best < 0 || depth[a] > depth[best] ? a : best), -1));
  return { depth, parent };
}

/** A shell faces the right way when its volume sign matches its depth: positive when even, negative when odd. */
export const facesWrongWay = (volume: number, depth: number) => (depth % 2 === 0 ? volume <= 0 : volume >= 0);

/** True when some shell of the mesh faces the wrong way for where it sits (an inside-out part). */
export function hasInsideOutShell(mesh: MeshData): boolean {
  const shells = shellsOf(mesh);
  const { depth } = nestShells(mesh, shells);
  return shells.some((s, i) => facesWrongWay(s.volume, depth[i]));
}

/**
 * Number of separate pieces: the outside surfaces. The inside surface of a
 * hollow (a sphere subtracted from inside a cube) faces inward and is part of
 * the piece around it, not a piece of its own.
 */
export function countPieces(mesh: MeshData): number {
  const { depth } = nestShells(mesh, shellsOf(mesh));
  return depth.filter((d) => d % 2 === 0).length;
}

/**
 * Why a mesh cannot be checked or repaired at all, or null when it can: no
 * triangles, or a coordinate that is not a number.
 */
export function meshProblem(mesh: MeshData): string | null {
  if (mesh.indices.length === 0 || mesh.positions.length === 0) return 'This object has no usable surface (no triangles).';
  const p = mesh.positions;
  for (let i = 0; i < p.length; i++) {
    if (!Number.isFinite(p[i])) return 'This object contains invalid numbers (NaN or infinity); it cannot be checked or repaired. Import it again from the original file.';
  }
  return null;
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
 * connected piece to face the way its place calls for: outward (positive
 * volume) for an outside surface, inward (negative) for the inside of a hollow.
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
  // How deep each piece sits: even is an outside surface, odd the inside of a hollow.
  const consistent: MeshData = { positions: mesh.positions, indices: idx };
  const shells = shellsOf(consistent);
  const { depth } = nestShells(consistent, shells);
  const depthOfComponent = new Int32Array(components);
  shells.forEach((sh, i) => { for (let k = 0; k < sh.tris.length; k++) depthOfComponent[component[sh.tris[k]]] = depth[i]; });
  // Turn pieces that face the wrong way.
  const vol = new Float64Array(components);
  const p = mesh.positions;
  for (let t = 0; t < triCount; t++) {
    const [a, b, c] = [idx[t * 3] * 3, idx[t * 3 + 1] * 3, idx[t * 3 + 2] * 3];
    vol[component[t]] +=
      p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1]) -
      p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c]) +
      p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c]);
  }
  for (let t = 0; t < triCount; t++) {
    const c = component[t];
    if (depthOfComponent[c] % 2 === 0 ? vol[c] < 0 : vol[c] > 0) flip(t);
  }
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
