import type { Manifold, ManifoldToplevel } from 'manifold-3d';
import type { Piece } from './cut';
import { manifoldToMeshData } from './meshData';
import { recenter } from './meshOps';

const IN = 25.4;

/**
 * Thread sizes, all in mm: nominal diameter d, pitch P, hex across-flats,
 * hex head height k and nut height m. Metric coarse (ISO 4017 / 4032) and
 * Unified coarse (UNC) imperial sizes; both use the same 60° thread form,
 * so only the numbers differ. Imperial pitch is 1 inch / threads per inch.
 */
export const ISO_THREADS = {
  M2: { d: 2, P: 0.4, af: 4, k: 1.4, m: 1.6 },
  'M2.5': { d: 2.5, P: 0.45, af: 5, k: 1.7, m: 2 },
  M3: { d: 3, P: 0.5, af: 5.5, k: 2, m: 2.4 },
  M4: { d: 4, P: 0.7, af: 7, k: 2.8, m: 3.2 },
  M5: { d: 5, P: 0.8, af: 8, k: 3.5, m: 4.7 },
  M6: { d: 6, P: 1, af: 10, k: 4, m: 5.2 },
  M8: { d: 8, P: 1.25, af: 13, k: 5.3, m: 6.8 },
  M10: { d: 10, P: 1.5, af: 16, k: 6.4, m: 8.4 },
  M12: { d: 12, P: 1.75, af: 18, k: 7.5, m: 10.8 },
  M16: { d: 16, P: 2, af: 24, k: 10, m: 14.8 },
  M20: { d: 20, P: 2.5, af: 30, k: 12.5, m: 18 },
  '#4-40': { d: 0.112 * IN, P: IN / 40, af: IN / 4, k: 2.0, m: 2.38 },
  '#6-32': { d: 0.138 * IN, P: IN / 32, af: (5 / 16) * IN, k: 2.4, m: 2.78 },
  '#8-32': { d: 0.164 * IN, P: IN / 32, af: (11 / 32) * IN, k: 2.9, m: 3.18 },
  '#10-24': { d: 0.19 * IN, P: IN / 24, af: (3 / 8) * IN, k: 3.4, m: 3.18 },
  '1/4-20': { d: IN / 4, P: IN / 20, af: (7 / 16) * IN, k: (5 / 32) * IN, m: (7 / 32) * IN },
  '5/16-18': { d: (5 / 16) * IN, P: IN / 18, af: IN / 2, k: (13 / 64) * IN, m: (17 / 64) * IN },
  '3/8-16': { d: (3 / 8) * IN, P: IN / 16, af: (9 / 16) * IN, k: (15 / 64) * IN, m: (21 / 64) * IN },
  '1/2-13': { d: IN / 2, P: IN / 13, af: (3 / 4) * IN, k: (5 / 16) * IN, m: (7 / 16) * IN },
} as const;

/** How a size is shown in menus and object names. */
export function threadLabel(size: ThreadSize): string {
  if (size.startsWith('M')) return size;
  const [major, tpi] = size.split('-');
  return major.startsWith('#') ? `${major}-${tpi} UNC` : `${major}″-${tpi} UNC`;
}
export type ThreadSize = keyof typeof ISO_THREADS;
export type ThreadKind = 'bolt' | 'nut' | 'rod' | 'tap';

/**
 * How finely a thread is drawn. The number is both the outline points per turn
 * and the twist steps per pitch; keeping the two equal means every twist step
 * turns the outline by exactly one point, so the surface follows the helix.
 */
export type ThreadQuality = 'draft' | 'normal' | 'fine';
export const THREAD_STEPS: Record<ThreadQuality, number> = { draft: 24, normal: 36, fine: 48 };

/**
 * Radius of the ISO basic thread profile at axial position s (0..P):
 * crest flat P/8, 60° flank, root flat P/4, flank back up. Depth is 5H/8,
 * with H = 0.866 P the height of the fundamental triangle.
 */
function profileRadius(s: number, P: number, major: number): number {
  const depth = 0.625 * 0.8660254 * P;
  const crest = P / 8, flank = 0.3125 * P, root = P / 4;
  const t = ((s % P) + P) % P;
  if (t < crest) return major;
  if (t < crest + flank) return major - depth * ((t - crest) / flank);
  if (t < crest + flank + root) return major - depth;
  return major - depth * (1 - (t - crest - flank - root) / flank);
}

/**
 * A right-hand threaded cylinder from z = 0 to `length`. At every height the
 * cross-section is the same outline turned by the helix angle, so extruding
 * that outline with 360° of twist per pitch gives an exact helical thread.
 * `grow` enlarges the profile (clearance for nuts and tapped holes).
 */
