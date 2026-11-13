/** Time (ms) the cutting may take before it gives up and cuts nothing (the page must never freeze on a dense model). */
export const CLIP_BUDGET_MS = 50;
/** How many segments are cut between two looks at the clock. */
export const CLIP_CHECK_EVERY = 256;

/** A chord that touches more grid cells than this is kept in a short list checked for every segment. */
const MAX_CELLS_PER_CHORD = 64;
/** A segment that touches more grid cells than this is checked against every chord instead. */
const MAX_CELLS_PER_QUERY = 4096;
/** Cells per axis never exceed this (indices are clamped, the same way for chords and segments). */
const MAX_CELLS_PER_AXIS = 1024;

const clock = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

/**
 * Cut stretches out of line segments: `chords` that lie on a segment (same
 * straight line, within `tol`) are removed from it, and what is left of the
 * segment is kept as one or two pieces. Used to take the parts of an object's
 * solid edge lines that run inside another object away, where dashes are
 * drawn instead. Both arrays hold 6 numbers per segment, in the same space.
 * Pieces start and end exactly at the original segment's ends or at the
 * chords' ends. Returns null when nothing was cut (the caller keeps `segs`),
 * and also when `deadline` (a clock time in ms, performance.now() scale) has
 * passed before all segments were done: then nothing is cut at all.
 *
 * Every segment is only compared with the chords near it, found through a grid
 * over the chords' bounding boxes; the comparison itself is the exact one, so
 * the result does not depend on the grid.
 */
export function subtractChords(segs: ArrayLike<number>, chords: ArrayLike<number>, tol: number, deadline = Infinity): Float32Array | null {
  const out: number[] = [];
  let cut = false;
  const nChords = chords.length / 6;
  const index = nChords > 8 ? buildGrid(chords, nChords, tol) : null;
  const stamp = index ? new Int32Array(nChords) : null;
  const buffer: number[] = [];
  let candidates: number[] = buffer;
  let all: number[] | null = null; // every chord, for segments that cover too many cells
  let count = 0;
  for (let i = 0; i < segs.length; i += 6) {
    if (deadline !== Infinity && ++count % CLIP_CHECK_EVERY === 0 && clock() > deadline) return null;
    const ax = segs[i], ay = segs[i + 1], az = segs[i + 2];
    let dx = segs[i + 3] - ax, dy = segs[i + 4] - ay, dz = segs[i + 5] - az;
    const len = Math.hypot(dx, dy, dz);
    // Stretches to remove: [from, to] along the segment, with their points.
    const holes: { t0: number; t1: number; p0: number[]; p1: number[] }[] = [];
    if (len > tol) {
      dx /= len; dy /= len; dz /= len;
      /** Position along the segment of point (x, y, z), or null when it is off the line. */
      const along = (x: number, y: number, z: number): number | null => {
        const ux = x - ax, uy = y - ay, uz = z - az;
        const t = ux * dx + uy * dy + uz * dz;
        return Math.hypot(ux - t * dx, uy - t * dy, uz - t * dz) <= tol ? t : null;
      };
      if (index) {
        const found = index.near(segs, i, stamp!, i / 6 + 1, buffer);
        if (found) candidates = found;
        else {
          if (!all) { all = []; for (let c = 0; c < nChords; c++) all.push(c); }
          candidates = all;
        }
      }
      const n = index ? candidates.length : nChords;
      for (let k = 0; k < n; k++) {
        const c = index ? candidates[k] : k;
        const o = c * 6;
        let t0 = along(chords[o], chords[o + 1], chords[o + 2]);
        let t1 = along(chords[o + 3], chords[o + 4], chords[o + 5]);
        if (t0 === null || t1 === null) continue;
        let p0 = [chords[o], chords[o + 1], chords[o + 2]], p1 = [chords[o + 3], chords[o + 4], chords[o + 5]];
        if (t0 > t1) [t0, t1, p0, p1] = [t1, t0, p1, p0];
        // Only the part on the segment counts; an end within tol of the segment's end is its end.
        if (t1 <= tol || t0 >= len - tol) continue;
        if (t0 <= tol) { t0 = 0; p0 = [ax, ay, az]; }
        if (t1 >= len - tol) { t1 = len; p1 = [segs[i + 3], segs[i + 4], segs[i + 5]]; }
        if (t1 - t0 > tol) holes.push({ t0, t1, p0, p1 });
      }
    }
    if (!holes.length) {
      out.push(segs[i], segs[i + 1], segs[i + 2], segs[i + 3], segs[i + 4], segs[i + 5]);
      continue;
    }
    cut = true;
    holes.sort((a, b) => a.t0 - b.t0);
    // Walk along, keeping the stretches between holes.
    let at = 0, from = [ax, ay, az];
    for (const h of holes) {
      if (h.t0 - at > tol) out.push(from[0], from[1], from[2], h.p0[0], h.p0[1], h.p0[2]);
      if (h.t1 > at) { at = h.t1; from = h.p1; }
    }
    if (len - at > tol) out.push(from[0], from[1], from[2], segs[i + 3], segs[i + 4], segs[i + 5]);
  }
  return cut ? new Float32Array(out) : null;
}

