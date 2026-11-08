import Module, { type ManifoldToplevel } from 'manifold-3d';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { bakeMesh, meshDataToManifold, type MeshData } from '../src/geometry/meshData';
import { bounds, largestFlatFaceNormal, mirrorMesh, recenter } from '../src/geometry/meshOps';
import { createPrimitive } from '../src/geometry/primitives';
import { SceneDocument } from '../src/scene/document';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const volume = (mesh: MeshData) => {
  const m = meshDataToManifold(wasm, mesh);
  const v = m.volume();
  m.delete();
  return v;
};

/** A wedge: right triangle (legs 30 along X, 10 along Z) extruded 20 along Y. */
function wedge(): MeshData {
  const m = wasm.Manifold.extrude([[0, 0], [30, 0], [0, 10]], 20).rotate([90, 0, 0]);
  const mesh = m.getMesh();
  m.delete();
  return { positions: mesh.vertProperties.slice(), indices: mesh.triVerts.slice() };
}

describe('recenter', () => {
  it('moves the bounding-box centre to the origin and reports where it was', () => {
    const shifted = bakeMesh({
      mesh: createPrimitive(wasm, 'cube'),
      matrix: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 5, -7, 30, 1],
    });
    const { mesh, center } = recenter(shifted);
    expect(center).toEqual([5, -7, 30]);
    const b = bounds(mesh);
    expect(b.min).toEqual([-20, -20, -20]);
    expect(b.max).toEqual([20, 20, 20]);
  });
});

describe('mirrorMesh', () => {
  it('flips geometry across an axis and keeps it a valid, outward-facing solid', () => {
    const w = wedge();
    const before = bounds(w);
    const mirrored = mirrorMesh(w, 0);
    const after = bounds(mirrored);
    expect(after.min[0]).toBeCloseTo(-before.max[0], 5);
    expect(after.max[0]).toBeCloseTo(-before.min[0], 5);
    // Positive volume means faces still point outward.
    expect(volume(mirrored)).toBeCloseTo(volume(w), 3);
  });
});

describe('largestFlatFaceNormal', () => {
  it('picks the sloped face of a wedge, its largest side', () => {
    // Faces: bottom 30x20=600, back 10x20=200, slope sqrt(1000)*20≈632.
    const n = largestFlatFaceNormal(wasm, wedge());
    const slope = new THREE.Vector3(10, 0, 30).normalize(); // outward normal of the slope
    expect(new THREE.Vector3(...n).dot(slope)).toBeCloseTo(1, 4);
  });

  it('keeps a cube resting on its bottom face when all faces tie', () => {
    const n = largestFlatFaceNormal(wasm, createPrimitive(wasm, 'cube'));
    expect(n[2]).toBeCloseTo(-1, 6);
  });
});

describe('SceneDocument undo/redo', () => {
  it('restores objects, transforms, colours and selection', () => {
    const doc = new SceneDocument(new THREE.Group());
    const cube = createPrimitive(wasm, 'cube');

    doc.checkpoint();
    const a = doc.add('Cube', cube);
    doc.setSelection([a]);

    doc.checkpoint();
    a.mesh.position.set(10, 0, 20);
    doc.setColor([a], '#ff0000');

    doc.checkpoint();
    doc.remove([a]);
    expect(doc.objects).toHaveLength(0);

    doc.undo(); // back to moved + red
    expect(doc.objects).toHaveLength(1);
    expect(doc.objects[0].mesh.position.toArray()).toEqual([10, 0, 20]);
    expect(doc.objects[0].color).toBe('#ff0000');
    expect(doc.selection.map((o) => o.name)).toEqual(['Cube 1']);
    // Mesh data is shared, not copied.
    expect(doc.objects[0].data).toBe(cube);

    doc.undo(); // back to original position and colour
    expect(doc.objects[0].mesh.position.toArray()).toEqual([0, 0, 0]);
    expect(doc.objects[0].color).not.toBe('#ff0000');

    doc.undo(); // before the cube existed
    expect(doc.objects).toHaveLength(0);
    expect(doc.canUndo).toBe(false);

    doc.redo();
    doc.redo();
    expect(doc.objects[0].mesh.position.toArray()).toEqual([10, 0, 20]);
    expect(doc.canRedo).toBe(true);

    doc.checkpoint(); // a new action drops the redo history
    expect(doc.canRedo).toBe(false);
  });
});
