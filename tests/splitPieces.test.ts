// @vitest-environment happy-dom
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { MeshData } from '../src/geometry/meshData';
import { importFile, splitPieces } from '../src/io/importFile';

const volume = (m: MeshData) => {
  const p = m.positions, i = m.indices;
  let v = 0;
  for (let t = 0; t < i.length; t += 3) {
    const a = i[t] * 3, b = i[t + 1] * 3, c = i[t + 2] * 3;
    v += (p[a] * (p[b + 1] * p[c + 2] - p[b + 2] * p[c + 1])
      - p[a + 1] * (p[b] * p[c + 2] - p[b + 2] * p[c])
      + p[a + 2] * (p[b] * p[c + 1] - p[b + 1] * p[c])) / 6;
  }
  return v;
};

describe('splitPieces', () => {
  it('splits an STL with three separate parts into three pieces', async () => {
    const bytes = readFileSync('tests/data/three-parts.stl');
    const [part] = await importFile(new File([new Uint8Array(bytes)], 'test.stl'));
    const pieces = splitPieces(part.data);
    expect(pieces).toHaveLength(3);
    expect(pieces.reduce((n, m) => n + m.indices.length / 3, 0)).toBe(part.data.indices.length / 3);
    expect(pieces.every((m) => volume(m) > 0)).toBe(true);
    expect(pieces.reduce((s, m) => s + volume(m), 0)).toBeCloseTo(volume(part.data), 3);
  });

  it('leaves a single piece alone', () => {
    const tetra: MeshData = {
      positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]),
      indices: new Uint32Array([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]),
    };
    expect(splitPieces(tetra)).toEqual([tetra]);
  });
});
