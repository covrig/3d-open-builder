import type { Manifold, ManifoldToplevel, Vec3 } from 'manifold-3d';
import { analyze, fillHoles, gentleWeld, orient, type MeshReport } from './meshCheck';
import { bakeMesh, manifoldToMeshData, meshDataToManifold, type MeshData, type PlacedMesh } from './meshData';
import { solidPieces } from './pieces';

export type CheckStatus = 'pass' | 'warn' | 'fail';
export interface CheckItem {
  id: 'watertight' | 'overlaps' | 'thickness' | 'normals' | 'manifold' | 'orientation';
  label: string;
  status: CheckStatus;
  detail: string;
  /** Repair can fix this automatically */
  fixable: boolean;
}

export interface CheckResult {
  items: CheckItem[];
  /** Outward normal that should face down for the suggested print orientation (world space). */
  suggestedDown: Vec3 | null;
}

/**
 * How well the object prints with `down` facing the plate: overhang area
 * (mm², faces leaning more than 45° that aren't on the plate), area resting
 * on the plate, and print height.
 */
function printStats(mesh: MeshData, down: Vec3): { area: number; contact: number; height: number } {
  const p = mesh.positions;
  const idx = mesh.indices;
  // Height along -down for each vertex; the plate is at the lowest one.
  const h = (i: number) => -(p[i * 3] * down[0] + p[i * 3 + 1] * down[1] + p[i * 3 + 2] * down[2]);
  let minH = Infinity, maxH = -Infinity;
  for (let i = 0; i < p.length / 3; i++) {
    const v = h(i);
    minH = Math.min(minH, v);
    maxH = Math.max(maxH, v);
  }
  let area = 0;
  let contact = 0;
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t] * 3, b = idx[t + 1] * 3, c = idx[t + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) continue;
    // Component of the face normal along "down" (1 = facing straight down).
    const facingDown = (nx * down[0] + ny * down[1] + nz * down[2]) / len;
    if (facingDown < Math.SQRT1_2) continue; // within 45° of vertical or facing up: prints fine
    const highest = Math.max(h(idx[t]), h(idx[t + 1]), h(idx[t + 2]));
    if (highest - minH < 0.2) {
      if (facingDown > 0.99) contact += len / 2; // flat on the plate
      continue;
    }
    area += len / 2;
  }
  return { area, contact, height: maxH - minH };
}

/** Lower is better: overhang costs, a broad base on the plate helps (stability, adhesion). */
const score = (s: { area: number; contact: number }) => s.area - 0.5 * s.contact;