function threadSolid(wasm: ManifoldToplevel, d: number, P: number, length: number, grow: number, steps: number): Manifold {
  const major = d / 2 + grow;
  const outline: [number, number][] = [];
  for (let i = 0; i < steps; i++) {
    const phi = (i / steps) * Math.PI * 2;
    const r = profileRadius((phi / (Math.PI * 2)) * P, P, major);
    outline.push([r * Math.cos(phi), r * Math.sin(phi)]);
  }
  const turns = length / P;
  return wasm.Manifold.extrude(outline, length, Math.ceil(turns * steps), 360 * turns);
}

/** Regular hexagon prism with the given across-flats width, z = 0 to height. */
function hexPrism(wasm: ManifoldToplevel, af: number, height: number): Manifold {
  const r = af / Math.sqrt(3); // corner radius
  return wasm.Manifold.cylinder(height, r, r, 6);
}

/**
 * What a bolt, nut or rod was made from, kept on the object so tools can use
 * a plain stand-in for it. `origin` is the point of the built shape that sits
 * at the object's own origin (makeThreaded centres its result there).
 */
export interface ThreadInfo {
  kind: Exclude<ThreadKind, 'tap'>;
  size: ThreadSize;
  length: number;
  clearance: number;
  origin: [number, number, number];
}

/**
 * A plain solid lying entirely inside the threaded part: external threads
 * become a smooth cylinder at the thread root, internal threads (nuts) a
 * smooth hole at the thread's largest radius. Anything kept a wall's
 * thickness inside this stand-in is also that far inside the real part, so
 * Shell can hollow from it in a fraction of the time. Object coordinates.
 */
export function threadStandIn(wasm: ManifoldToplevel, info: ThreadInfo): Manifold {
  const t = ISO_THREADS[info.size];
  const root = t.d / 2 - 0.625 * 0.8660254 * t.P;
  const segs = 64;
  const owned: Manifold[] = [];
  const keep = <M extends Manifold>(m: M) => (owned.push(m), m);
  try {
    let shape: Manifold;
    switch (info.kind) {
      case 'rod':
        shape = keep(wasm.Manifold.cylinder(info.length, root, root, segs));
        break;
      case 'bolt': {
        const head = keep(hexPrism(wasm, t.af, t.k));
        const shaft = keep(keep(wasm.Manifold.cylinder(info.length + 0.1, root, root, segs)).translate([0, 0, t.k - 0.1]));
        shape = keep(head.add(shaft));
        break;
      }
      case 'nut': {
        // The nut's thread reaches out to d/2 + clearance; a plain hole that wide stays inside the material.
        const hole = keep(keep(wasm.Manifold.cylinder(t.m + 2, t.d / 2 + info.clearance, t.d / 2 + info.clearance, segs)).translate([0, 0, -1]));
        shape = keep(keep(hexPrism(wasm, t.af, t.m)).subtract(hole));
        break;
      }
    }
    const [x, y, z] = info.origin;
    return shape.translate([-x, -y, -z]);
  } finally {
    for (const m of owned) m.delete();
  }
}

/**
 * Bolts, nuts, threaded rods and thread cutters (subtract a cutter from a
 * part to make a tapped hole). Internal threads get `clearance` (mm) all
 * round so a printed or bought bolt actually fits.
 */
export function makeThreaded(
  wasm: ManifoldToplevel,
  o: { kind: ThreadKind; size: ThreadSize; length: number; clearance: number; quality?: ThreadQuality },
): Piece {
  const t = ISO_THREADS[o.size];
  const steps = THREAD_STEPS[o.quality ?? 'normal'];
  const owned: Manifold[] = [];
  const keep = <M extends Manifold>(m: M) => (owned.push(m), m);
  try {
    let shape: Manifold;
    switch (o.kind) {
      case 'rod':
        shape = keep(threadSolid(wasm, t.d, t.P, o.length, 0, steps));
        break;
      case 'bolt': {
        // Hex head at the bottom, thread standing on it (slightly sunk in so they fuse).
        const head = keep(hexPrism(wasm, t.af, t.k));
        const thread = keep(keep(threadSolid(wasm, t.d, t.P, o.length + 0.1, 0, steps)).translate([0, 0, t.k - 0.1]));
        shape = keep(head.add(thread));
        break;
      }
      case 'nut': {
        const body = keep(hexPrism(wasm, t.af, t.m));
        const tap = keep(keep(threadSolid(wasm, t.d, t.P, t.m + 2, o.clearance, steps)).translate([0, 0, -1]));
        shape = keep(body.subtract(tap));
        break;
      }
      case 'tap':
        shape = keep(threadSolid(wasm, t.d, t.P, o.length, o.clearance, steps));
        break;
    }
    const status = shape.status();
    if (status !== 'NoError') throw new Error(`Could not build the thread (${status})`);
    const { mesh, center } = recenter(manifoldToMeshData(shape));
    return { mesh, center };
  } finally {
    for (const m of owned) m.delete();
  }
}
