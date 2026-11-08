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
    expect(volume(a!.mesh)).toBeCloseTo(1000 - 40, 3);
    expect(volume(b!.mesh)).toBeCloseTo(1000 - 40, 3);
  });

  it('keeps each object inside the shapes, even if the shapes do not overlap each other', () => {
    const shapeA = box([4, 10, 10], [-2, 0, 0]);
    const shapeB = box([4, 10, 10], [8, 0, 0]);
    const [a] = combineWithTools(wasm, 'intersect', [left()], [shapeA, shapeB]);
    expect(volume(a!.mesh)).toBeCloseTo(2 * 200, 3);
  });

  it('returns null where nothing is left', () => {
    const [a] = combineWithTools(wasm, 'intersect', [left()], [box([5, 5, 5], [50, 0, 0])]);
    expect(a).toBeNull();
  });
});
