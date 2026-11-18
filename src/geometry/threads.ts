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
 * The profile pushed outwards by `gap`, measured square to its surface (a disk of
 * radius `gap` rolled along it): the largest value of profileRadius(s + k) +
 * sqrt(gap² - k²) over |k| <= gap. Crests and roots move out by `gap`, the 60°
 * flanks by `gap` square to themselves (twice that radially), so a bolt turns in
 * the result with exactly `gap` of play everywhere. Moving the profile out
 * radially by `gap` instead leaves only gap / 2 on the flanks, where a thread jams.
 */
function offsetProfileRadius(s: number, P: number, major: number, gap: number): number {
  const n = 64;
  let best = -Infinity;
  for (let i = -n; i <= n; i++) {
    const k = (i / n) * gap;
    best = Math.max(best, profileRadius(s + k, P, major) + Math.sqrt(Math.max(0, gap * gap - k * k)));
  }
  return best;
}

/**
 * The profile pushed inwards by `gap`, measured square to its surface: the mirror of
 * offsetProfileRadius (a disk of radius `gap` rolled along the inside), the smallest value of
 * profileRadius(s + k) - sqrt(gap² - k²) over |k| <= gap. A bolt made this thin has `gap` of
 * play on every surface in a nut of the exact nominal size (a metal nut), where a bolt of the
 * exact size would have none and a printed bolt, always a little fat, would jam.
 */
function shrinkProfileRadius(s: number, P: number, major: number, gap: number): number {
  const n = 64;
  let best = Infinity;
  for (let i = -n; i <= n; i++) {
    const k = (i / n) * gap;
    best = Math.min(best, profileRadius(s + k, P, major) - Math.sqrt(Math.max(0, gap * gap - k * k)));
  }
  return best;
}

/**
 * A right-hand threaded cylinder from z = 0 to `length`. At every height the
 * cross-section is the same outline turned by the helix angle, so extruding
 * that outline with 360° of twist per pitch gives an exact helical thread.
 * `grow` is the clearance for nuts and tapped holes: the gap all round, flanks
 * included (see offsetProfileRadius). `shrink` makes an external thread thinner
 * by that much all round (see shrinkProfileRadius); 0 leaves the exact size.
 */
