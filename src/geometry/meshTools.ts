import type { Manifold, ManifoldToplevel, Vec3 } from 'manifold-3d';
import { analyze, fillHoles, orient, weld, type MeshReport } from './meshCheck';
import { bakeMesh, manifoldToMeshData, meshDataToManifold, type MeshData, type PlacedMesh } from './meshData';

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

/** Thinnest wall found by shooting rays inward from sampled faces. */
function wallThickness(m: Manifold, mesh: MeshData, minWall: number): { thin: number; sampled: number; thinnest: number } {
  const p = mesh.positions;
  const idx = mesh.indices;
  const triCount = idx.length / 3;
  const step = Math.max(1, Math.floor(triCount / 1500)); // sample at most ~1500 faces
  let thin = 0, sampled = 0, thinnest = Infinity;
  const reach = Math.max(minWall * 3, 1);
  for (let t = 0; t < triCount; t += step) {
    const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
    const ux = p[b] - p[a], uy = p[b + 1] - p[a + 1], uz = p[b + 2] - p[a + 2];
    const vx = p[c] - p[a], vy = p[c + 1] - p[a + 1], vz = p[c + 2] - p[a + 2];
    let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz);
    if (len === 0) continue;
    nx /= len; ny /= len; nz /= len;
    const cx = (p[a] + p[b] + p[c]) / 3, cy = (p[a + 1] + p[b + 1] + p[c + 1]) / 3, cz = (p[a + 2] + p[b + 2] + p[c + 2]) / 3;
    const start: Vec3 = [cx - nx * 1e-3, cy - ny * 1e-3, cz - nz * 1e-3];
    const end: Vec3 = [cx - nx * reach, cy - ny * reach, cz - nz * reach];
    const hit = m.rayCast(start, end).find((r) => r.distance > 1e-3);
    sampled++;
    if (!hit) continue;
    const d = hit.distance + 1e-3;
    thinnest = Math.min(thinnest, d);
    if (d < minWall) thin++;
  }
  return { thin, sampled, thinnest };
}

/** Full printability check of one object (geometry in world space). */
export function checkMesh(wasm: ManifoldToplevel, item: PlacedMesh, minWall: number): CheckResult {
  const world = bakeMesh(item);
  const welded = weld(world);
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
  let solid: Manifold | null = null;
  try {
    solid = meshDataToManifold(wasm, welded);
  } catch {
    solid = null;
  }
  if (!solid) {
    const skip = 'Repair the problems above first.';
    items.push({ id: 'overlaps', label: 'Overlapping parts', status: 'warn', detail: skip, fixable: false });
    items.push({ id: 'thickness', label: 'Wall thickness', status: 'warn', detail: skip, fixable: false });
  } else {
    // Separate shells that overlap each other leave internal faces inside the print.
    const parts = solid.decompose();
    let overlapping = 0;
    for (let i = 0; i < parts.length; i++) {
      for (let j = i + 1; j < parts.length; j++) {
        const both = parts[i].intersect(parts[j]);
        if (both.volume() > 1e-6) overlapping++;
        both.delete();
      }
    }
    for (const part of parts) part.delete();
    items.push(overlapping === 0
      ? { id: 'overlaps', label: 'Overlapping parts', status: 'pass', detail: parts.length > 1 ? `${parts.length} separate parts, none overlapping.` : 'No overlapping internal faces.', fixable: false }
      : { id: 'overlaps', label: 'Overlapping parts', status: 'warn', detail: `${overlapping} pairs of parts overlap, leaving faces inside the model.`, fixable: true });

    const wall = wallThickness(solid, welded, minWall);
    const pct = wall.sampled ? Math.round((wall.thin / wall.sampled) * 100) : 0;
    items.push(wall.thin === 0
      ? { id: 'thickness', label: 'Wall thickness', status: 'pass', detail: `No walls thinner than ${minWall} mm found${Number.isFinite(wall.thinnest) ? ` (thinnest ${wall.thinnest.toFixed(2)} mm)` : ''}.`, fixable: false }
      : { id: 'thickness', label: 'Wall thickness', status: pct > 10 ? 'fail' : 'warn', detail: `About ${pct}% of the surface is thinner than ${minWall} mm (thinnest ${wall.thinnest.toFixed(2)} mm). Make those walls thicker.`, fixable: false });
    solid.delete();
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
}

/** Automatic repair: weld, drop broken triangles, fix normals, close holes, merge overlapping parts. */
export function repairMesh(wasm: ManifoldToplevel, mesh: MeshData): { mesh: MeshData; actions: string[] } {
  const actions: string[] = [];
  const before = analyze(mesh);
  let m = weld(mesh);
  const welded = analyze(m);
  if (welded.triangles < before.triangles) actions.push(`Removed ${before.triangles - welded.triangles} broken or duplicate triangles`);
  if (welded.flippedEdges > 0 || welded.signedVolume < 0) {
    m = orient(m);
    actions.push('Turned faces to point outward');
  }
  const filled = fillHoles(m);
  if (filled.holes > 0) {
    m = filled.mesh;
    actions.push(`Closed ${filled.holes} hole${filled.holes > 1 ? 's' : ''}`);
  }
  let solid: Manifold;
  try {
    solid = meshDataToManifold(wasm, m);
  } catch {
    throw new Error(`Could not turn this into a closed solid automatically${actions.length ? ` (did: ${actions.join(', ').toLowerCase()})` : ''}.`);
  }
  // Union of the separate parts removes faces where parts overlap.
  const parts = solid.decompose();
  if (parts.length > 1) {
    const merged = wasm.Manifold.union(parts);
    const before = solid.numTri();
    solid.delete();
    solid = merged;
    if (solid.numTri() !== before) actions.push('Merged overlapping parts');
  }
  for (const p of parts) p.delete();
  try {
    if (actions.length === 0) actions.push('Nothing needed repairing');
    return { mesh: manifoldToMeshData(solid), actions };
  } finally {
    solid.delete();
  }
}
