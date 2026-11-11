import * as THREE from 'three';
import { settings } from '../settings';
import type { SceneDocument } from './document';
import type { Viewport } from './viewport';

export type GizmoMode = 'translate' | 'rotate' | 'scale';

const SVG_NS = 'http://www.w3.org/2000/svg';
export const AXIS_COLORS = ['#e5484d', '#30a46c', '#3e8ed0']; // X, Y, Z
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];

const ARROW_LENGTH = 34; // px, double arrow for Move and Rotate
const OFFSET = 14; // px between an object's face and its handle
const MOVE_SNAP = 1; // mm
const ROTATE_SNAP = 5; // degrees
const SIZE_SNAP = 1; // mm
const FACE_SNAP = 2; // mm: faces closer than this to another face line up
const NEAR = 20; // mm: only objects within this distance count for face snapping
/**
 * Spots for a rotation ring's arrow, as steps of the 72 around it: the four
 * points at 45° between the axes. (The axis points, steps 0, 18, 36 and 54,
 * are where two rings cross.)
 */
const RING_DIAGONALS = [9, 27, 45, 63];

/** Screen distance from a point to a closed polyline. */
function distanceToLoop(p: THREE.Vector2, loop: THREE.Vector2[]): number {
  let best = Infinity;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i], b = loop[(i + 1) % loop.length];
    const abx = b.x - a.x, aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    const t = len2 > 0 ? Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2)) : 0;
    best = Math.min(best, Math.hypot(p.x - (a.x + abx * t), p.y - (a.y + aby * t)));
  }
  return best;
}

/** Touch screens (no precise pointer): handles get larger invisible grab areas. */
const COARSE = window.matchMedia('(pointer: coarse)');

/** Double-headed arrow along +x, centred on the origin. */
function doubleArrow(length: number): string {
  const h = length / 2, head = 9, w = 7, shaft = 2;
  return [
    [-h, 0], [-h + head, -w], [-h + head, -shaft], [h - head, -shaft], [h - head, -w],
    [h, 0], [h - head, w], [h - head, shaft], [-h + head, shaft], [-h + head, w],
  ].map((p) => p.join(',')).join(' ');
}

/** Two small triangles pointing along +x (Size handles). */
const DOUBLE_TRIANGLE = 'M0,-6 L9,0 L0,6 Z M8,-6 L17,0 L8,6 Z';

type HandleKind = 'move' | 'rotate' | 'scale' | 'corner';

interface Handle {
  kind: HandleKind;
  axis: number;
  /** +1 / -1: which face of the box the handle belongs to */
  sign: number;
  /** Element that gets positioned each frame */
  el: SVGElement;
  /** Rotation rings: invisible wide path that catches the mouse */
  hit?: SVGPathElement;
  /** Screen direction the handle points (outward), and pixels per mm along it */
  u: THREE.Vector2;
  pxPerMm: number;
  /** Rotate: +1 if a turn that looks counter-clockwise on screen (y down: increasing angle) is positive */
  spin?: number;
  /** Rotate: the ring is seen roughly face-on */
  faceOn?: boolean;
  /** Rotate: where on the ring the arrow sits (step of 72) */
  step?: number;
  /** Touch screens: an invisible, larger copy under the handle that is easier to grab */
  touch?: SVGElement;
}

interface DragState {
  handle: Handle;
  pointerId: number;
  start: THREE.Vector2;
  lastAngle: number;
  angle: number;
  targets: THREE.Object3D[];
  positions: THREE.Vector3[];
  quaternions: THREE.Quaternion[];
  scales: THREE.Vector3[];
  box: THREE.Box3;
  center: THREE.Vector3;
  screenCenter: THREE.Vector2;
  others: THREE.Box3[];
  u: THREE.Vector2;
  pxPerMm: number;
  checkpointed: boolean;
}

/**
 * Compact on-screen handles drawn as an SVG layer over the 3D view, so they
 * keep the same small size in pixels at any zoom level:
 * - Move: one double arrow per axis next to the object
 * - Rotate: three thin rings with one arrow each
 * - Size: a frame with corner dots (keeps proportions) plus one arrow pair per axis
 */
export class Gizmo {
  private mode: GizmoMode = 'translate';
  private readonly svg: SVGSVGElement;
  private handles: Handle[] = [];
  private frame?: SVGRectElement;
  private drag?: DragState;
  /** Hidden while another tool (e.g. Split) owns the view. */
  enabled = true;
  /** When set, the Size arrows resize evenly on all axes (the lock in the transform bar). */
  keepProportions = true;

