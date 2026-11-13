/**
 * Cut stretches out of line segments: `chords` that lie on a segment (same
 * straight line, within `tol`) are removed from it, and what is left of the
 * segment is kept as one or two pieces. Used to take the parts of an object's
 * solid edge lines that run inside another object away, where dashes are
 * drawn instead. Both arrays hold 6 numbers per segment, in the same space.
 * Pieces start and end exactly at the original segment's ends or at the
 * chords' ends. Returns null when nothing was cut (the caller keeps `segs`).
 */
export function subtractChords(segs: ArrayLike<number>, chords: ArrayLike<number>, tol: number): Float32Array | null {
  const out: number[] = [];
  let cut = false;
  const nChords = chords.length / 6;
  for (let i = 0; i < segs.length; i += 6) {
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
      for (let c = 0; c < nChords; c++) {
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
