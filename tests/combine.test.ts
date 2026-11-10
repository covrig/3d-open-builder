import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { combineWithTools } from '../src/geometry/booleans';
import { meshDataToManifold, type MeshData, type PlacedMesh } from '../src/geometry/meshData';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const box = (size: [number, number, number], at: [number, number, number]): PlacedMesh => {
  const m = wasm.Manifold.cube(size).translate(at);
  const mesh = m.getMesh();
  m.delete();
  return {
    mesh: { positions: mesh.vertProperties.slice(), indices: mesh.triVerts.slice() },
    matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1],
  };
};
const volume = (mesh: MeshData) => {
  const m = meshDataToManifold(wasm, mesh);
  const v = m.volume();
  m.delete();
  return v;
};

// Two 10 mm cubes side by side, and a long bar through both of them.
const left = () => box([10, 10, 10], [0, 0, 0]);
const right = () => box([10, 10, 10], [20, 0, 0]);
const bar = () => box([40, 2, 2], [-5, 4, 4]);

describe('subtract and intersect with roles', () => {
  it('cuts one cutter out of two objects', () => {
    const [a, b] = combineWithTools(wasm, 'subtract', [left(), right()], [bar()]);
    expect(a).toHaveLength(1);
    expect(volume(a![0].mesh)).toBeCloseTo(1000 - 40, 3);
    expect(volume(b![0].mesh)).toBeCloseTo(1000 - 40, 3);
  });

  it('gives the separate pieces of an intersect as separate results', () => {
    // Two shapes that don't touch each other keep two separate ends of the cube.
    const shapeA = box([4, 10, 10], [-2, 0, 0]);
    const shapeB = box([4, 10, 10], [8, 0, 0]);
    const [pieces] = combineWithTools(wasm, 'intersect', [left()], [shapeA, shapeB]);
    expect(pieces).toHaveLength(2);
    for (const p of pieces!) expect(volume(p.mesh)).toBeCloseTo(200, 3);
  });

  it('gives the separate pieces of a subtract as separate results, largest first', () => {
    // A slab through the cube, off centre: two pieces of 6 mm and 2 mm.
    const slab = box([12, 12, 2], [-1, -1, 6]);
    const [pieces] = combineWithTools(wasm, 'subtract', [left()], [slab]);
    expect(pieces).toHaveLength(2);
    expect(volume(pieces![0].mesh)).toBeCloseTo(600, 3);
    expect(volume(pieces![1].mesh)).toBeCloseTo(200, 3);
  });

  it('leaves an object that a subtract\'s cutters do not go into exactly as it is', () => {
    const [touched, untouched] = combineWithTools(wasm, 'subtract', [left(), box([5, 5, 5], [50, 0, 0])], [bar()]);
    expect(volume(touched![0].mesh)).toBeCloseTo(1000 - 40, 3);
    expect(untouched).toBeNull();
  });

  it('returns no pieces where nothing is left', () => {
    const [a] = combineWithTools(wasm, 'intersect', [left()], [box([5, 5, 5], [50, 0, 0])]);
    expect(a).toEqual([]);
  });
});