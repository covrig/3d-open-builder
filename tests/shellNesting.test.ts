// @vitest-environment happy-dom
import Module, { type Manifold, type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { countPieces, hasInsideOutShell, nestShells, shellsOf } from '../src/geometry/meshCheck';
import { bakeMesh, manifoldToMeshData, meshDataToManifold, type MeshData } from '../src/geometry/meshData';
import { solidPieces } from '../src/geometry/pieces';
import { createPrimitive } from '../src/geometry/primitives';
import { splitPieces } from '../src/io/importFile';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const T = (x: number, y: number, z: number) => [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, y, z, 1];
const cube = (s = 40) => createPrimitive(wasm, 'cube', { width: s, depth: s, height: s });
const moved = (m: MeshData, x: number, y: number, z: number) => bakeMesh({ mesh: m, matrix: T(x, y, z) });
const concat = (...ms: MeshData[]): MeshData => {
  const positions = new Float32Array(ms.reduce((n, m) => n + m.positions.length, 0));
  const indices = new Uint32Array(ms.reduce((n, m) => n + m.indices.length, 0));
  let pv = 0, pi = 0;
  for (const m of ms) {
    positions.set(m.positions, pv);
    for (let i = 0; i < m.indices.length; i++) indices[pi + i] = m.indices[i] + pv / 3;
    pv += m.positions.length;
    pi += m.indices.length;
  }
  return { positions, indices };
};
const invert = (m: MeshData): MeshData => {
  const indices = m.indices.slice();
  for (let i = 0; i < indices.length; i += 3) [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
  return { positions: m.positions, indices };
};
/** Signed volume of a mesh (no Manifold needed). */
const signedVolume = (m: MeshData) => shellsOf(m).reduce((n, s) => n + s.volume, 0);
const lShape = () => manifoldToMeshData(wasm.Manifold.cube([40, 40, 40], true).subtract(wasm.Manifold.cube([20, 20, 50]).translate([0, 0, -25])));
const hollowCube = () => concat(cube(), invert(cube(20)));

describe('shell nesting', () => {
  it('a hollow cube is an outside surface with a cavity inside it', () => {
    const m = hollowCube();
    const shells = shellsOf(m);
    expect(shells.map((s) => s.volume.toFixed(1))).toEqual(['64000.0', '-8000.0']);
    const { depth, parent } = nestShells(m, shells);
    expect(depth).toEqual([0, 1]);
    expect(parent).toEqual([-1, 0]);
    expect(hasInsideOutShell(m)).toBe(false);
    expect(countPieces(m)).toBe(1);
  });

  it('a hollow box holding a floating hollow box nests four deep', () => {
    const big = wasm.Manifold.cube([40, 40, 40], true).subtract(wasm.Manifold.cube([30, 30, 30], true));
    const inner = wasm.Manifold.cube([10, 10, 10], true).subtract(wasm.Manifold.cube([4, 4, 4], true));
    const composed = wasm.Manifold.compose([big, inner]);
    const mesh = manifoldToMeshData(composed);
    const shells = shellsOf(mesh);
    const { depth, parent } = nestShells(mesh, shells);
    expect([...depth].sort()).toEqual([0, 1, 2, 3]);
    depth.forEach((d, i) => {
      if (d === 0) expect(parent[i]).toBe(-1);
      else expect(depth[parent[i]]).toBe(d - 1);
    });
    expect(countPieces(mesh)).toBe(2);
    const parts = solidPieces(composed);
    try {
      expect(parts.map((p) => p.volume().toFixed(1))).toEqual(['37000.0', '936.0']);
    } finally {
      for (const p of parts) p.delete();
    }
  });

  it('a cube in the notch of an L-shape is not inside it', () => {
    const m = concat(lShape(), moved(cube(5), 10, 10, 0));
    const { depth } = nestShells(m, shellsOf(m));
    expect(depth).toEqual([0, 0]);
    expect(countPieces(m)).toBe(2);
  });

  it('a cube that only partly overlaps another is not inside it', () => {
    // Its box is within the L's box, but some corners are in the L and some in the notch.
    const m = concat(lShape(), moved(cube(10), 2, 2, 0));
    const { depth } = nestShells(m, shellsOf(m));
    expect(depth).toEqual([0, 0]);
    const two = concat(cube(), moved(cube(), 20, 0, 0));
    expect(nestShells(two, shellsOf(two)).depth).toEqual([0, 0]);
  });

  it('knows an inside-out part from a hollow', () => {
    expect(hasInsideOutShell(concat(cube(), invert(moved(cube(10), 100, 0, 0))))).toBe(true);
    expect(hasInsideOutShell(concat(lShape(), invert(moved(cube(5), 10, 10, 0))))).toBe(true);
    expect(hasInsideOutShell(invert(hollowCube()))).toBe(true);
    expect(hasInsideOutShell(concat(cube(), moved(cube(10), 100, 0, 0)))).toBe(false);
  });
});

describe('solidPieces', () => {
  it('keeps a hollow with its piece and returns an inside-out lone part as it is', () => {
    const m = meshDataToManifold(wasm, concat(hollowCube(), invert(moved(cube(10), 100, 0, 0))));
    const parts = solidPieces(m);
    try {
      expect(parts.map((p) => p.volume().toFixed(1))).toEqual(['56000.0', '-1000.0']);
    } finally {
      for (const p of parts) p.delete();
      m.delete();
    }
  });

  it('builds a piece from its own surfaces, so a part overlapping the wall does not disturb it', () => {
    // A cube sticking half way out of the hollow cube's wall: the old way cut the pieces out of the whole model.
    const m = meshDataToManifold(wasm, concat(hollowCube(), moved(cube(10), 20, 0, 0)));
    const parts: Manifold[] = solidPieces(m);
    try {
      expect(parts.map((p) => p.volume().toFixed(1))).toEqual(['56000.0', '1000.0']);
    } finally {
      for (const p of parts) p.delete();
      m.delete();
    }
  });
});

describe('splitPieces', () => {
  it('sends a hollow to the part that contains it, and keeps an inside-out lone part apart', () => {
    const pieces = splitPieces(concat(hollowCube(), moved(cube(10), 100, 0, 0), invert(moved(cube(6), -100, 0, 0))));
    expect(pieces.map((p) => signedVolume(p).toFixed(1))).toEqual(['56000.0', '1000.0', '-216.0']);
  });

  it('puts a cube in the notch of an L-shape in a piece of its own', () => {
    const pieces = splitPieces(concat(lShape(), moved(cube(5), 10, 10, 0)));
    expect(pieces.map((p) => signedVolume(p).toFixed(1))).toEqual(['48000.0', '125.0']);
  });
});
