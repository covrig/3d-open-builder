// @vitest-environment happy-dom
// File import fixes: OBJ colours, 3MF units, bad files, big hollows, names, plain error messages.
import { strToU8, zipSync } from 'fflate';
import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { friendlyError } from '../src/app/messages';
import { manifoldToMeshData } from '../src/geometry/meshData';
import { bounds } from '../src/geometry/meshOps';
import { createPrimitive } from '../src/geometry/primitives';
import { importFile, splitPieces, threeMfUnitScale } from '../src/io/importFile';
import { parseMeshFile } from '../src/io/meshParse';
import { exportStl } from '../src/io/stl';
import { build3mfModel, CONTENT_TYPES, RELS } from '../src/io/threemf';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];

function unitCube3mf(unit?: string): Uint8Array {
  const item = { mesh: createPrimitive(wasm, 'cube', { width: 1, depth: 1, height: 1 }), matrix: identity, name: 'Cube', color: '#e03131' };
  let model = build3mfModel([item]);
  if (unit) model = model.replace('unit="millimeter"', `unit="${unit}"`);
  return zipSync({
    '[Content_Types].xml': strToU8(CONTENT_TYPES),
    '_rels/.rels': strToU8(RELS),
    '3D/3dmodel.model': strToU8(model),
  });
}

describe('3MF unit', () => {
  it.each([
    ['millimeter', 1],
    ['inch', 25.4],
    ['meter', 1000],
    ['centimeter', 10],
    ['micron', 0.001],
    ['foot', 304.8],
  ])('%s scales the model to millimetres', async (unit, width) => {
    const bytes = unitCube3mf(unit);
    expect(threeMfUnitScale(bytes)).toBeCloseTo(width, 6);
    const [part] = await importFile(new File([bytes as Uint8Array<ArrayBuffer>], 'a.3mf'));
    const b = bounds(part.data);
    expect(b.max[0] - b.min[0]).toBeCloseTo(width, 4);
    expect(part.color).toBe('#e03131'); // colours still work
  });

  it('defaults to millimetres when the unit is missing or unknown', () => {
    expect(threeMfUnitScale(unitCube3mf('furlong'))).toBe(1);
    expect(threeMfUnitScale(zipSync({ 'readme.txt': strToU8('hi') }))).toBe(1);
  });
});

describe('OBJ colours', () => {
  it('leaves the colour unset so the palette is used', () => {
    const text = 'v 0 0 0\nv 1 0 0\nv 0 1 0\nv 0 0 1\nf 1 3 2\nf 1 2 4\nf 1 4 3\nf 2 3 4\n';
    const parts = parseMeshFile({ format: 'obj', text, name: 'tet' });
    expect(parts).toHaveLength(1);
    expect(parts[0].color).toBeUndefined();
  });
});

describe('bad files', () => {
  it('refuses an STL with a NaN coordinate', async () => {
    const stl = exportStl([{ mesh: createPrimitive(wasm, 'cube'), matrix: identity }]);
    new Uint8Array(stl).set([0x00, 0x00, 0xc0, 0x7f], 84 + 12); // the first vertex's x as a little-endian NaN
    await expect(importFile(new File([stl], 'bad.stl'))).rejects.toThrow(
      'This file contains invalid numbers (NaN or infinity) and cannot be opened.',
    );
  });

  it('refuses files with no triangles', async () => {
    await expect(importFile(new File(['v 0 0 0\nv 1 0 0\n'], 'empty.obj'))).rejects.toThrow('This file has no usable geometry.');
    const empty = new Uint8Array(84); // an STL header that says 0 triangles
    await expect(importFile(new File([empty], 'empty.stl'))).rejects.toThrow('This file has no usable geometry.');
  });
});

describe('splitPieces on a huge hollow', () => {
  it('does not overflow the call stack (about 245,000 triangles)', () => {
    const big = wasm.Manifold.cube([100, 100, 100], true).subtract(wasm.Manifold.sphere(20, 700));
    const data = manifoldToMeshData(big);
    big.delete();
    expect(data.indices.length / 3).toBeGreaterThan(200_000);
    expect(splitPieces(data)).toHaveLength(1);
  }, 60_000);
});

describe('3MF names', () => {
  it('drops characters XML cannot hold', () => {
    const item = { mesh: createPrimitive(wasm, 'cube'), matrix: identity, name: 'A\u0007B￾\ud800C', color: '#e03131' };
    const xml = build3mfModel([item]);
    expect(xml).toContain('name="ABC"');
    expect(xml).not.toMatch(/[\u0000-\u0008\u000B\u000C\u000E-\u001F￾]/);
    expect(xml).not.toContain('\ud800');
  });
});

describe('friendlyError', () => {
  it('maps raw messages to plain ones', () => {
    expect(friendlyError(new Error('Input is not a valid solid'))).toMatch(/not a closed solid/);
    expect(friendlyError(new Error('NotManifold'))).toMatch(/Check and Repair/);
    expect(friendlyError(new Error('Not manifold'))).toMatch(/Check and Repair/);
    for (const m of ['Offset is outside the bounds of the DataView', 'Invalid typed array length: 5', 'Cannot find relationship file', 'invalid zip data', 'unexpected EOF']) {
      expect(friendlyError(new Error(m))).toBe('This file is damaged or cut short and cannot be read.');
    }
    for (const m of ['Array buffer allocation failed', 'out of memory', 'Out of memory', 'memory access out of bounds', 'Cannot enlarge memory arrays']) {
      expect(friendlyError(new Error(m))).toBe('Not enough memory for this. Try a smaller or simpler model.');
    }
    expect(friendlyError(new RangeError('Maximum call stack size exceeded'))).toMatch(/too large/);
  });
  it('passes everything else through', () => {
    expect(friendlyError(new Error('Something else'))).toBe('Something else');
    expect(friendlyError('plain text')).toBe('plain text');
    expect(friendlyError(42)).toBe('42');
  });
});