/** Pick the orientation (among the largest flat faces and the six axis directions) with the least overhang. */
function suggestOrientation(wasm: ManifoldToplevel, world: MeshData) {
  const candidates: Vec3[] = [[0, 0, -1], [0, 0, 1], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
  const pts: Vec3[] = [];
  for (let i = 0; i < world.positions.length; i += 3) pts.push([world.positions[i], world.positions[i + 1], world.positions[i + 2]]);
  const hull = wasm.Manifold.hull(pts);
  const h = manifoldToMeshData(hull);
  hull.delete();
  const faces = new Map<string, { n: Vec3; area: number }>();
  for (let t = 0; t < h.indices.length; t += 3) {
    const a = h.indices[t] * 3, b = h.indices[t + 1] * 3, c = h.indices[t + 2] * 3;
    const p = h.positions;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const n: Vec3 = [uy * vz - uz * vy, uz * vx - ux * vz, ux * vy - uy * vx];
    const len = Math.hypot(...n);
    if (len === 0) continue;
    const unit: Vec3 = [n[0] / len, n[1] / len, n[2] / len];
    const key = unit.map((x) => Math.round(x * 1000)).join(',');
    const f = faces.get(key) ?? { n: unit, area: 0 };
    f.area += len / 2;
    faces.set(key, f);
  }
  candidates.push(...[...faces.values()].sort((a, b) => b.area - a.area).slice(0, 24).map((f) => f.n));
  const current = printStats(world, [0, 0, -1]);
  let best = { down: [0, 0, -1] as Vec3, ...current };
  for (const d of candidates) {
    const r = printStats(world, d);
    // Better score wins; with about the same score, prefer the lower print.
    const diff = score(r) - score(best);
    if (diff < -1 || (Math.abs(diff) <= 1 && r.height < best.height - 0.5)) best = { down: d, ...r };
  }
  return {
    down: best.down, area: best.area, currentArea: current.area,
    contact: best.contact, currentContact: current.contact,
    better: score(best) < score(current) - 1,
  };
}

/**
 * Walls thinner than `minWall`, by surface area. Points are sampled evenly over
 * the surface (not per triangle: rounded edges have many tiny ones) and a ray
 * goes inward along the normal. It only counts as a wall when the face it hits
 * looks back at the sample (a real wall has two facing sides); a slanted ray on
 * a rounded rim that meets the inner wall measures a chord, not a thickness.
 */
function wallThickness(m: Manifold, mesh: MeshData, minWall: number): { thinArea: number; halfArea: number; sampled: number; thinnest: number } {
  const p = mesh.positions;
  const idx = mesh.indices;
  const triCount = idx.length / 3;
  const normals = new Float32Array(triCount * 3);
  const cumulative = new Float64Array(triCount);
  let total = 0;
  for (let t = 0; t < triCount; t++) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len > 0) {
      normals[t * 3] = nx / len; normals[t * 3 + 1] = ny / len; normals[t * 3 + 2] = nz / len;
      total += len / 2;
    }
    cumulative[t] = total;
  }
  const SAMPLES = 3000;
  const reach = Math.max(minWall * 3, 1);
  let sampled = 0, thin = 0, half = 0, thinnest = Infinity;
  if (total <= 0) return { thinArea: 0, halfArea: 0, sampled, thinnest };
  let t = 0;
  for (let s = 0; s < SAMPLES; s++) {
    // Stratified along the cumulative area: one sample in each equal slice.
    const target = ((s + 0.5) / SAMPLES) * total;
    while (t < triCount - 1 && cumulative[t] < target) t++;
    const nx = normals[t * 3], ny = normals[t * 3 + 1], nz = normals[t * 3 + 2];
    if (nx === 0 && ny === 0 && nz === 0) continue;
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    // A random-ish point inside the triangle (fixed low-discrepancy values, so results repeat).
    let u = (s * 0.7548776662466927) % 1, w = (s * 0.5698402909980532) % 1;
    if (u + w > 1) { u = 1 - u; w = 1 - w; }
    const px = p[a] + u * (p[b] - p[a]) + w * (p[c] - p[a]);
    const py = p[a + 1] + u * (p[b + 1] - p[a + 1]) + w * (p[c + 1] - p[a + 1]);
    const pz = p[a + 2] + u * (p[b + 2] - p[a + 2]) + w * (p[c + 2] - p[a + 2]);
    sampled++;
    const start: Vec3 = [px - nx * 1e-3, py - ny * 1e-3, pz - nz * 1e-3];
    const end: Vec3 = [px - nx * reach, py - ny * reach, pz - nz * reach];
    const hit = m.rayCast(start, end).find((r) => r.distance > 1e-3);
    if (!hit) continue;
    const n = hit.normal;
    if (nx * n[0] + ny * n[1] + nz * n[2] > -0.85) continue;
    const d = Math.hypot(hit.position[0] - px, hit.position[1] - py, hit.position[2] - pz);
    thinnest = Math.min(thinnest, d);
    if (d < minWall) thin++;
    if (d < minWall / 2) half++;
  }
  return { thinArea: sampled ? thin / sampled : 0, halfArea: sampled ? half / sampled : 0, sampled, thinnest };
}

