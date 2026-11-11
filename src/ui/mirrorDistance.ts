/**
 * Where the mirror plane sits along an axis for a unit spanning min..max.
 * Distance 0 flips in place through the unit's own middle. Otherwise the
 * mirrored result lands `distance` away from the original: the plane is at
 * max + d/2 (positive d) or min - |d|/2 (negative d), so the gap is |d|.
 */
export function mirrorPlaneAt(min: number, max: number, distance: number): number {
  if (!Number.isFinite(distance) || distance === 0) return (min + max) / 2;
  return distance > 0 ? max + distance / 2 : min - Math.abs(distance) / 2;
}
