import { readFileSync } from 'node:fs';
import Module, { type Manifold, type ManifoldToplevel, type Mat4 } from 'manifold-3d';
import { parse } from 'opentype.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { textOnFace } from '../src/geometry/features';
import { meshDataToManifold, type MeshData } from '../src/geometry/meshData';
import { textOutlines } from '../src/geometry/text';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const meshOf = (m: Manifold): MeshData => {
  const g = m.getMesh();
  return { positions: g.vertProperties.slice(), indices: g.triVerts.slice() };
};
const volume = (mesh: MeshData) => {
  const m = meshDataToManifold(wasm, mesh);
  const v = m.volume();
  m.delete();
  return v;
};

describe('text lands on the clicked surface only', () => {
  const font = parse(readFileSync('public/fonts/Roboto-Bold.ttf').buffer as ArrayBuffer);
  const polygons = textOutlines(font, 'HELLO', 6);
  const top = (z: number): Mat4 => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, z, 1];

  // 40 x 20 x 12 box, top at z = 6.
  const solidBox = () => meshOf(wasm.Manifold.cube([40, 20, 12], true));
  // Same outside, 36 x 16 x 8 cavity: the cavity floor is 10 mm below the top, facing the same way.
  const hollowBox = () => meshOf(wasm.Manifold.cube([40, 20, 12], true).subtract(wasm.Manifold.cube([36, 16, 8], true)));
  // Two plates 40 x 20 x 2 at z = +5 and -5 joined by a post; the lower plate's top is 10 mm below the first.
  const table = () => meshOf(wasm.Manifold.cube([40, 20, 2], true).translate([0, 0, 5])
    .add(wasm.Manifold.cube([40, 20, 2], true).translate([0, 0, -5]))
    .add(wasm.Manifold.cube([2, 20, 12], true).translate([-19, 0, 0])));

  // One copy of HELLO at size 6 and depth 1 is 68.63 mm³ (measured on the plain box).
  const ONE_COPY = 68.63;

  for (const [name, make] of [['solid box', solidBox], ['hollow box', hollowBox], ['table', table]] as const) {
    for (const mode of ['emboss', 'deboss'] as const) {
      it(`${mode} on the top of a ${name} changes the volume by one copy of the letters`, () => {
        const mesh = make();
        const r = textOnFace(wasm, { mesh, matrix: IDENTITY }, { polygons, depth: 1, mode, frame: top(6) });
        const change = volume(r.mesh) - volume(mesh);
        expect(Math.abs(Math.abs(change) - ONE_COPY)).toBeLessThan(0.7);
        expect(mode === 'emboss' ? change > 0 : change < 0).toBe(true);
        // The coloured preview holds the same single copy.
        expect(Math.abs(volume(r.letters) - ONE_COPY)).toBeLessThan(0.7);
      });
    }
  }

  it('says so when the letters do not reach the clicked face', () => {
    // The click point is 24 mm above the box: no part of it lies within a depth of 1 mm.
    const mesh = solidBox();
    for (const mode of ['emboss', 'deboss'] as const) {
      expect(() => textOnFace(wasm, { mesh, matrix: IDENTITY }, { polygons, depth: 1, mode, frame: top(30) }))
        .toThrow(/does not reach this face/);
    }
  });
});