/** Full printability check of one object (geometry in world space). */
export function checkMesh(wasm: ManifoldToplevel, item: PlacedMesh, minWall: number): CheckResult {
  const world = bakeMesh(item);
  // A valid closed solid is judged as it is. Anything else is welded as little
  // as needed first: welding further merges the corners of genuinely small
  // triangles (rounded edges have many) and reports problems that aren't there.
  let solid = tryManifold(wasm, world);
  try {
    const welded = solid ? manifoldToMeshData(solid) : gentleWeld(world).mesh;
    solid ??= tryManifold(wasm, welded);
    const r: MeshReport = analyze(welded);
    const items: CheckItem[] = [];

    items.push(r.openEdges === 0
      ? { id: 'watertight', label: 'Watertight', status: 'pass', detail: 'No holes or open surfaces.', fixable: false }
      : { id: 'watertight', label: 'Watertight', status: 'fail', detail: `${r.openEdges} open edges: the surface has holes.`, fixable: true });
    items.push(r.nonManifoldEdges === 0
      ? { id: 'manifold', label: 'Non-manifold edges', status: 'pass', detail: 'Every edge joins exactly two faces.', fixable: false }
      : { id: 'manifold', label: 'Non-manifold edges', status: 'fail', detail: `${r.nonManifoldEdges} edges are shared by three or more faces.`, fixable: true });
    const inverted = r.signedVolume < 0;
    items.push(r.flippedEdges === 0 && !inverted
      ? { id: 'normals', label: 'Normals', status: 'pass', detail: 'All faces point outward.', fixable: false }
      : { id: 'normals', label: 'Normals', status: 'fail', detail: inverted ? 'The model is inside out.' : `${r.flippedEdges} edges join faces pointing opposite ways.`, fixable: true });

    // The remaining checks need a valid solid.
    if (!solid) {
      const skip = 'Repair the problems above first.';
      items.push({ id: 'overlaps', label: 'Overlapping parts', status: 'warn', detail: skip, fixable: false });
      items.push({ id: 'thickness', label: 'Wall thickness', status: 'warn', detail: skip, fixable: false });
    } else {
      // Separate pieces that overlap each other leave internal faces inside the print.
      // (A hollow belongs to its piece: a shelled object is one piece, not two overlapping ones.)
      const parts = solidPieces(solid);
      let overlapping = 0;
      try {
        for (let i = 0; i < parts.length; i++) {
          for (let j = i + 1; j < parts.length; j++) {
            const both = parts[i].intersect(parts[j]);
            try {
              if (both.volume() > 1e-6) overlapping++;
            } finally {
              both.delete();
            }
          }
        }
      } finally {
        for (const part of parts) part.delete();
      }
      items.push(overlapping === 0
        ? { id: 'overlaps', label: 'Overlapping parts', status: 'pass', detail: parts.length > 1 ? `${parts.length} separate parts, none overlapping.` : 'No overlapping internal faces.', fixable: false }
        : { id: 'overlaps', label: 'Overlapping parts', status: 'warn', detail: `${overlapping} pairs of parts overlap, leaving faces inside the model.`, fixable: true });

      const wall = wallThickness(solid, welded, minWall);
      const pct = (f: number) => (f > 0 && f < 0.01 ? '<1' : String(Math.round(f * 100)));
      const thinnest = Number.isFinite(wall.thinnest) ? ` (thinnest ${wall.thinnest.toFixed(2)} mm)` : '';
      items.push(wall.halfArea >= 0.02
        ? { id: 'thickness', label: 'Wall thickness', status: 'fail', detail: `About ${pct(wall.halfArea)}% of the surface is thinner than ${+(minWall / 2).toFixed(2)} mm: such thin parts may not print at all.`, fixable: false }
        : wall.thinArea >= 0.01
          ? { id: 'thickness', label: 'Wall thickness', status: 'warn', detail: `About ${pct(wall.thinArea)}% of the surface is thinner than ${minWall} mm${thinnest}: it prints, but with fewer lines and less strength.`, fixable: false }
          : { id: 'thickness', label: 'Wall thickness', status: 'pass', detail: `No significant area thinner than ${minWall} mm found${thinnest}.`, fixable: false });
    }

    let suggestedDown: Vec3 | null = null;
    try {
      const o = suggestOrientation(wasm, welded);
      if (!o.better) {
        items.push({ id: 'orientation', label: 'Print orientation', status: 'pass', detail: `Current orientation is good (${Math.round(o.currentArea)} mm² of overhang).`, fixable: false });
      } else {
        suggestedDown = o.down;
        const parts: string[] = [];
        if (o.area < o.currentArea - 1) parts.push(`cut overhangs from ${Math.round(o.currentArea)} to ${Math.round(o.area)} mm² (fewer supports)`);
        if (o.contact > o.currentContact + 1) parts.push(`rest it on ${Math.round(o.contact)} mm² instead of ${Math.round(o.currentContact)} mm² (sticks and stands better)`);
        items.push({ id: 'orientation', label: 'Print orientation', status: 'warn', detail: `Turning it would ${parts.join(' and ')}.`, fixable: false });
      }
    } catch {
      // Not critical.
    }
    return { items, suggestedDown };
  } finally {
    // Freed even if a check throws part-way.
    solid?.delete();
  }
}

