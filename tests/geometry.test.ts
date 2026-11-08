import Module, { type ManifoldToplevel } from 'manifold-3d';
import { unzipSync, strFromU8 } from 'fflate';
import { beforeAll, describe, expect, it } from 'vitest';
import { booleanOp } from '../src/geometry/booleans';
import { bakeMesh, meshDataToManifold, type MeshData } from '../src/geometry/meshData';
import { createPrimitive } from '../src/geometry/primitives';
import { exportStl } from '../src/io/stl';
import { export3mf } from '../src/io/threemf';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

/** Column-major translation matrix. */
const translate = (x: number, y: number, z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const IDENTITY = translate(0, 0, 0);

function volume(mesh: MeshData): number {
  const m = meshDataToManifold(wasm, mesh);
  try {
    return m.volume();
  } finally {
    m.delete();
  }
}

describe('primitives', () => {
  it('builds a watertight 40 mm cube', () => {
    const cube = createPrimitive(wasm, 'cube');
    expect(volume(cube)).toBeCloseTo(40 ** 3, 3);
    expect(cube.indices.length / 3).toBe(12);
  });

  it('builds a cylinder and sphere close to their true volumes', () => {
    // 64 segments: polygon area is ~0.16% below the circle's.
    const cylinder = volume(createPrimitive(wasm, 'cylinder')) / (Math.PI * 20 ** 2 * 40);
    expect(cylinder).toBeGreaterThan(0.998);
    expect(cylinder).toBeLessThanOrEqual(1);
    const sphere = volume(createPrimitive(wasm, 'sphere'));
    expect(sphere / ((4 / 3) * Math.PI * 20 ** 3)).toBeGreaterThan(0.98);
  });
});

describe('booleans', () => {
  const cube = () => createPrimitive(wasm, 'cube');

  it('merges two overlapping cubes', () => {
    // Offset by half a cube: overlap is 20 x 40 x 40.
    const r = booleanOp(wasm, 'union', [
      { mesh: cube(), matrix: IDENTITY },
      { mesh: cube(), matrix: translate(20, 0, 0) },
    ]);
    if (r.empty) throw new Error('unexpected empty');
    expect(r.volume).toBeCloseTo(2 * 64000 - 32000, 2);
    expect(r.center[0]).toBeCloseTo(10, 5);
  });

  it('subtracts the second object from the first', () => {
    const r = booleanOp(wasm, 'difference', [
      { mesh: cube(), matrix: IDENTITY },
      { mesh: cube(), matrix: translate(20, 0, 0) },
    ]);
    if (r.empty) throw new Error('unexpected empty');
    expect(r.volume).toBeCloseTo(32000, 2);
    expect(r.center[0]).toBeCloseTo(-10, 5);
  });

  it('intersects and reports empty when objects do not overlap', () => {
    const r = booleanOp(wasm, 'intersection', [
      { mesh: cube(), matrix: IDENTITY },
      { mesh: cube(), matrix: translate(20, 0, 0) },
    ]);
    if (r.empty) throw new Error('unexpected empty');
    expect(r.volume).toBeCloseTo(32000, 2);

    const apart = booleanOp(wasm, 'intersection', [
      { mesh: cube(), matrix: IDENTITY },
      { mesh: cube(), matrix: translate(100, 0, 0) },
    ]);
    expect(apart.empty).toBe(true);
  });

  it('produces a result that is itself a valid solid', () => {
    const r = booleanOp(wasm, 'difference', [
      { mesh: cube(), matrix: IDENTITY },
      { mesh: createPrimitive(wasm, 'sphere', 50), matrix: translate(0, 0, 20) },
    ]);
    if (r.empty) throw new Error('unexpected empty');
    expect(volume(r.mesh)).toBeCloseTo(r.volume, 3);
  });
});

describe('bakeMesh', () => {
  it('flips winding for a mirroring matrix so volume stays positive', () => {
    const mirrorX = [-1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    const baked = bakeMesh({ mesh: createPrimitive(wasm, 'cube'), matrix: mirrorX });
    expect(volume(baked)).toBeCloseTo(64000, 3);
  });
});

describe('export', () => {
  it('writes binary STL with the expected size and triangle count', () => {
    const buf = exportStl([
      { mesh: createPrimitive(wasm, 'cube'), matrix: IDENTITY },
      { mesh: createPrimitive(wasm, 'cube'), matrix: translate(50, 0, 0) },
    ]);
    expect(buf.byteLength).toBe(84 + 50 * 24);
    expect(new DataView(buf).getUint32(80, true)).toBe(24);
  });

  it('writes a 3MF package that reads back with matching geometry and colour', () => {
    const cube = createPrimitive(wasm, 'cube');
    const bytes = export3mf([
      { mesh: cube, matrix: translate(0, 0, 20), name: 'Cube <1>', color: '#3cb44b' },
    ]);
    const files = unzipSync(bytes);
    expect(Object.keys(files).sort()).toEqual(['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']);
    const xml = strFromU8(files['3D/3dmodel.model']);
    expect(xml).toContain('unit="millimeter"');
    expect(xml).toContain('displaycolor="#3CB44BFF"');
    expect(xml).toContain('name="Cube &#60;1&#62;"');
    expect(xml.match(/<vertex /g)?.length).toBe(cube.positions.length / 3);
    expect(xml.match(/<triangle /g)?.length).toBe(cube.indices.length / 3);
    // Translated by z=20: cube spans 0..40.
    const zs = [...xml.matchAll(/ z="([-\d.e]+)"/g)].map((m) => Number(m[1]));
    expect(Math.min(...zs)).toBeCloseTo(0, 5);
    expect(Math.max(...zs)).toBeCloseTo(40, 5);
  });
});
