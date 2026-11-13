import type { Manifold, ManifoldToplevel, Vec3 } from 'manifold-3d';
import { hasInsideOutShell, meshProblem } from './meshCheck';
import { bakeMesh, manifoldToMeshData, meshDataToManifold, type PlacedMesh } from './meshData';
import { triangleNormal } from './triangles';

/** wallRay: nothing was met within the reach */
const MISS = -1;
/** wallRay: something was met, but not a face looking back (not a wall) */
const NOT_A_WALL = -2;

/**
 * How far it is through the material from a point on the surface, straight in
 * along the normal, to the face on the other side (mm): the distance, MISS when
 * nothing is met within `reach`, NOT_A_WALL when the face met does not look back
 * at the start (a real wall has two facing sides: a slanted ray on a rounded rim
 * that meets the inner wall measures a chord, not a thickness).
 */
function wallRay(
  m: Manifold, px: number, py: number, pz: number, nx: number, ny: number, nz: number, reach: number,
): number {
  const start: Vec3 = [px - nx * 1e-3, py - ny * 1e-3, pz - nz * 1e-3];
  const end: Vec3 = [px - nx * reach, py - ny * reach, pz - nz * reach];
  const hit = m.rayCast(start, end).find((r) => r.distance > 1e-3);
  if (!hit) return MISS;
  const n = hit.normal;
  if (nx * n[0] + ny * n[1] + nz * n[2] > -0.85) return NOT_A_WALL;
  return Math.hypot(hit.position[0] - px, hit.position[1] - py, hit.position[2] - pz);
}

/** The wall thickness at a point (see wallRay), or null where there is no wall to measure. Used by the print check (random points). */
export function wallDistance(
  m: Manifold, px: number, py: number, pz: number, nx: number, ny: number, nz: number, reach: number,
): number | null {
  const d = wallRay(m, px, py, pz, nx, ny, nz, reach);
  return d >= 0 ? d : null;
}

/** Most triangles that get a measurement; a bigger mesh is sampled evenly (see measureThickness). */
export const MAX_THICKNESS_SAMPLES = 100_000;

/** How far the view looks for the far side of a wall: this times the larger of the minimum wall and 1.5 mm (a longer ray costs far more). */
export const REACH_FACTOR = 2;
export const MIN_REACH_BASE = 1.5;

/** How far a ray goes for this minimum wall: enough to colour every minimum wall up to REACH_FACTOR/1.5 times it exactly. */
export const thicknessReach = (minWall: number): number => REACH_FACTOR * Math.max(minWall, MIN_REACH_BASE);

export const NOT_CLOSED_MESSAGE =
  'This object is not a closed solid (it has holes, open surfaces or faces pointing the wrong way), so its walls cannot be measured. Use Check and repair first.';

export interface ThicknessResult {
  /**
   * Per triangle of the input mesh, in its order: thickness in mm, NaN where it
   * is not a wall. A wall whose far side is not met within `reach` is stored as
   * `reach` itself ("at least that thick").
   */
  thickness: Float32Array;
  /** Per triangle: area in mm² as placed in the scene (the weights for the summary). */
  areas: Float32Array;
  /** How far the rays looked (mm): colours are exact for every minimum wall up to reach / 1.5 */
  reach: number;
  /** True when the mesh had more triangles than the budget: only an even share was measured, the rest copy the nearest measured one. */
  sampled: boolean;
}

/**
 * Wall thickness at the centre of each triangle of a placed mesh: a ray goes
 * from the centre inward along the face normal to the first face it meets on
 * the other side (see wallRay), no further than thicknessReach(minWall). For a
 * hollow object that is the wall; a solid block (or any wall thicker than the
 * reach) comes out as the reach, "thick enough". Refuses what is not a closed solid.
 */
export function measureThickness(wasm: ManifoldToplevel, item: PlacedMesh, minWall: number): ThicknessResult {
  const world = bakeMesh(item);
  const problem = meshProblem(world);
  if (problem) throw new Error(problem);
  let solid: Manifold;
  try {
    solid = meshDataToManifold(wasm, item.mesh, item.matrix);
  } catch {
    throw new Error(NOT_CLOSED_MESSAGE);
  }
  try {
    if (hasInsideOutShell(manifoldToMeshData(solid))) throw new Error(NOT_CLOSED_MESSAGE);
    const p = world.positions;
    const idx = world.indices;
    const tris = idx.length / 3;
    const thickness = new Float32Array(tris).fill(NaN);
    const areas = new Float32Array(tris);
    const reach = thicknessReach(minWall);

    // Every stride-th triangle is measured: spread over the whole index order, which follows the surface.
    const stride = Math.max(1, Math.ceil(tris / MAX_THICKNESS_SAMPLES));
    const n3 = [0, 0, 0];
    for (let t = 0; t < tris; t++) {
      const a = idx[t * 3] * 3, b = idx[t * 3 + 1] * 3, c = idx[t * 3 + 2] * 3;
      triangleNormal(p, a, b, c, n3);
      const len = Math.hypot(n3[0], n3[1], n3[2]);
      areas[t] = len / 2;
      if (len === 0 || t % stride !== 0) continue;
      const d = wallRay(
        solid,
        (p[a] + p[b] + p[c]) / 3, (p[a + 1] + p[b + 1] + p[c + 1]) / 3, (p[a + 2] + p[b + 2] + p[c + 2]) / 3,
        n3[0] / len, n3[1] / len, n3[2] / len, reach,
      );
      if (d >= 0) thickness[t] = Math.min(d, reach);
      else if (d === MISS) thickness[t] = reach;
    }
    if (stride > 1) {
      for (let t = 0; t < tris; t++) if (t % stride !== 0 && areas[t] > 0) thickness[t] = thickness[t - (t % stride)];
    }
    return { thickness, areas, reach, sampled: stride > 1 };
  } finally {
    solid.delete();
  }
}

/** 0 = thinner than the minimum wall, 1 = under 1.5 times it, 2 = fine, 3 = not measured. */
export type ThicknessClass = 0 | 1 | 2 | 3;

export function thicknessClass(mm: number, minWall: number): ThicknessClass {
  if (!(mm >= 0)) return 3; // NaN or negative: nothing measured
  if (mm < minWall) return 0;
  if (mm < minWall * 1.5) return 1;
  return 2;
}

export interface ThicknessSummary {
  /** Thinnest wall measured (mm), or null when nothing was measured */
  thinnestMm: number | null;
  /** Share of the measured surface area thinner than the minimum wall, 0 to 100 */
  thinPercent: number;
  /** Share thinner than half of it, 0 to 100 */
  halfPercent: number;
  /** False when no triangle could be measured */
  measured: boolean;
}

/** Totals over one or more objects, from the stored thickness (cheap: runs again when the minimum wall changes). */
export function summarizeThickness(parts: { thickness: Float32Array; areas: Float32Array }[], minWall: number): ThicknessSummary {
  let total = 0, thin = 0, half = 0;
  let thinnest = Infinity;
  for (const { thickness, areas } of parts) {
    for (let t = 0; t < thickness.length; t++) {
      const d = thickness[t];
      if (!(d >= 0)) continue;
      total += areas[t];
      if (d < minWall) thin += areas[t];
      if (d < minWall / 2) half += areas[t];
      if (d < thinnest) thinnest = d;
    }
  }
  return {
    thinnestMm: Number.isFinite(thinnest) ? thinnest : null,
    thinPercent: total > 0 ? (thin / total) * 100 : 0,
    halfPercent: total > 0 ? (half / total) * 100 : 0,
    measured: total > 0,
  };
}
