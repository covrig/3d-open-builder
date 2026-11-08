import * as THREE from 'three';
import type { Piece } from '../geometry/cut';
import { runOp } from '../geometry/workerClient';
import type { SceneDocument, SceneObject } from '../scene/document';
import type { Gizmo } from '../scene/gizmo';
import type { Viewport } from '../scene/viewport';
import { fromUnit, settings, toUnit } from '../settings';
import { hideHint, showHint } from './hint';
import { beginTool, endTool } from './toolLock';

type Axis = 0 | 1 | 2;
type Keep = 'both' | 'positive' | 'negative';
const AXES = [new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1)];
const SIDE_NAMES: Record<Axis, [string, string]> = {
  0: ['Right', 'Left'],
  1: ['Back', 'Front'],
  2: ['Top', 'Bottom'],
};
const SVG_NS = 'http://www.w3.org/2000/svg';
const PLANE_COLOR = 0xf2a33a;

/**
 * Split mode: a cutting plane through the selected object. The user picks a
 * starting direction (X, Y, Z), tilts it, slides it with the slider or the
 * arrow on the plane, chooses which pieces to keep and presses Apply.
 */
export class SplitTool {
  private target?: SceneObject;
  private axis: Axis = 2;
  private tiltA = 0; // degrees around the first in-plane axis
  private tiltB = 0; // degrees around the second in-plane axis
  /** Plane offset: signed distance from the world origin along the normal. */
  private offset = 0;
  private keep: Keep = 'both';
  private readonly plane: THREE.Mesh<THREE.PlaneGeometry, THREE.MeshBasicMaterial>;
  private readonly bar: HTMLElement;
  private readonly range: HTMLInputElement;
  private readonly value: HTMLInputElement;
  private readonly tiltInputs: [HTMLInputElement, HTMLInputElement];
  private readonly handleSvg: SVGSVGElement;
  private readonly handle: SVGPolygonElement;
  private handleDir = new THREE.Vector2(1, 0);
  private handlePxPerMm = 1;
  /** The part that Apply will throw away, drawn see-through grey */
  private readonly ghost: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly keepClip = new THREE.Plane();
  private readonly dropClip = new THREE.Plane();