interface Grid {
  /**
   * Chords whose box (grown by tol) meets the box of the segment at `segs[i]`,
   * in the order of the chords, written to `into`; null when the segment covers
   * too many cells (check every chord). `mark` is a unique number per call.
   */
  near(segs: ArrayLike<number>, i: number, stamp: Int32Array, mark: number, into: number[]): number[] | null;
}

/** A uniform grid over the chords' bounding boxes. A chord may be missed only if it cannot lie on the segment. */
function buildGrid(chords: ArrayLike<number>, nChords: number, tol: number): Grid {
  const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
  let sizeSum = 0;
  for (let c = 0; c < nChords; c++) {
    const o = c * 6;
    let size = 0;
    for (let k = 0; k < 3; k++) {
      const a = chords[o + k], b = chords[o + 3 + k];
      lo[k] = Math.min(lo[k], a, b);
      hi[k] = Math.max(hi[k], a, b);
      size = Math.max(size, Math.abs(a - b));
    }
    sizeSum += size;
  }
  const extent = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
  const cell = Math.max(8 * tol, 2 * (sizeSum / nChords), extent / 512);
  const index = (v: number, k: number): number =>
    Math.min(MAX_CELLS_PER_AXIS - 1, Math.max(0, Math.floor((v - lo[k]) / cell)));
  const key = (x: number, y: number, z: number): number => (z * MAX_CELLS_PER_AXIS + y) * MAX_CELLS_PER_AXIS + x;
  const cells = new Map<number, number[]>();
  const long: number[] = [];
  for (let c = 0; c < nChords; c++) {
    const o = c * 6;
    const a = [0, 0, 0], b = [0, 0, 0];
    for (let k = 0; k < 3; k++) {
      a[k] = index(Math.min(chords[o + k], chords[o + 3 + k]) - tol, k);
      b[k] = index(Math.max(chords[o + k], chords[o + 3 + k]) + tol, k);
    }
    if ((b[0] - a[0] + 1) * (b[1] - a[1] + 1) * (b[2] - a[2] + 1) > MAX_CELLS_PER_CHORD) { long.push(c); continue; }
    for (let z = a[2]; z <= b[2]; z++) for (let y = a[1]; y <= b[1]; y++) for (let x = a[0]; x <= b[0]; x++) {
      const kk = key(x, y, z);
      const list = cells.get(kk);
      if (list) list.push(c); else cells.set(kk, [c]);
    }
  }
  return {
    near(segs, i, stamp, mark, into) {
      const a = [0, 0, 0], b = [0, 0, 0];
      for (let k = 0; k < 3; k++) {
        const p = segs[i + k], q = segs[i + 3 + k];
        a[k] = index(Math.min(p, q) - tol, k);
        b[k] = index(Math.max(p, q) + tol, k);
      }
      if ((b[0] - a[0] + 1) * (b[1] - a[1] + 1) * (b[2] - a[2] + 1) > MAX_CELLS_PER_QUERY) return null;
      into.length = 0;
      for (const c of long) { stamp[c] = mark; into.push(c); }
      for (let z = a[2]; z <= b[2]; z++) for (let y = a[1]; y <= b[1]; y++) for (let x = a[0]; x <= b[0]; x++) {
        const list = cells.get(key(x, y, z));
        if (!list) continue;
        for (const c of list) if (stamp[c] !== mark) { stamp[c] = mark; into.push(c); }
      }
      into.sort((p, q) => p - q);
      return into;
    },
  };
}