/**
 * The mesh as a solid, or null if it isn't a valid closed one facing outward.
 * Manifold accepts inside-out pieces (negative volume), so those are checked here.
 */
function tryManifold(wasm: ManifoldToplevel, mesh: MeshData): Manifold | null {
  let solid: Manifold;
  try {
    solid = meshDataToManifold(wasm, mesh);
  } catch {
    return null;
  }
  // Each piece with its hollows: a hollow on its own is inside out, but a shelled object is fine.
  const parts = solidPieces(solid);
  const outward = parts.every((p) => p.volume() > 0);
  for (const p of parts) p.delete();
  if (outward) return solid;
  solid.delete();
  return null;
}

/**
 * Automatic repair. A mesh that already is a valid closed solid keeps its
 * surface exactly (only overlapping separate parts are merged). Anything else
 * is welded as little as needed, its faces turned outward and its holes
 * closed. When it still isn't a closed solid, the message says what is left.
 */
export function repairMesh(wasm: ManifoldToplevel, mesh: MeshData): { mesh: MeshData; actions: string[] } {
  const actions: string[] = [];
  let solid = tryManifold(wasm, mesh);
  if (!solid) {
    const before = analyze(mesh);
    const welded = gentleWeld(mesh);
    let m = welded.mesh;
    const dropped = before.triangles - welded.report.triangles;
    if (dropped > 0) actions.push(`Removed ${dropped} broken or duplicate triangle${dropped > 1 ? 's' : ''}`);
    if (welded.report.flippedEdges > 0 || welded.report.signedVolume < 0) {
      m = orient(m);
      actions.push('Turned faces to point outward');
    }
    const filled = fillHoles(m);
    if (filled.holes > 0) {
      m = filled.mesh;
      actions.push(`Closed ${filled.holes} hole${filled.holes > 1 ? 's' : ''}`);
    }
    solid = tryManifold(wasm, m);
    if (!solid) throw new Error(repairFailure(analyze(m), actions));
  }
  // Union of the separate pieces removes faces where pieces overlap.
  const parts = solidPieces(solid);
  if (parts.length > 1) {
    const merged = wasm.Manifold.union(parts);
    const before = solid.numTri();
    solid.delete();
    solid = merged;
    if (solid.numTri() !== before) actions.push('Merged overlapping parts');
  }
  for (const p of parts) p.delete();
  try {
    // Nothing to do: hand back the very same surface, not a rebuilt copy.
    if (actions.length === 0) return { mesh, actions: ['Nothing needed repairing'] };
    return { mesh: manifoldToMeshData(solid), actions };
  } finally {
    solid.delete();
  }
}

/** What is still wrong after an automatic repair, and what to do about it. */
function repairFailure(left: MeshReport, actions: string[]): string {
  const what: string[] = [];
  if (left.openEdges) what.push(`${left.openEdges} edges still border holes too large or twisted to fill`);
  if (left.nonManifoldEdges) what.push(`${left.nonManifoldEdges} edges are shared by more than two faces`);
  if (!what.length) what.push('the surface crosses itself');
  const did = actions.length ? ` Done so far: ${actions.join(', ').toLowerCase()}.` : '';
  return `Could not make this a closed solid automatically.${did} Left: ${what.join('; ')}. `
    + 'Fix those areas in the program that made the model, or export it from there again, then repair once more.';
}
