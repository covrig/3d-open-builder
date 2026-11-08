// @vitest-environment happy-dom
// The autosave module uses window/localStorage, which happy-dom provides.
import Module, { type ManifoldToplevel } from 'manifold-3d';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { fromJson, fromSaved, toJson, toSaved } from '../src/app/autosave';
import { createPrimitive } from '../src/geometry/primitives';
import { SceneDocument } from '../src/scene/document';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

describe('undo/redo with measurements', () => {
  it('undoes and redoes adding and clearing measurements', () => {
    const doc = new SceneDocument(new THREE.Group());
    const cube = doc.add('Cube', createPrimitive(wasm, 'cube'));
    const m = { kind: 'distance' as const, points: [{ objectId: cube.id, local: new THREE.Vector3(0, 0, 20) }, { local: new THREE.Vector3(30, 0, 0) }] };

    doc.checkpoint();
    doc.setMeasurements([m]);
    doc.checkpoint();
    doc.setMeasurements([]); // Clear
    expect(doc.measurements).toHaveLength(0);

    doc.undo(); // clear undone
    expect(doc.measurements).toHaveLength(1);
    doc.undo(); // adding undone
    expect(doc.measurements).toHaveLength(0);
    doc.redo();
    expect(doc.measurements).toHaveLength(1);
    expect(doc.measurements[0].points[0].objectId).toBe(cube.id);
  });
});

describe('autosave data', () => {
  it('round-trips a scene through the stored format, including JSON fallback', () => {
    const doc = new SceneDocument(new THREE.Group());
    const a = doc.add('Cube', createPrimitive(wasm, 'cube'));
    a.mesh.position.set(10, 20, 20);
    doc.setColor([a], '#ff0000');
    const b = doc.add('Sphere', createPrimitive(wasm, 'sphere'));
    doc.group([a, b]);
    doc.setMeasurements([{ kind: 'distance', points: [{ objectId: a.id, local: new THREE.Vector3(1, 2, 3) }, { local: new THREE.Vector3(4, 5, 6) }] }]);

    const saved = fromJson(toJson(toSaved(doc.exportState(), 'my part', { reference: null })));
    expect(saved.name).toBe('my part');

    const restored = new SceneDocument(new THREE.Group());
    restored.loadState(fromSaved(saved));
    expect(restored.objects.map((o) => o.name)).toEqual(['Cube 1', 'Sphere 1']);
    expect(restored.objects[0].mesh.position.toArray()).toEqual([10, 20, 20]);
    expect(restored.objects[0].color).toBe('#ff0000');
    expect(restored.objects[0].groupId).toBe(restored.objects[1].groupId);
    expect(restored.objects[0].data.positions).toBeInstanceOf(Float32Array);
    expect(restored.objects[0].data.positions).toEqual(a.data.positions);
    expect(restored.measurements[0].points[0].local.toArray()).toEqual([1, 2, 3]);
    // New objects continue the numbering instead of reusing names.
    expect(restored.add('Cube', createPrimitive(wasm, 'cube')).name).toBe('Cube 2');
  });
});