function threadSolid(wasm: ManifoldToplevel, d: number, P: number, length: number, grow: number, steps: number, shrink = 0): Manifold {
  const outline: [number, number][] = [];
  for (let i = 0; i < steps; i++) {
    const phi = (i / steps) * Math.PI * 2;
    const s = (phi / (Math.PI * 2)) * P;
    const r = grow > 0 ? offsetProfileRadius(s, P, d / 2, grow) : shrink > 0 ? shrinkProfileRadius(s, P, d / 2, shrink) : profileRadius(s, P, d / 2);
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

/** Shape of a bolt head. Hex is the ISO head from ISO_THREADS; the others are proportioned from the thread diameter d. */
export type BoltHead = 'hex' | 'round' | 'dome' | 'knurled' | 'countersunk';
/** The recess cut into the head's outer face for a screwdriver or key. */
export type BoltDrive = 'none' | 'slot' | 'phillips' | 'hex-socket';

const HEAD_SEGMENTS = 64;
/** Depth of the knurl ribs (mm) */
const RIB_DEPTH = 0.6;
/** The least material (mm) a recess leaves beside it, above it, and the shallowest recess worth cutting */
const RECESS_WALL = 0.5;
const RECESS_ROOF = 1;
const RECESS_MIN_DEPTH = 0.8;
const TOO_SMALL = 'The head is too small or too thin for this drive. Use a larger size, another head or no drive.';

/** Across-flats (mm) of the internal hex key for the metric sizes; imperial and the rest use 0.75 d. */
const HEX_KEY: Record<string, number> = { M2: 1.5, 'M2.5': 2, M3: 2.5, M4: 3, M5: 4, M6: 5, M8: 6, M10: 8, M12: 10, M16: 14, M20: 17 };
/** Corner radius of the internal hex socket: the key's across-flats plus 0.2 mm of play. */
function socketRadius(size: ThreadSize): number {
  return ((HEX_KEY[size] ?? 0.75 * ISO_THREADS[size].d) + 0.2) / Math.sqrt(3);
}

/**
 * Size of a head built on the plate (outer face z = 0, thread on the top face z = h):
 * its height, its nominal diameter, the radius it surely fills at height z (where a recess must
 * stay inside) and the radius of a plain cylinder that lies inside it at every height.
 */
function headDims(size: ThreadSize, head: BoltHead): { h: number; dia: number; radiusAt: (z: number) => number; inner: number } {
  const t = ISO_THREADS[size];
  const d = t.d;
  switch (head) {
    case 'hex':
      return { h: t.k, dia: t.af, radiusAt: () => t.af / 2, inner: t.af / 2 };
    case 'round':
      return { h: d, dia: 1.5 * d, radiusAt: () => 0.75 * d, inner: 0.75 * d };
    case 'dome': {
      const h = 0.55 * d, R = 0.875 * d, rf = 0.6 * d;
      return { h, dia: 2 * R, radiusAt: (z) => R - (R - rf) * (1 - z / h) ** 2, inner: rf };
    }
    case 'knurled':
      return { h: 0.8 * d, dia: 2 * d, radiusAt: () => d - RIB_DEPTH, inner: d - RIB_DEPTH };
    case 'countersunk':
      // 90° cone: the radius shrinks by 1 mm per mm of height, from d down to d / 2 under the thread.
      return { h: d / 2, dia: 2 * d, radiusAt: (z) => d - z, inner: d / 2 };
  }
}

/** How deep (mm) a drive's recess goes, or an error when it does not fit the head. */
function driveDepth(size: ThreadSize, head: BoltHead, drive: BoltDrive): number {
  const d = ISO_THREADS[size].d;
  const { h, dia, radiusAt } = headDims(size, head);
  const room = h - RECESS_ROOF; // the deepest a recess may go, leaving a roof of material
  let depth: number, reach: number; // reach: how far from the axis the recess extends
  switch (drive) {
    case 'slot':
      depth = Math.min(Math.max(0.3 * h, 0.8), room);
      reach = Math.max(0.8, 0.2 * d) / 2;
      break;
    case 'hex-socket':
      depth = Math.min(0.5 * d, room);
      reach = socketRadius(size);
      break;
    case 'phillips':
      depth = Math.min(0.45 * d, room);
      reach = 0.25 * dia;
      break;
    default:
      return 0;
  }
  // The recess must stay inside the head at the plate and at its bottom (the head is narrowest at one of them).
  const wall = Math.min(radiusAt(0), radiusAt(depth));
  if (depth < RECESS_MIN_DEPTH || reach + RECESS_WALL > wall) throw new Error(TOO_SMALL);
  return depth;
}

/** The solid to cut from a head (already tracked by `keep`): the recess from z = 0 up to `depth`, sticking out under the plate for a clean cut. */
function driveCutter(wasm: ManifoldToplevel, size: ThreadSize, head: BoltHead, drive: BoltDrive, depth: number, keep: <M extends Manifold>(m: M) => M): Manifold {
  const d = ISO_THREADS[size].d;
  const { h, dia } = headDims(size, head);
  const below = 1;
  const box = (x: number, y: number, z: number) => keep(keep(wasm.Manifold.cube([x, y, z], true)).translate([0, 0, z / 2 - below]));
  switch (drive) {
    case 'slot':
      // Across the whole head, through the middle.
      return box(2 * dia, Math.max(0.8, 0.2 * d), depth + below);
    case 'hex-socket': {
      const r = socketRadius(size);
      return keep(keep(wasm.Manifold.cylinder(depth + below, r, r, 6)).translate([0, 0, -below]));
    }
    case 'phillips': {
      const w = Math.max(0.8, 0.15 * d), span = 0.5 * dia;
      const wing = box(span, w, depth + below);
      const cross = box(w, span, depth + below);
      // A tapered centre, deeper than the wings (but under the roof), so a driver finds the middle:
      // 0.9 w across at the plate, narrowing upwards, so there is no flat roof to print.
      const tip = Math.min(depth + 0.25 * d, h - RECESS_ROOF);
      const rb = 0.9 * w, slope = (rb - 0.1) / tip;
      const cone = keep(wasm.Manifold.cylinder(tip + below, rb + slope * below, 0.1, 16)).translate([0, 0, -below]);
      return keep(keep(wing.add(cross)).add(cone));
    }
    default:
      throw new Error('No drive');
  }
}

/** A cylinder with straight vertical ribs round its edge: outer radius r, rib depth RIB_DEPTH, count from the circumference. */
function knurledCylinder(wasm: ManifoldToplevel, r: number, height: number): Manifold {
  // About 2 mm of circumference per rib (so the outer flat of a rib, 0.4 of that, is 0.8 mm), at least 16.
  const n = Math.max(16, Math.floor((2 * Math.PI * r) / 2));
  const root = r - RIB_DEPTH;
  const step = (Math.PI * 2) / n;
  const outline: [number, number][] = [];
  // Per rib: root flat, flank up, outer flat (0.4 of the pitch), flank down.
  for (let i = 0; i < n; i++) {
    for (const [f, rad] of [[0.1, root], [0.25, r], [0.65, r], [0.8, root]] as const) {
      const a = (i + f) * step;
      outline.push([rad * Math.cos(a), rad * Math.sin(a)]);
    }
  }
  return wasm.Manifold.extrude(outline, height);
}

/** The head of a bolt from z = 0 to its height, recess cut but no thread yet. */
function boltHead(wasm: ManifoldToplevel, size: ThreadSize, head: BoltHead, drive: BoltDrive, keep: <M extends Manifold>(m: M) => M): { solid: Manifold; h: number } {
  const t = ISO_THREADS[size];
  const d = t.d;
  const { h, radiusAt } = headDims(size, head);
  let solid: Manifold;
  switch (head) {
    case 'hex':
      solid = keep(hexPrism(wasm, t.af, t.k));
      break;
    case 'round':
      solid = keep(wasm.Manifold.cylinder(h, 0.75 * d, 0.75 * d, HEAD_SEGMENTS));
      break;
    case 'dome': {
      // A parabola, r(z) = R - (R - rf)(1 - z/h)², is 45° at the flat foot and level at the top,
      // so nothing on the outside overhangs more than 45° when the head prints on the plate.
      const steps = 12;
      const prof: [number, number][] = [[0, 0]];
      for (let i = 0; i <= steps; i++) prof.push([radiusAt((i / steps) * h), (i / steps) * h]);
      prof.push([0, h]);
      const section = new wasm.CrossSection([prof], 'NonZero');
      try {
        solid = keep(wasm.Manifold.revolve(section, HEAD_SEGMENTS));
      } finally {
        section.delete();
      }
      break;
    }
    case 'knurled':
      solid = keep(knurledCylinder(wasm, d, h));
      break;
    case 'countersunk':
      solid = keep(wasm.Manifold.cylinder(h, d, d / 2, HEAD_SEGMENTS));
      break;
  }
  if (drive !== 'none') {
    const depth = driveDepth(size, head, drive); // throws when it does not fit
    solid = keep(solid.subtract(driveCutter(wasm, size, head, drive, depth, keep)));
  }
  return { solid, h };
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
  /** How much thinner an external thread (bolt, rod) was made, all round (mm); absent or 0 = the exact size */
  allowance?: number;
  /** Bolt head shape; absent = hex */
  head?: BoltHead;
  /** Recess cut in a bolt head; absent = none */
  drive?: BoltDrive;
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
  // A thread made thinner (allowance) has its root that much deeper.
  const root = t.d / 2 - 0.625 * 0.8660254 * t.P - (info.allowance ?? 0);
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
        const kind = info.head ?? 'hex', drive = info.drive ?? 'none';
        const { h, inner } = headDims(info.size, kind);
        // With a drive, start above the recess (plus a margin), so the stand-in never reaches into it.
        const z0 = drive === 'none' ? 0 : driveDepth(info.size, kind, drive) + 0.2;
        // Hex keeps its own prism; the other heads get a plain cylinder a little inside them (ribs, curves, cone).
        const head0 = keep(kind === 'hex' ? hexPrism(wasm, t.af, h - z0) : wasm.Manifold.cylinder(h - z0, inner - 0.05, inner - 0.05, segs));
        const head = z0 === 0 ? head0 : keep(head0.translate([0, 0, z0]));
        const shaft = keep(keep(wasm.Manifold.cylinder(info.length + 0.1, root, root, segs)).translate([0, 0, h - 0.1]));
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
 * round so a printed or bought bolt actually fits. External threads (bolt, rod)
 * can be made `allowance` (mm) thinner all round, so a printed bolt fits a metal nut.
 */
export function makeThreaded(
  wasm: ManifoldToplevel,
  o: { kind: ThreadKind; size: ThreadSize; length: number; clearance: number; allowance?: number; head?: BoltHead; drive?: BoltDrive; quality?: ThreadQuality },
): Piece {
  const t = ISO_THREADS[o.size];
  const steps = THREAD_STEPS[o.quality ?? 'normal'];
  const owned: Manifold[] = [];
  const keep = <M extends Manifold>(m: M) => (owned.push(m), m);
  try {
    let shape: Manifold;
    switch (o.kind) {
      case 'rod':
        shape = keep(threadSolid(wasm, t.d, t.P, o.length, 0, steps, o.allowance ?? 0));
        break;
      case 'bolt': {
        // Head at the bottom (hex unless asked otherwise), thread standing on it (slightly sunk in so they fuse).
        const { solid: head, h } = boltHead(wasm, o.size, o.head ?? 'hex', o.drive ?? 'none', keep);
        const thread = keep(keep(threadSolid(wasm, t.d, t.P, o.length + 0.1, 0, steps, o.allowance ?? 0)).translate([0, 0, h - 0.1]));
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
