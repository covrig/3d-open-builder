// @vitest-environment happy-dom
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { MeshData } from '../src/geometry/meshData';
import { SceneDocument } from '../src/scene/document';

const tri = (x = 0): MeshData => ({
  positions: new Float32Array([x, 0, 0, x + 1, 0, 0, x, 1, 0]),
  indices: new Uint32Array([0, 1, 2]),
});

/** Count the events a document sends, in order. */
function listen(doc: SceneDocument): string[] {
  const log: string[] = [];
  for (const type of ['change', 'transform', 'selection', 'history'] as const) {
    doc.addEventListener(type, () => log.push(type));
  }
  return log;
}
const count = (log: string[], type: string) => log.filter((t) => t === type).length;

describe('doc.transact and doc.batch', () => {
  it('sends change and selection once, after the callback', () => {
    const doc = new SceneDocument(new THREE.Group());
    const log = listen(doc);
    let during = -1;
    doc.transact(() => {
      const objs = [doc.add('A', tri()), doc.add('B', tri(1)), doc.add('C', tri(2))];
      doc.setSelection(objs);
      during = log.length;
    });
    expect(during).toBe(0);
    expect(count(log, 'change')).toBe(1);
    expect(count(log, 'selection')).toBe(1);
    expect(doc.objects).toHaveLength(3);
  });

  it('sends the held-back events in a fixed order', () => {
    const doc = new SceneDocument(new THREE.Group());
    const log = listen(doc);
    doc.batch(() => {
      doc.emit('history');
      doc.emit('selection');
      doc.emit('transform');
      doc.emit('change');
    });
    expect(log).toEqual(['change', 'transform', 'selection', 'history']);
  });

  it('is one undo step that brings everything back with a single change event', () => {
    const doc = new SceneDocument(new THREE.Group());
    doc.add('Base', tri());
    doc.transact(() => {
      doc.add('A', tri(1));
      doc.add('B', tri(2));
      doc.add('C', tri(3));
    });
    expect(doc.objects).toHaveLength(4);
    const log = listen(doc);
    doc.undo();
    expect(doc.objects.map((o) => o.name)).toEqual(['Base 1']);
    expect(count(log, 'change')).toBe(1);
    expect(doc.canUndo).toBe(false);
  });

  it('nested batches send events once, at the end of the outermost one', () => {
    const doc = new SceneDocument(new THREE.Group());
    const log = listen(doc);
    doc.batch(() => {
      doc.batch(() => doc.add('A', tri()));
      expect(log).toEqual([]);
      doc.batch(() => doc.add('B', tri(1)));
    });
    expect(count(log, 'change')).toBe(1);
  });

  it('still sends the events and rethrows when the callback throws, keeping the checkpoint', () => {
    const doc = new SceneDocument(new THREE.Group());
    doc.add('Base', tri());
    const log = listen(doc);
    expect(() =>
      doc.transact(() => {
        doc.add('A', tri(1));
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(count(log, 'change')).toBe(1);
    expect(doc.objects).toHaveLength(2);
    expect(doc.canUndo).toBe(true);
    doc.undo();
    expect(doc.objects).toHaveLength(1);
    // The batch is closed again: events are sent straight away.
    const after = listen(doc);
    doc.add('B', tri(2));
    expect(count(after, 'change')).toBe(1);
  });

  it('returns what the callback returns', () => {
    const doc = new SceneDocument(new THREE.Group());
    expect(doc.transact(() => 42)).toBe(42);
  });

  it('undo and redo of 50 objects send one change event each', () => {
    const doc = new SceneDocument(new THREE.Group());
    doc.transact(() => {
      for (let i = 0; i < 50; i++) doc.add('Part', tri(i));
    });
    expect(doc.objects).toHaveLength(50);
    const log = listen(doc);
    doc.undo();
    expect(doc.objects).toHaveLength(0);
    expect(count(log, 'change')).toBe(1);
    log.length = 0;
    doc.redo();
    expect(doc.objects).toHaveLength(50);
    expect(count(log, 'change')).toBe(1);
  });

  it('loadState and addCopies send one change event', () => {
    const doc = new SceneDocument(new THREE.Group());
    doc.add('A', tri());
    doc.add('B', tri(1));
    const states = doc.objects.map((o) => doc.capture(o));
    const log = listen(doc);
    doc.addCopies(states);
    expect(count(log, 'change')).toBe(1);
    log.length = 0;
    doc.loadState(doc.exportState());
    expect(count(log, 'change')).toBe(1);
  });
});