  constructor(
    private readonly viewport: Viewport,
    private readonly doc: SceneDocument,
    private readonly gizmo: Gizmo,
    /** Runs a background geometry job and applies its result (shared busy guard). */
    private readonly heavy: <T>(objs: SceneObject[], compute: () => Promise<T>, apply: (r: T) => void) => Promise<void>,
    private readonly toast: (msg: string) => void,
  ) {
    const q = <T extends HTMLElement>(sel: string) => this.bar.querySelector<T>(sel)!;
    this.bar = document.querySelector<HTMLElement>('#split-bar')!;
    this.range = q('#split-range');
    this.value = q('#split-value');
    this.tiltInputs = [q('#split-tilt-a'), q('#split-tilt-b')];

    this.plane = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1),
      new THREE.MeshBasicMaterial({ color: PLANE_COLOR, transparent: true, opacity: 0.3, side: THREE.DoubleSide, depthWrite: false }),
    );
    this.plane.add(new THREE.LineSegments(
      new THREE.EdgesGeometry(new THREE.PlaneGeometry(1, 1)),
      new THREE.LineBasicMaterial({ color: PLANE_COLOR }),
    ));
    this.plane.visible = false;
    viewport.scene.add(this.plane);

    viewport.renderer.localClippingEnabled = true;
    this.ghost = new THREE.Mesh(
      new THREE.BufferGeometry(),
      new THREE.MeshBasicMaterial({
        color: 0x8f98a3, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide,
        clippingPlanes: [this.dropClip],
      }),
    );
    this.ghost.visible = false;
    this.ghost.raycast = () => {};
    viewport.scene.add(this.ghost);

    // Drag handle: a double arrow at the plane centre, along the normal.
    this.handleSvg = document.createElementNS(SVG_NS, 'svg');
    this.handleSvg.classList.add('gizmo');
    this.handleSvg.style.display = 'none';
    this.handle = document.createElementNS(SVG_NS, 'polygon');
    this.handle.setAttribute('points', '-20,0 -11,-7 -11,-2 11,-2 11,-7 20,0 11,7 11,2 -11,2 -11,7');
    this.handle.setAttribute('fill', '#f2a33a');
    this.handle.classList.add('handle');
    this.handleSvg.append(this.handle);
    viewport.element.append(this.handleSvg);
    this.handle.addEventListener('pointerdown', (e) => this.startDrag(e));
    viewport.onFrame(() => this.updateHandle());

    for (const b of this.bar.querySelectorAll<HTMLButtonElement>('[data-split-axis]')) {
      b.addEventListener('click', () => this.setAxis(Number(b.dataset.splitAxis) as Axis));
    }
    for (const b of this.bar.querySelectorAll<HTMLButtonElement>('[data-split-keep]')) {
      b.addEventListener('click', () => this.setKeep(b.dataset.splitKeep as Keep));
    }
    this.range.addEventListener('input', () => this.setOffset(fromUnit(Number(this.range.value))));
    this.value.addEventListener('change', () => this.setOffset(fromUnit(Number(this.value.value))));
    this.tiltInputs.forEach((input, i) =>
      input.addEventListener('change', () => {
        const v = THREE.MathUtils.clamp(Number(input.value) || 0, -90, 90);
        if (i === 0) this.tiltA = v;
        else this.tiltB = v;
        input.value = String(v);
        this.updatePlane(true);
      }),
    );
    q('[data-split="apply"]').addEventListener('click', () => this.apply());
    q('[data-split="cancel"]').addEventListener('click', () => this.stop());
    doc.addEventListener('selection', () => {
      if (this.target && !(doc.selection.length === 1 && doc.selection[0] === this.target)) this.stop();
    });
  }

  get active(): boolean {
    return this.target !== undefined;
  }

  start(): void {
    if (this.doc.selection.length !== 1) return this.toast('Select one object to split');
    beginTool('split', () => this.stop());
    this.target = this.doc.selection[0];
    this.gizmo.enabled = false;
    this.bar.hidden = false;
    this.plane.visible = true;
    showHint('split', 'Split: slide or drag the orange plane, choose what to keep, then Apply. Esc to cancel.');
    this.setKeep('both');
    this.setAxis(this.axis);
  }

  stop(): void {
    endTool('split');
    this.showDropped(false);
    this.target = undefined;
    this.gizmo.enabled = true;
    this.bar.hidden = true;
    this.plane.visible = false;
    this.handleSvg.style.display = 'none';
    hideHint('split');
    this.viewport.invalidate();
  }

  private box(): THREE.Box3 {
    return this.doc.worldBox([this.target!]);
  }

  /** Plane normal: the chosen axis tilted by the two angles. */
  private normal(): THREE.Vector3 {
    const e1 = AXES[(this.axis + 1) % 3], e2 = AXES[(this.axis + 2) % 3];
    return AXES[this.axis].clone()
      .applyAxisAngle(e1, THREE.MathUtils.degToRad(this.tiltA))
      .applyAxisAngle(e2, THREE.MathUtils.degToRad(this.tiltB))
      .normalize();
  }

  /** Offsets where the plane still touches the object. */
  private limits(): [number, number] {
    const box = this.box();
    const n = this.normal();
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < 8; i++) {
      const c = new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z);
      const d = c.dot(n);
      lo = Math.min(lo, d);
      hi = Math.max(hi, d);
    }
    return [lo, hi];
  }

  private setAxis(axis: Axis): void {
    this.axis = axis;
    this.tiltA = this.tiltB = 0;
    this.tiltInputs.forEach((i) => (i.value = '0'));
    for (const b of this.bar.querySelectorAll<HTMLButtonElement>('[data-split-axis]')) {
      b.classList.toggle('active', Number(b.dataset.splitAxis) === axis);
    }
    const [pos, neg] = SIDE_NAMES[axis];
    this.bar.querySelector('[data-split-keep="positive"]')!.textContent = pos;
    this.bar.querySelector('[data-split-keep="negative"]')!.textContent = neg;
    this.bar.querySelector('.unit')!.textContent = settings.unit;
    this.updatePlane(true);
  }

  private setKeep(keep: Keep): void {
    this.keep = keep;
    for (const b of this.bar.querySelectorAll<HTMLButtonElement>('[data-split-keep]')) {
      b.classList.toggle('active', b.dataset.splitKeep === keep);
    }
    this.updateDropped();
  }

  /**
   * Show what Apply keeps: the object is cut away at the plane on the side
   * that will be removed, and that side is drawn as a see-through grey ghost.
   */
  private updateDropped(): void {
    const obj = this.target;
    if (!obj || this.keep === 'both') return this.showDropped(false);
    const n = this.normal();
    const sign = this.keep === 'positive' ? 1 : -1;
    // A plane keeps the side where normal · p + constant >= 0.
    this.keepClip.set(n.clone().multiplyScalar(sign), -sign * this.offset);
    this.dropClip.set(n.clone().multiplyScalar(-sign), sign * this.offset);
    obj.mesh.material.clippingPlanes = [this.keepClip];
    this.ghost.geometry = obj.mesh.geometry;
    obj.mesh.updateMatrixWorld();
    this.ghost.matrixAutoUpdate = false;
    this.ghost.matrix.copy(obj.mesh.matrixWorld);
    this.ghost.matrixWorldNeedsUpdate = true;
    this.ghost.visible = true;
    this.viewport.invalidate();
  }

  private showDropped(on: boolean): void {
    if (!on) {
      if (this.target) this.target.mesh.material.clippingPlanes = null;
      this.ghost.visible = false;
      this.ghost.geometry = new THREE.BufferGeometry();
    }
    this.viewport.invalidate();
  }

  /** Re-orient the plane; with recentre, put it through the middle of the object. */
  private updatePlane(recentre: boolean): void {
    const [lo, hi] = this.limits();
    this.range.min = String(toUnit(lo));
    this.range.max = String(toUnit(hi));
    this.range.step = String(toUnit(Math.max((hi - lo) / 400, 0.01)));
    const size = this.box().getSize(new THREE.Vector3()).length() * 1.2;
    this.plane.scale.set(size, size, 1);
    this.plane.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.normal());
    this.setOffset(recentre ? (lo + hi) / 2 : this.offset);
  }

  private setOffset(offset: number): void {
    if (!Number.isFinite(offset)) return;
    const [lo, hi] = this.limits();
    this.offset = THREE.MathUtils.clamp(offset, lo, hi);
    // Put the plane where the object's centre line crosses it.
    const n = this.normal();
    const center = this.box().getCenter(new THREE.Vector3());
    this.plane.position.copy(center).addScaledVector(n, this.offset - center.dot(n));
    this.range.value = String(toUnit(this.offset));
    this.updateDropped();
    this.viewport.invalidate();
    if (document.activeElement !== this.value) this.value.value = String(Math.round(toUnit(this.offset) * 100) / 100);
  }

  private updateHandle(): void {
    if (!this.target) return;
    this.handleSvg.style.display = '';
    const p = this.plane.position;
    const s0 = this.viewport.project(p);
    const ref = 10;
    const dir = this.viewport.project(p.clone().addScaledVector(this.normal(), ref)).sub(s0);
    const len = dir.length();
    this.handleDir = len > 1e-6 ? dir.divideScalar(len) : new THREE.Vector2(0, -1);
    this.handlePxPerMm = Math.max(len / ref, 1e-3);
    const deg = THREE.MathUtils.radToDeg(Math.atan2(this.handleDir.y, this.handleDir.x));
    this.handle.setAttribute('transform', `translate(${s0.x.toFixed(1)},${s0.y.toFixed(1)}) rotate(${deg.toFixed(1)})`);
  }

  private startDrag(e: PointerEvent): void {
    e.preventDefault();
    e.stopPropagation();
    const r = this.viewport.element.getBoundingClientRect();
    const start = new THREE.Vector2(e.clientX - r.left, e.clientY - r.top);
    const startOffset = this.offset;
    const dir = this.handleDir.clone();
    const px = this.handlePxPerMm;
    this.handle.setPointerCapture(e.pointerId);
    const move = (ev: PointerEvent) => {
      const p = new THREE.Vector2(ev.clientX - r.left, ev.clientY - r.top);
      this.setOffset(startOffset + p.sub(start).dot(dir) / px);
    };
    const up = () => {
      this.handle.removeEventListener('pointermove', move);
      this.handle.removeEventListener('pointerup', up);
    };
    this.handle.addEventListener('pointermove', move);
    this.handle.addEventListener('pointerup', up);
  }

  private apply(): void {
    const obj = this.target!;
    const keep = this.keep;
    void this.heavy(
      [obj],
      () => runOp('split', { item: this.doc.placed(obj), normal: this.normal().toArray(), offset: this.offset }),
      (result) => this.finish(obj, keep, result),
    );
  }

  private finish(obj: SceneObject, keep: Keep, result: { positive: Piece | null; negative: Piece | null }): void {
    if (!result.positive || !result.negative) return this.toast('Move the plane so it cuts through the object');
    const pieces = [
      keep !== 'negative' ? result.positive : null,
      keep !== 'positive' ? result.negative : null,
    ].filter((p) => p !== null);
    this.doc.checkpoint();
    this.stop();
    const base = obj.name.replace(/ \d+$/, '');
    const color = obj.color;
    this.doc.remove([obj]);
    const added = pieces.map((p, i) => {
      // The second piece gets a new colour so the two are easy to tell apart.
      const o = this.doc.add(base, p.mesh, i === 0 ? color : undefined);
      o.mesh.position.set(...p.center);
      return o;
    });
    this.doc.setSelection(added);
  }
}
