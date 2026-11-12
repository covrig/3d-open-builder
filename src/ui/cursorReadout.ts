import * as THREE from 'three';
import type { Viewport } from '../scene/viewport';
import { toUnit } from '../settings';

const PLATE = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0);

/**
 * Shows the world position under the mouse (X, Y, Z in the page unit): the
 * first point on an object, else the point on the plate (z = 0). Mouse only;
 * touch has no hovering pointer.
 */
export function setupCursorReadout(viewport: Viewport): { update(clientX: number, clientY: number): void; hide(): void } {
  const box = document.querySelector<HTMLElement>('#cursor-xyz')!;
  const rows = ['x', 'y', 'z'].map((a) => box.querySelector<HTMLElement>(`.${a}`)!);
  const coarse = matchMedia('(pointer: coarse)');
  let pending: { x: number; y: number } | null = null;
  let frame = 0;

  const show = (values: (number | null)[]) => {
    box.hidden = false;
    // Fixed decimals keep the digits from jumping about; "-0.00" is shown as "0.00".
    rows.forEach((r, i) => {
      const v = values[i];
      r.textContent = v === null ? '–' : (Math.round(toUnit(v) * 100) / 100 + 0).toFixed(2);
    });
  };

  const compute = (x: number, y: number) => {
    const ray = viewport.rayAt(x, y);
    const hit = viewport.hitsOn(ray)[0]?.point;
    if (hit) return show([hit.x, hit.y, hit.z]);
    const onPlate = ray.ray.intersectPlane(PLATE, new THREE.Vector3());
    if (onPlate) show([onPlate.x, onPlate.y, onPlate.z]);
    else show([null, null, null]);
  };

  return {
    update(clientX, clientY) {
      if (coarse.matches) return;
      pending = { x: clientX, y: clientY };
      if (frame) return;
      // At most once per frame: raycasting every pointer event is wasted work.
      frame = requestAnimationFrame(() => {
        frame = 0;
        if (pending) compute(pending.x, pending.y);
        pending = null;
      });
    },
    hide() {
      pending = null;
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
      box.hidden = true;
    },
  };
}