  constructor(
    private readonly viewport: Viewport,
    private readonly doc: SceneDocument,
  ) {
    this.svg = document.createElementNS(SVG_NS, 'svg');
    this.svg.classList.add('gizmo');
    viewport.element.append(this.svg);
    // Rotation rings live in the 3D scene so objects hide the parts behind them
    // (the arrows stay in the layer on top, always visible).
    AXIS_COLORS.forEach((color, a) => {
      const e1 = AXES[(a + 1) % 3], e2 = AXES[(a + 2) % 3];
      const pts: THREE.Vector3[] = [];
      for (let i = 0; i < 128; i++) {
        const t = (i / 128) * Math.PI * 2;
        pts.push(e1.clone().multiplyScalar(Math.cos(t)).addScaledVector(e2, Math.sin(t)));
      }
      const ring = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color }));
      ring.raycast = () => {};
      this.rings.add(ring);
    });
    this.rings.visible = false;
    viewport.scene.add(this.rings);
    this.build();
    viewport.beforeFrame(() => this.placeRings());
    viewport.onFrame(() => {
      this.update();
      // Touch twins follow their handles.
      for (const h of this.handles) {
        if (!h.touch) continue;
        for (const a of ['transform', 'cx', 'cy']) {
          const v = h.el.getAttribute(a);
          if (v !== null) h.touch.setAttribute(a, v);
        }
      }
    });
  }

  private readonly rings = new THREE.Group();

  private targetMeshes(): THREE.Object3D[] {
    return this.doc.selection.map((o) => o.mesh);
  }

  private targetBox(): THREE.Box3 {
    return this.doc.worldBox(this.doc.selection);
  }

  private changed(): void {
    this.doc.emit('transform');
  }

  /** Put the 3D rings around the selection (before each frame is drawn). */
  private placeRings(): void {
    const targets = this.targetMeshes();
    this.rings.visible = this.mode === 'rotate' && this.enabled && targets.length > 0;
    if (!this.rings.visible) return;
    const turning = this.drag?.handle.kind === 'rotate';
    const box = turning ? this.drag!.box : this.targetBox();
    const center = turning ? this.drag!.center : box.getCenter(new THREE.Vector3());
    this.rings.position.copy(center);
    this.rings.scale.setScalar(Math.max(box.getBoundingSphere(new THREE.Sphere()).radius * 1.08, 8));
  }

  setMode(mode: GizmoMode): void {
    this.mode = mode;
    this.build();
    this.viewport.invalidate();
  }

  get dragging(): boolean {
    return this.drag !== undefined;
  }

  // --- Elements -----------------------------------------------------------

  private el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>): SVGElementTagNameMap[K] {
    const e = document.createElementNS(SVG_NS, tag);
    for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
    this.svg.append(e);
    return e;
  }

  private addHandle(kind: HandleKind, axis: number, sign: number, el: SVGElement, extra: Partial<Handle> = {}): void {
    const handle: Handle = { kind, axis, sign, el, u: new THREE.Vector2(1, 0), pxPerMm: 1, ...extra };
    // Fingers are less precise than a mouse: on touch screens each handle gets
    // a wider invisible twin. All twins go below all handles, so a twin never
    // covers another handle.
    if (COARSE.matches) {
      handle.touch = el.cloneNode() as SVGElement;
      handle.touch.setAttribute('class', el.tagName === 'circle' ? 'handle-touch corner-touch' : 'handle-touch');
      this.svg.prepend(handle.touch);
    }
    for (const target of [el, extra.hit, handle.touch]) {
      target?.addEventListener('pointerdown', (e) => this.startDrag(e as PointerEvent, handle));
    }
    this.handles.push(handle);
  }

  private build(): void {
    this.svg.replaceChildren();
    this.handles = [];
    this.frame = undefined;
    switch (this.mode) {
      case 'translate':
        for (let a = 0; a < 3; a++) {
          const arrow = this.el('polygon', { points: doubleArrow(ARROW_LENGTH), fill: AXIS_COLORS[a], class: 'handle' });
          this.addHandle('move', a, 1, arrow);
        }
        break;
      case 'rotate':
      {
        // Every arrow sits where another ring passes, so all arrows go above
        // all the rings' click areas (else grabbing one arrow turns another axis).
        const hits = [0, 1, 2].map(() => this.el('path', { fill: 'none', class: 'ring-hit' }));
        for (let a = 0; a < 3; a++) {
          const arrow = this.el('polygon', { points: doubleArrow(28), fill: AXIS_COLORS[a], class: 'handle' });
          this.addHandle('rotate', a, 1, arrow, { hit: hits[a] });
        }
      }
        break;
      case 'scale':
        this.frame = this.el('rect', { class: 'frame', fill: 'none' });
        for (let i = 0; i < 4; i++) {
          this.addHandle('corner', i, 1, this.el('circle', { r: 5, class: 'handle corner' }));
        }
        // Fixed sides, so the arrows don't hop around as the view turns: X both ways, Y at the front, Z on top.
        for (const [axis, sign] of [[0, 1], [0, -1], [1, -1], [2, 1]]) {
          const tri = this.el('path', { d: DOUBLE_TRIANGLE, fill: AXIS_COLORS[axis], class: 'handle' });
          this.addHandle('scale', axis, sign, tri);
        }
        break;
    }
  }

  // --- Per-frame layout ---------------------------------------------------

  private update(): void {
    const targets = this.targetMeshes();
    const visible = this.enabled && targets.length > 0;
    this.svg.style.display = visible ? '' : 'none';
    if (!visible) return;

    // While turning, the rings stay put (the turn is about the start centre),
    // which also saves measuring the turning object every frame.
    const turning = this.drag?.handle.kind === 'rotate';
    const box = turning ? this.drag!.box : this.targetBox();
    const center = turning ? this.drag!.center : box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    const cam = this.viewport.camera.position;
    const camSide = (a: number) => (cam.getComponent(a) >= center.getComponent(a) ? 1 : -1);
    const ref = Math.max(size.x, size.y, size.z, 10) / 2;
    const project = (p: THREE.Vector3) => this.viewport.project(p);

    const faceCenter = (a: number, sign: number) =>
      center.clone().setComponent(a, sign > 0 ? box.max.getComponent(a) : box.min.getComponent(a));

    /** Where a face projects, and which way (and how far per mm) its axis runs on screen. */
    const measure = (a: number, sign: number) => {
      const anchor = faceCenter(a, sign);
      const s0 = project(anchor);
      const dir = project(anchor.clone().addScaledVector(AXES[a], sign * ref)).sub(s0);
      const len = dir.length();
      return { s0, u: len > 1e-6 ? dir.divideScalar(len) : new THREE.Vector2(1, 0), pxPerMm: Math.max(len / ref, 1e-3) };
    };
    const place = (el: SVGElement, at: THREE.Vector2, dir: THREE.Vector2, scale = 1) => {
      const deg = THREE.MathUtils.radToDeg(Math.atan2(dir.y, dir.x));
      el.setAttribute('transform', `translate(${at.x.toFixed(1)},${at.y.toFixed(1)}) rotate(${deg.toFixed(1)}) scale(${scale.toFixed(2)})`);
    };

    if (this.mode === 'translate') {
      // While dragging, arrows keep their side even if the object passes the
      // camera; switching sides mid-drag looks like the object jumped.
      const m = [0, 1, 2].map((a) => {
        const held = this.drag ? this.handles.find((h) => h.axis === a) : undefined;
        const sign = held ? held.sign : a === 2 ? 1 : camSide(a);
        return { sign, ...measure(a, sign) };
      });
      const maxPx = Math.max(...m.map((x) => x.pxPerMm));
      for (const h of this.handles) {
        const { sign, s0, u, pxPerMm } = m[h.axis];
        // Axes pointing at the camera look short on screen; shrink their arrow to match.
        const f = THREE.MathUtils.clamp(pxPerMm / maxPx, 0.35, 1);
        const at = s0.clone().addScaledVector(u, (OFFSET + (ARROW_LENGTH / 2)) * f);
        place(h.el, at, u, f);
        Object.assign(h, { sign, u, pxPerMm });
      }
    } else if (this.mode === 'rotate') {
      const radius = Math.max(box.getBoundingSphere(new THREE.Sphere()).radius * 1.08, 8);
      const toCam = cam.clone().sub(center);
      const ringPoint = (a: number, i: number) => {
        const t = (i / 72) * Math.PI * 2;
        return center.clone().addScaledVector(AXES[(a + 1) % 3], radius * Math.cos(t)).addScaledVector(AXES[(a + 2) % 3], radius * Math.sin(t));
      };
      const rings = this.handles.map((h) => Array.from({ length: 72 }, (_, i) => project(ringPoint(h.axis, i))));
      const placed: THREE.Vector2[] = [];
      this.handles.forEach((h, k) => {
        const a = h.axis;
        const pts = rings[k];
        // The ring itself is drawn in 3D (hidden behind objects); this path only catches the mouse.
        h.hit!.setAttribute('d', `M${pts.map((p) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`).join('L')}Z`);
        // Every axis point of a ring is also on another ring, so an arrow there
        // could grab the wrong ring. Arrows sit halfway between, on one of the
        // four 45° spots: one on the camera side of the object (never hidden behind
        // it) that is farthest on screen from the other rings and arrows. A spot
        // is kept while it stays nearly as good, and always while dragging.
        const others = rings.filter((_, j) => j !== k);
        const score = (i: number) => {
          if (ringPoint(a, i).sub(center).dot(toCam) < 0) return -1;
          let d = Infinity;
          for (const ring of others) d = Math.min(d, distanceToLoop(pts[i], ring));
          for (const p of placed) d = Math.min(d, pts[i].distanceTo(p));
          return d;
        };
        let best = h.step ?? RING_DIAGONALS[0];
        if (!this.drag || h.step === undefined) {
          const current = h.step !== undefined && RING_DIAGONALS.includes(h.step) ? score(h.step) : -Infinity;
          let top = -Infinity;
          for (const i of RING_DIAGONALS) {
            const s = score(i);
            if (s > top) [top, best] = [s, i];
          }
          if (h.step !== undefined && current >= 0 && current >= top * 0.8) best = h.step;
        }
        h.step = best;
        placed.push(pts[best]);
        // Screen direction of a positive turn at the arrow, and pixels per radian.
        const tangent = pts[(best + 1) % 72].clone().sub(pts[(best + 71) % 72]);
        const len = tangent.length();
        const u = len > 1e-6 ? tangent.clone().divideScalar(len) : new THREE.Vector2(1, 0);
        place(h.el, pts[best], u);
        const c = project(center);
        const dists = pts.map((p) => p.distanceTo(c));
        // Rings seen nearly face-on are turned by circling the centre; rings seen
        // nearly edge-on by pushing along the arrow.
        const faceOn = Math.min(...dists) > 0.45 * Math.max(...dists);
        const rel = pts[best].clone().sub(c);
        Object.assign(h, {
          u,
          pxPerMm: Math.max(len / ((2 * 2 * Math.PI) / 72), 80),
          faceOn,
          spin: rel.x * u.y - rel.y * u.x >= 0 ? 1 : -1,
        });
      });
    } else {
      // Screen rectangle around the projected box.
      const corners: THREE.Vector2[] = [];
      for (let i = 0; i < 8; i++) {
        corners.push(project(new THREE.Vector3(
          i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z,
        )));
      }
      const minX = Math.min(...corners.map((c) => c.x)), maxX = Math.max(...corners.map((c) => c.x));
      const minY = Math.min(...corners.map((c) => c.y)), maxY = Math.max(...corners.map((c) => c.y));
      Object.entries({ x: minX, y: minY, width: maxX - minX, height: maxY - minY })
        .forEach(([k, v]) => this.frame!.setAttribute(k, v.toFixed(1)));
      const rectCorners = [[minX, minY], [maxX, minY], [maxX, maxY], [minX, maxY]];
      for (const h of this.handles) {
        if (h.kind === 'corner') {
          h.el.setAttribute('cx', rectCorners[h.axis][0].toFixed(1));
          h.el.setAttribute('cy', rectCorners[h.axis][1].toFixed(1));
          continue;
        }
        const { s0, u, pxPerMm } = measure(h.axis, h.sign);
        place(h.el, s0.clone().addScaledVector(u, OFFSET * 0.6), u);
        Object.assign(h, { u, pxPerMm });
      }
    }
  }

  // --- Dragging -----------------------------------------------------------

  private local(e: PointerEvent): THREE.Vector2 {
    const r = this.viewport.element.getBoundingClientRect();
    return new THREE.Vector2(e.clientX - r.left, e.clientY - r.top);
  }

  private startDrag(e: PointerEvent, handle: Handle): void {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const targets = this.targetMeshes();
    const box = this.targetBox();
    const center = box.getCenter(new THREE.Vector3());
    const start = this.local(e);
    const screenCenter = handle.kind === 'corner'
      ? new THREE.Vector2(
          Number(this.frame!.getAttribute('x')) + Number(this.frame!.getAttribute('width')) / 2,
          Number(this.frame!.getAttribute('y')) + Number(this.frame!.getAttribute('height')) / 2,
        )
      : this.viewport.project(center);
    const angle = Math.atan2(start.y - screenCenter.y, start.x - screenCenter.x);
    this.drag = {
      handle,
      pointerId: e.pointerId,
      start,
      lastAngle: angle,
      angle: 0,
      targets,
      positions: targets.map((o) => o.position.clone()),
      quaternions: targets.map((o) => o.quaternion.clone()),
      scales: targets.map((o) => o.scale.clone()),
      box,
      center,
      screenCenter,
      others: this.doc.objects.filter((o) => !targets.includes(o.mesh)).map((o) => this.doc.worldBox([o])),
      u: handle.u.clone(),
      pxPerMm: handle.pxPerMm,
      checkpointed: false,
    };
    const el = e.currentTarget as SVGElement;
    el.setPointerCapture(e.pointerId);
    this.svg.classList.add('dragging');
    const move = (ev: PointerEvent) => this.onDrag(this.local(ev));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('pointercancel', up);
      this.svg.classList.remove('dragging');
      this.drag = undefined;
      this.changed();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('pointercancel', up);
  }

  private onDrag(p: THREE.Vector2): void {
    const d = this.drag!;
    if (!d.checkpointed) {
      if (p.distanceTo(d.start) < 2) return;
      // Nothing has moved yet, so this saves the pre-drag state for undo.
      this.doc.checkpoint();
      d.checkpointed = true;
    }
    const along = p.clone().sub(d.start).dot(d.u) / d.pxPerMm; // mm, in the handle's direction
    const { axis, sign } = d.handle;
    switch (d.handle.kind) {
      case 'move':
        this.applyMove(d, axis, along * sign);
        break;
      case 'rotate':
        this.applyRotate(d, p, along);
        break;
      case 'scale':
        this.applyAxisScale(d, axis, sign, along);
        break;
      case 'corner':
        this.applyUniformScale(d, p);
        break;
    }
    this.changed();
  }

  private applyMove(d: DragState, a: number, delta: number): void {
    const lo = d.box.min.getComponent(a), hi = d.box.max.getComponent(a);
    if (settings.snapping) {
      delta = Math.round(delta / MOVE_SNAP) * MOVE_SNAP;
      // Line faces up with nearby objects' faces only (snapping to something
      // far away would look like a random jump), the plate for height, and
      // the centre with the origin axis lines.
      const near = d.others.filter((b) => [0, 1, 2].every((k) => k === a
        || (b.min.getComponent(k) - d.box.max.getComponent(k) < NEAR && d.box.min.getComponent(k) - b.max.getComponent(k) < NEAR)));
      const candidates = near.flatMap((b) => [b.min.getComponent(a), b.max.getComponent(a)]);
      if (a === 2) candidates.push(0);
      const mid = (lo + hi) / 2;
      let best = FACE_SNAP;
      let snapped = delta;
      const consider = (target: number, edge: number) => {
        const diff = target - (edge + delta);
        if (Math.abs(diff) < best) {
          best = Math.abs(diff);
          snapped = delta + diff;
        }
      };
      for (const c of candidates) for (const edge of [lo, hi]) consider(c, edge);
      if (a !== 2) consider(0, mid);
      delta = snapped;
    }
    if (settings.collision) delta = this.limitByCollision(d, a, delta);
    d.targets.forEach((o, i) => {
      o.position.copy(d.positions[i]).addScaledVector(AXES[a], delta);
    });
  }

  /**
   * Stop before touching another object. Uses bounding boxes, so round
   * shapes stop a little early. Objects already overlapping at the start
   * of the drag are ignored so they can be pulled apart.
   */
  private limitByCollision(d: DragState, a: number, delta: number): number {
    const eps = 1e-3;
    for (const other of d.others) {
      let overlapsOtherAxes = true;
      for (let k = 0; k < 3; k++) {
        if (k === a) continue;
        if (d.box.max.getComponent(k) <= other.min.getComponent(k) + eps
          || d.box.min.getComponent(k) >= other.max.getComponent(k) - eps) overlapsOtherAxes = false;
      }
      if (!overlapsOtherAxes) continue;
      const lo = d.box.min.getComponent(a), hi = d.box.max.getComponent(a);
      const oLo = other.min.getComponent(a), oHi = other.max.getComponent(a);
      if (delta > 0 && oLo >= hi - eps) delta = Math.min(delta, oLo - hi);
      if (delta < 0 && oHi <= lo + eps) delta = Math.max(delta, oHi - lo);
    }
    return delta;
  }

  /**
   * Turn so the object follows the mouse: around the ring's centre when the
   * ring faces the viewer, or along the arrow when the ring is seen edge-on.
   * The direction comes from how the ring runs on screen at the arrow, so it
   * is right from any viewing angle.
   */
  private applyRotate(d: DragState, p: THREE.Vector2, along: number): void {
    const angle = Math.atan2(p.y - d.screenCenter.y, p.x - d.screenCenter.x);
    let step = angle - d.lastAngle;
    if (step > Math.PI) step -= Math.PI * 2;
    if (step < -Math.PI) step += Math.PI * 2;
    d.lastAngle = angle;
    d.angle += step;

    const axis = AXES[d.handle.axis];
    let rad = d.handle.faceOn ? (d.handle.spin ?? 1) * d.angle : along;
    if (settings.snapping) {
      const s = THREE.MathUtils.degToRad(ROTATE_SNAP);
      rad = Math.round(rad / s) * s;
    }
    const q = new THREE.Quaternion().setFromAxisAngle(axis, rad);
    d.targets.forEach((o, i) => {
      o.quaternion.copy(q).multiply(d.quaternions[i]);
      o.position.copy(d.positions[i]).sub(d.center).applyQuaternion(q).add(d.center);
    });
  }

  /** Resize along one axis; the opposite face stays where it is. */
  private applyAxisScale(d: DragState, a: number, sign: number, along: number): void {
    const startSize = d.box.max.getComponent(a) - d.box.min.getComponent(a);
    if (startSize <= 0) return;
    let newSize = startSize + along;
    if (settings.snapping) newSize = Math.round(newSize / SIZE_SNAP) * SIZE_SNAP;
    const f = Math.max(newSize, 0.1) / startSize;
    const anchor = sign > 0 ? d.box.min.getComponent(a) : d.box.max.getComponent(a);
    if (this.keepProportions) {
      // Same factor everywhere; the dragged side's opposite face and the bottom stay put.
      const pivot = new THREE.Vector3(d.center.x, d.center.y, d.box.min.z).setComponent(a, anchor);
      d.targets.forEach((o, i) => {
        o.position.copy(d.positions[i]).sub(pivot).multiplyScalar(f).add(pivot);
        o.scale.copy(d.scales[i]).multiplyScalar(f);
      });
      return;
    }
    d.targets.forEach((o, i) => {
      const pos = d.positions[i].clone();
      pos.setComponent(a, anchor + (pos.getComponent(a) - anchor) * f);
      o.position.copy(pos);
      // Stretch the object's own axis that lines up best with the world axis.
      const rot = new THREE.Matrix4().makeRotationFromQuaternion(d.quaternions[i]).elements;
      const k = [0, 1, 2].reduce((best, c) => (Math.abs(rot[c * 4 + a]) > Math.abs(rot[best * 4 + a]) ? c : best), 0);
      o.scale.copy(d.scales[i]).setComponent(k, d.scales[i].getComponent(k) * f);
    });
  }

  /** Corner dots: same factor on every axis; the bottom stays on the plate. */
  private applyUniformScale(d: DragState, p: THREE.Vector2): void {
    const startDist = d.start.distanceTo(d.screenCenter);
    if (startDist < 1) return;
    const f = Math.max(p.distanceTo(d.screenCenter) / startDist, 0.01);
    const anchor = new THREE.Vector3(d.center.x, d.center.y, d.box.min.z);
    d.targets.forEach((o, i) => {
      o.position.copy(d.positions[i]).sub(anchor).multiplyScalar(f).add(anchor);
      o.scale.copy(d.scales[i]).multiplyScalar(f);
    });
  }
}
