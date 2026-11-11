import * as THREE from 'three';
import { fromUnit, settings, toUnit } from '../settings';
import { GRID_NUMBER_HEIGHT, makeLabel, makeSprite } from './labels';
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

/** Which sides of the footprint the rulers sit on, and which way their text reads. */
interface Facing {
  /** X ruler at the box's max.y side (true) or its min.y side */
  xFar: boolean;
  /** Y ruler at the box's max.x side (true) or its min.x side */
  yFar: boolean;
  /** The X ruler's text reads towards +x (true) or -x; same for the Y ruler and y */
  xForward: boolean;
  yForward: boolean;
}

const sameFacing = (a: Facing | null, b: Facing) =>
  a !== null && a.xFar === b.xFar && a.yFar === b.yFar && a.xForward === b.xForward && a.yForward === b.yForward;

/**
 * Rulers on the ground along two sides of the objects' footprint (the sides
 * facing the camera, so the numbers are never hidden behind the object),
 * counting from 0 at the corner, plus small X/Y/Z axes where the two rulers
 * meet, so sizes and directions can be read next to the model.
 *
 * Materials, axes and the line objects are made once and reused: rebuilding
 * them on every move would make three.js recompile its shaders each time.
 */
export class Ruler {
  readonly group = new THREE.Group();
  private readonly lineMaterial = new THREE.LineBasicMaterial({ transparent: true, opacity: 0.9, depthWrite: false });
  private readonly pointsMaterial = new THREE.PointsMaterial({ size: 4, sizeAttenuation: false, transparent: true, opacity: 0.9, depthWrite: false });
  private readonly lines: THREE.LineSegments[];
  private readonly dots: THREE.Points[];
  private readonly labels = new THREE.Group();
  private readonly arrows: THREE.ArrowHelper[];
  private readonly sprites: THREE.Sprite[];
  private readonly spriteAspect: number[];
  private box: THREE.Box3 | null = null;
  private palette: Palette | null = null;
  private facing: Facing | null = null;

  constructor() {
    this.lines = [0, 1].map(() => new THREE.LineSegments(new THREE.BufferGeometry(), this.lineMaterial));
    this.dots = [0, 1].map(() => new THREE.Points(new THREE.BufferGeometry(), this.pointsMaterial));
    this.arrows = AXES.map(([dir, color]) => new THREE.ArrowHelper(dir, new THREE.Vector3(), 1, color));
    this.sprites = AXES.map(([, , css, name]) => makeSprite(name, css, 1));
    this.spriteAspect = this.sprites.map((s) => s.scale.x);
    this.group.add(...this.lines, ...this.dots, this.labels, ...this.arrows, ...this.sprites);
  }

  /** Which sides face the camera now, and which way the text reads left to right on screen. */
  private facingOf(box: THREE.Box3, camera: THREE.Camera): Facing {
    const centre = box.getCenter(new THREE.Vector3());
    const right = new THREE.Vector3(1, 0, 0).applyQuaternion(camera.quaternion);
    return {
      xFar: camera.position.y > centre.y,
      yFar: camera.position.x > centre.x,
      xForward: right.x >= 0,
      yForward: right.y >= 0,
    };
  }

  /** Re-place the rulers when the camera has moved to another side (call before every frame). */
  follow(camera: THREE.Camera): void {
    if (!this.box || !this.palette) return;
    if (!sameFacing(this.facing, this.facingOf(this.box, camera))) this.update(this.box, this.palette, camera);
  }

  update(box: THREE.Box3 | null, p: Palette, camera: THREE.Camera): void {
    this.palette = p;
    this.labels.clear();
    this.lineMaterial.color.set(p.label);
    this.pointsMaterial.color.set(p.label);
    for (const o of [...this.lines, ...this.dots]) o.visible = false;
    if (!box || box.isEmpty()) {
      this.box = null;
      this.facing = null;
      this.placeAxes(new THREE.Vector3(0, 0, 0.05), 15);
      return;
    }
    this.box = box.clone();
    const f = (this.facing = this.facingOf(this.box, camera));

    const size = box.getSize(new THREE.Vector3());
    // Same size as the numbers along the plate's axis lines.
    const textHeight = GRID_NUMBER_HEIGHT;
    const gap = textHeight * 2;
    const z = 0.06;
    // Which way is outwards from the footprint on each ruler's side.
    const outY = f.xFar ? 1 : -1;
    const outX = f.yFar ? 1 : -1;
    const edgeY = f.xFar ? box.max.y : box.min.y;
    const edgeX = f.yFar ? box.max.x : box.min.x;

    const side = (axis: 0 | 1) => {
      const length = axis === 0 ? size.x : size.y;
      if (length < 0.01) return;
      // Ruler runs along X beside the box, or along Y; `off` is the distance outwards.
      const at = (t: number, off: number) =>
        axis === 0
          ? new THREE.Vector3(box.min.x + t, edgeY + outY * off, z)
          : new THREE.Vector3(edgeX + outX * off, box.min.y + t, z);
      this.lines[axis].geometry.dispose();
      this.lines[axis].geometry = new THREE.BufferGeometry().setFromPoints([at(0, gap), at(length, gap)]);
      this.lines[axis].visible = true;
      // About five marks, thinned out rather than shrunk so the numbers never
      // overlap (a label is roughly 2.5 text-heights wide).
      const step = fromUnit(niceStep(Math.max(toUnit(length) / 5, toUnit(textHeight * 2.5))));
      // Small dots on the ruler line mark the gradation.
      const dots: THREE.Vector3[] = [];
      for (let t = 0; t <= length + 1e-6; t += step) dots.push(at(t, gap));
      dots.push(at(length, gap));
      this.dots[axis].geometry.dispose();
      this.dots[axis].geometry = new THREE.BufferGeometry().setFromPoints(dots);
      this.dots[axis].visible = true;

      const labelOff = gap + textHeight * (axis === 0 ? 1.1 : 1.6);
      const rotation = axis === 0 ? (f.xForward ? 0 : Math.PI) : (f.yForward ? Math.PI / 2 : -Math.PI / 2);
      const put = (text: string, t: number, h = textHeight) => {
        const label = makeLabel(text, p.label, h);
        label.position.copy(at(t, labelOff));
        label.rotation.z = rotation;
        this.labels.add(label);
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
    this.placeAxes(new THREE.Vector3(edgeX + outX * gap * 2.6, edgeY + outY * gap * 2.6, z), axisLength);
  }

  private placeAxes(origin: THREE.Vector3, length: number): void {
    AXES.forEach(([dir], i) => {
      this.arrows[i].position.copy(origin);
      this.arrows[i].setLength(length, length * 0.25, length * 0.12);
      const h = length * 0.3;
      this.sprites[i].scale.set(h * this.spriteAspect[i], h, 1);
      this.sprites[i].position.copy(origin).addScaledVector(dir, length * 1.2);
    });
  }
}
