import type { Box, Manifold } from 'manifold-3d';

const inside = (inner: Box, outer: Box, eps = 1e-6) =>
  [0, 1, 2].every((k) => inner.min[k] >= outer.min[k] - eps && inner.max[k] <= outer.max[k] + eps);

const largestFirst = (ms: Manifold[]) =>
  ms.map((m) => ({ m, v: m.volume() })).sort((a, b) => b.v - a.v).map((s) => s.m);

/**
 * The separate solid pieces of a manifold, largest first; the caller deletes them.
 *
 * Manifold's decompose() splits by surfaces, so a hollow inside a solid (a
 * sphere subtracted from inside a cube, the inside of a shelled object) comes
 * out as a "part" of its own: an inside-out surface with negative volume, and
 * the solid around it comes out filled. Here each piece keeps its hollows: it
 * is the whole result cut down to that piece's outer shape, minus any other
 * piece floating inside its hollow (which stays a piece of its own). An
 * inside-out surface with nothing around it is kept as it is (negative
 * volume), so callers can still tell a truly inside-out object.
 */
export function solidPieces(m: Manifold): Manifold[] {
  const parts = m.decompose();
  const sized = parts.map((p) => ({ p, volume: p.volume(), box: p.boundingBox() }));
  const solids = sized.filter((s) => s.volume > 0);
  const hollows = sized.filter((s) => s.volume <= 0);
  // No hollows (the usual case), or nothing solid around them: the parts are the pieces.
  if (hollows.length === 0 || solids.length === 0) return largestFirst(parts);
  const pieces: Manifold[] = solids.map((s) => {
    let piece = m.intersect(s.p);
    for (const inner of solids) {
      if (inner === s || inner.volume >= s.volume || !inside(inner.box, s.box)) continue;
      const next = piece.subtract(inner.p);
      piece.delete();
      piece = next;
    }
    return piece;
  });
  // Inside-out surfaces that aren't the hollow of any piece stay as they are.
  for (const h of hollows) {
    if (solids.some((s) => inside(h.box, s.box))) h.p.delete();
    else pieces.push(h.p);
  }
  for (const s of solids) s.p.delete();
  return largestFirst(pieces);
}
