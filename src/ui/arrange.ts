import * as THREE from 'three';
import type { SceneDocument, SceneObject } from '../scene/document';

type Which = 'min' | 'mid' | 'max';
const SPACING = 5; // mm between packed objects

/** Objects that move together: each group is one unit, other objects are units of their own. */
export function units(doc: SceneDocument, objs: SceneObject[]): { objs: SceneObject[]; box: THREE.Box3 }[] {
  const byGroup = new Map<string, SceneObject[]>();
  for (const o of objs) {
    const key = o.groupId !== undefined ? `g${o.groupId}` : `o${o.id}`;
    const list = byGroup.get(key);
    if (list) list.push(o);
    else byGroup.set(key, [o]);
  }
  return [...byGroup.values()].map((list) => ({ objs: list, box: doc.worldBox(list) }));
}

const edge = (b: THREE.Box3, axis: number, which: Which) =>
  which === 'min' ? b.min.getComponent(axis) : which === 'max' ? b.max.getComponent(axis) : (b.min.getComponent(axis) + b.max.getComponent(axis)) / 2;

function shift(objs: SceneObject[], axis: number, by: number): void {
  for (const o of objs) o.mesh.position.setComponent(axis, o.mesh.position.getComponent(axis) + by);
}

/**
 * Align, distribute and pack for the Arrange section. Every action is one
 * undo step and treats a group as a single piece.
 */
export function setupArrange(doc: SceneDocument, toast: (msg: string) => void): void {
  const run = (fn: () => void) => {
    doc.checkpoint();
    fn();
    doc.emit('transform');
  };

  /** Line up the pieces' left/centre/right (etc.) with the selection's own outline. */
  for (const b of document.querySelectorAll<HTMLElement>('[data-align]')) {
    b.addEventListener('click', () => {
      const [axisName, which] = b.dataset.align!.split('-') as [string, Which];
      const axis = 'xyz'.indexOf(axisName);
      const parts = units(doc, doc.selection);
      if (parts.length < 2) return toast('Select two or more objects to line up');
      const target = edge(doc.worldBox(doc.selection), axis, which);
      run(() => parts.forEach((p) => shift(p.objs, axis, target - edge(p.box, axis, which))));
    });
  }

  /** Equal gaps between pieces along an axis; the outermost two stay where they are. */
  for (const b of document.querySelectorAll<HTMLElement>('[data-distribute]')) {
    b.addEventListener('click', () => {
      const axis = 'xyz'.indexOf(b.dataset.distribute!);
      const parts = units(doc, doc.selection);
      if (parts.length < 3) return toast('Select three or more objects to space evenly');
      parts.sort((p, q) => p.box.min.getComponent(axis) - q.box.min.getComponent(axis));
      const start = parts[0].box.min.getComponent(axis);
      const end = Math.max(...parts.map((p) => p.box.max.getComponent(axis)));
      const sizes = parts.map((p) => p.box.max.getComponent(axis) - p.box.min.getComponent(axis));
      const gap = (end - start - sizes.reduce((s, v) => s + v, 0)) / (parts.length - 1);
      run(() => {
        let at = start;
        parts.forEach((p, i) => {
          shift(p.objs, axis, at - p.box.min.getComponent(axis));
          at += sizes[i] + gap;
        });
      });
    });
  }

  /** Lay pieces out side by side on the plate in rows, without overlapping, centred on the origin. */
  document.querySelector('[data-action="pack"]')!.addEventListener('click', () => {
    const objs = doc.selection.length ? doc.selection : doc.objects;
    const parts = units(doc, objs);
    if (parts.length < 2) return toast('Pack needs two or more objects');
    parts.sort((p, q) => (q.box.max.y - q.box.min.y) - (p.box.max.y - p.box.min.y)); // tallest rows first
    const area = parts.reduce((s, p) => s + (p.box.max.x - p.box.min.x + SPACING) * (p.box.max.y - p.box.min.y + SPACING), 0);
    const rowWidth = Math.max(Math.sqrt(area) * 1.2, ...parts.map((p) => p.box.max.x - p.box.min.x));
    const placed: { part: (typeof parts)[number]; x: number; y: number }[] = [];
    let x = 0, y = 0, rowDepth = 0;
    for (const p of parts) {
      const w = p.box.max.x - p.box.min.x, dpt = p.box.max.y - p.box.min.y;
      if (x > 0 && x + w > rowWidth) {
        x = 0;
        y += rowDepth + SPACING;
        rowDepth = 0;
      }
      placed.push({ part: p, x, y });
      x += w + SPACING;
      rowDepth = Math.max(rowDepth, dpt);
    }
    const totalW = Math.max(...placed.map((q) => q.x + q.part.box.max.x - q.part.box.min.x));
    const totalD = y + rowDepth;
    run(() => {
      for (const q of placed) {
        shift(q.part.objs, 0, q.x - totalW / 2 - q.part.box.min.x);
        shift(q.part.objs, 1, q.y - totalD / 2 - q.part.box.min.y);
        shift(q.part.objs, 2, -q.part.box.min.z); // rest on the plate
      }
    });
  });
}
