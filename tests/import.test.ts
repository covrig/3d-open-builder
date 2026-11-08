// @vitest-environment happy-dom
// The 3MF loader parses XML with DOMParser, which happy-dom provides.
import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { meshDataToManifold } from '../src/geometry/meshData';
import { bounds } from '../src/geometry/meshOps';
import { createPrimitive } from '../src/geometry/primitives';
import { importFile } from '../src/io/importFile';
import { exportStl } from '../src/io/stl';
import { export3mf } from '../src/io/threemf';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const translate = (x: number, y: number, z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];

describe('importFile', () => {
  it('reads back our own 3MF: objects, positions and colours', async () => {
    const bytes = export3mf([
      { mesh: createPrimitive(wasm, 'cube'), matrix: translate(0, 0, 20), name: 'Cube 1', color: '#e03131' },
      { mesh: createPrimitive(wasm, 'sphere'), matrix: translate(60, 0, 20), name: 'Sphere 1', color: '#3b5bdb' },
    ]);
    const parts = await importFile(new File([bytes as Uint8Array<ArrayBuffer>], 'scene.3mf'));
    expect(parts).toHaveLength(2);
    expect(parts.map((p) => p.color)).toEqual(['#e03131', '#3b5bdb']);
    const cube = bounds(parts[0].data);
    expect(cube.min[2]).toBeCloseTo(0, 4);
    expect(cube.max[2]).toBeCloseTo(40, 4);
    expect(bounds(parts[1].data).min[0]).toBeCloseTo(40, 4);
  });

  it('welds STL triangles back into a closed solid', async () => {
    const stl = exportStl([{ mesh: createPrimitive(wasm, 'cylinder'), matrix: translate(0, 0, 0) }]);
    const [part] = await importFile(new File([stl], 'part.stl'));
    // STL stores 3 vertices per triangle; welding must share them again.
    expect(part.data.positions.length / 3).toBeLessThan(part.data.indices.length / 3);
    const m = meshDataToManifold(wasm, part.data);
    expect(m.status()).toBe('NoError');
    m.delete();
  });

  it('reads an OBJ file', async () => {
    const obj = [
      'o Tetra',
      'v 0 0 0', 'v 10 0 0', 'v 0 10 0', 'v 0 0 10',
      'f 1 3 2', 'f 1 2 4', 'f 1 4 3', 'f 2 3 4',
    ].join('\n');
    const [part] = await importFile(new File([obj], 'tetra.obj'));
    expect(part.data.indices.length).toBe(12);
    const m = meshDataToManifold(wasm, part.data);
    expect(m.volume()).toBeCloseTo(1000 / 6, 3);
    m.delete();
  });

  it('rejects unsupported files with a clear message', async () => {
    await expect(importFile(new File(['x'], 'model.step'))).rejects.toThrow(/Unsupported file type/);
  });
});
