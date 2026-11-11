import { describe, expect, it } from 'vitest';
import { mirrorPlaneAt } from '../src/ui/mirrorDistance';

describe('mirror distance', () => {
  it('flips in place through the middle at distance 0', () => {
    expect(mirrorPlaneAt(2, 6, 0)).toBe(4);
  });

  it('leaves a gap of the distance on the positive side', () => {
    const plane = mirrorPlaneAt(2, 6, 10);
    expect(plane).toBe(11);
    // The mirrored box starts at 2 * plane - max, 10 beyond the original's max.
    expect(2 * plane - 6 - 6).toBe(10);
  });

  it('leaves a gap of the distance on the negative side', () => {
    const plane = mirrorPlaneAt(2, 6, -10);
    expect(plane).toBe(-3);
    // The mirrored box ends at 2 * plane - min, 10 below the original's min.
    expect(2 - (2 * plane - 2)).toBe(10);
  });
});
