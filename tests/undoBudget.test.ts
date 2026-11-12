// @vitest-environment happy-dom
import * as THREE from 'three';
import { afterEach, describe, expect, it } from 'vitest';
import type { MeshData } from '../src/geometry/meshData';
import { SceneDocument, setUndoBudget, undoBudget } from '../src/scene/document';

/** A tiny mesh of one triangle: 36 + 12 = 48 bytes. */
const tri = (x = 0): MeshData => ({
  positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
});
const BYTES = 48;
const original = undoBudget();
afterEach(() => setUndoBudget(original));

/** How many times undo works. */
function undoSteps(doc: SceneDocument): number {
  let steps = 0;
  while (doc.canUndo) {
    doc.undo();
    steps++;
  }
  return steps;
}

describe('undo memory budget', () => {
  it('has a sane default', () => {
    expect(undoBudget()).toBeGreaterThanOrEqual(128 * 1024 * 1024);
  });

  it('keeps history within the budget once there are more than 5 steps', () => {
    setUndoBudget(BYTES * 8);
    const doc = new SceneDocument(new THREE.Group());
    const obj = doc.add('A', tri());
    for (let i = 1; i <= 40; i++) {
      doc.checkpoint();
      doc.setData(obj, tri(i));
    }
    // (A checkpoint trims the history; the change after it makes the newest snapshot's mesh count too.)
    doc.checkpoint();
    expect(doc.historyBytes()).toBeLessThanOrEqual(BYTES * 8);
    const steps = undoSteps(doc);
    expect(steps).toBeGreaterThanOrEqual(5);
    expect(steps).toBeLessThanOrEqual(9);
  });

  it('never keeps fewer than 5 undo steps because of the budget', () => {
    setUndoBudget(1);
    const doc = new SceneDocument(new THREE.Group());
    const obj = doc.add('A', tri());
    for (let i = 1; i <= 20; i++) {
      doc.checkpoint();
      doc.setData(obj, tri(i));
    }
    expect(undoSteps(doc)).toBe(5);
  });

  it('drops the redo steps farthest from the present when still over budget', () => {
    const doc = new SceneDocument(new THREE.Group());
    const obj = doc.add('A', tri(0));
    for (let i = 1; i <= 8; i++) {
      doc.checkpoint();
      doc.setData(obj, tri(i));
    }
    setUndoBudget(BYTES * 2);
    for (let i = 0; i < 8 && doc.canUndo; i++) doc.undo();
    expect(doc.historyBytes()).toBeLessThanOrEqual(BYTES * 2);
    expect(doc.canRedo).toBe(true);
    // Redo walks toward the newest shape: the nearest steps are the ones kept.
    let redos = 0;
    while (doc.canRedo) {
      doc.redo();
      redos++;
    }
    expect(redos).toBeLessThan(8);
  });

  it('counts a mesh shared by many snapshots once', () => {
    const doc = new SceneDocument(new THREE.Group());
    const a = doc.add('A', tri(1));
    for (let i = 0; i < 10; i++) doc.checkpoint();
    expect(doc.historyBytes()).toBe(0); // still the live mesh
    doc.setData(a, tri(2));
    expect(doc.historyBytes()).toBe(BYTES); // the old mesh, once, though 10 snapshots hold it
  });

  it('does not count the meshes of live objects', () => {
    const doc = new SceneDocument(new THREE.Group());
    doc.add('A', tri(1));
    doc.add('B', tri(2));
    doc.checkpoint();
    doc.checkpoint();
    expect(doc.historyBytes()).toBe(0);
  });

  it('emits history when it drops steps', () => {
    setUndoBudget(1);
    const doc = new SceneDocument(new THREE.Group());
    const obj = doc.add('A', tri());
    for (let i = 1; i <= 8; i++) {
      doc.checkpoint();
      doc.setData(obj, tri(i));
    }
    let n = 0;
    doc.addEventListener('history', () => n++);
    doc.checkpoint();
    doc.setData(obj, tri(99));
    doc.checkpoint(); // over the budget with more than 5 steps: drops one
    expect(n).toBeGreaterThanOrEqual(3);
  });
});
