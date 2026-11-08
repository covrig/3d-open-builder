import * as THREE from 'three';
import { fromUnit, settings, toUnit } from '../settings';
import { makeLabel, makeSprite } from './labels';
import type { Palette } from './viewport';

/** 1, 2 or 5 times a power of ten, close to `rough`. */
function niceStep(rough: number): number {
  const p = 10 ** Math.floor(Math.log10(rough));
  const f = rough / p;
  return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p;
}

const AXES: [THREE.Vector3, number, string, string][] = [
  [new THREE.Vector3(1, 0, 0), 0xe5484d, '#e5484d', 'X'],
  [new THREE.Vector3(0, 1, 0), 0x30a46c, '#30a46c', 'Y'],
  [new THREE.Vector3(0, 0, 1), 0x3e8ed0, '#3e8ed0', 'Z'],
];

/**
 * Rulers on the ground along the front and left side of the objects'
 * footprint, counting from 0 at the corner, plus small X/Y/Z axes where the
 * two rulers meet, so sizes and directions can be read next to the model.
 */
export class Ruler {
  readonly group = new THREE.Group();

  update(box: THREE.Box3 | null, p: Palette): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      child.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        (m.material as THREE.Material | undefined)?.dispose?.();
      });
    }
    if (!box || box.isEmpty()) {
      this.addAxes(new THREE.Vector3(0, 0, 0.05), 15);
      return;
    }

    const size = box.getSize(new THREE.Vector3());
    // Text scales with the footprint (small for small parts), within limits.
    const textHeight = THREE.MathUtils.clamp(1.2 + Math.max(size.x, size.y) * 0.04, 1.5, 5);
    const gap = textHeight * 2;
    const color = new THREE.Color(p.label);
    const z = 0.06;

    const side = (axis: 0 | 1) => {
      const length = axis === 0 ? size.x : size.y;
      if (length < 0.01) return;
      // Ruler runs along X in front of the box, or along Y to its left.
      const at = (t: number, off: number) =>
        axis === 0
          ? new THREE.Vector3(box.min.x + t, box.min.y - off, z)
          : new THREE.Vector3(box.min.x - off, box.min.y + t, z);
      const pts: THREE.Vector3[] = [at(0, gap), at(length, gap)];
      // About five ticks, but never so close that the numbers would overlap
      // (a label is roughly 2.5 text-heights wide).
      const step = fromUnit(niceStep(Math.max(toUnit(length) / 5, toUnit(textHeight * 2.5))));
      for (let t = 0; t <= length + 1e-6; t += step) pts.push(at(t, gap * 0.5), at(t, gap * 1.4));
      pts.push(at(length, gap * 0.5), at(length, gap * 1.4));
      this.group.add(new THREE.LineSegments(
        new THREE.BufferGeometry().setFromPoints(pts),
        new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false }),
      ));

      const labelOff = gap * 1.4 + textHeight * (axis === 0 ? 0.7 : 1.4);
      const put = (text: string, t: number, h = textHeight) => {
        const label = makeLabel(text, p.label, h);
        label.position.copy(at(t, labelOff));
        if (axis === 1) label.rotation.z = Math.PI / 2;
        this.group.add(label);
      };
      // Leave room before the final "40 mm" label, which is wider than the others.
      for (let t = 0; t < length - Math.max(step * 0.6, textHeight * 3); t += step) {
        put(String(Math.round(toUnit(t) * 100) / 100), t);
      }
      put(`${Math.round(toUnit(length) * 100) / 100} ${settings.unit}`, length, textHeight * 1.05);
    };
    side(0);
    side(1);

    const axisLength = THREE.MathUtils.clamp(Math.max(size.x, size.y) * 0.25, 6, 15);
    this.addAxes(new THREE.Vector3(box.min.x - gap * 2.6, box.min.y - gap * 2.6, z), axisLength);
  }

  private addAxes(origin: THREE.Vector3, length: number): void {
    for (const [dir, color, css, name] of AXES) {
      this.group.add(new THREE.ArrowHelper(dir, origin, length, color, length * 0.25, length * 0.12));
      const label = makeSprite(name, css, length * 0.3);
      label.position.copy(origin).addScaledVector(dir, length * 1.2);
      this.group.add(label);
    }
  }
}
