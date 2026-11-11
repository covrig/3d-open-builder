import * as THREE from 'three';
import type { Piece } from '../geometry/cut';
import { runOp } from '../geometry/workerClient';
import type { SceneDocument, SceneObject } from '../scene/document';
import { AXIS_COLORS, type Gizmo } from '../scene/gizmo';
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
 * Split mode: a cutting plane through the selected objects (one object, a
 * group, or several). The user picks a starting direction (X, Y, Z), tilts
 * it, slides it with the slider or the arrow on the plane, chooses which
 * pieces to keep and presses Apply. Every object the plane crosses is split;
 * the pieces of a group on each side form a group of their own.
 */
export class SplitTool {
  private targets: SceneObject[] = [];
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
  /** The parts that Apply will throw away, drawn see-through grey (one per object) */
  private ghosts: THREE.Mesh[] = [];
  private readonly ghostMaterial: THREE.MeshBasicMaterial;
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
    this.ghostMaterial = new THREE.MeshBasicMaterial({
      color: 0x8f98a3, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide,
      clippingPlanes: [this.dropClip],
    });

    // Drag handle: a double arrow at the plane centre, along the normal.
    this.handleSvg = document.createElementNS(SVG_NS, 'svg');
    this.handleSvg.classList.add('gizmo');
    this.handleSvg.style.display = 'none';
    this.handle = document.createElementNS(SVG_NS, 'polygon');
    this.handle.setAttribute('points', '-20,0 -11,-7 -11,-2 11,-2 11,-7 20,0 11,7 11,2 -11,2 -11,7');
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
    // The tool works on what was selected; if that changes some other way (an undo elsewhere), it closes.
    doc.addEventListener('selection', () => {
      const same = doc.selection.length === this.targets.length && this.targets.every((o) => doc.selection.includes(o));
      if (this.targets.length && !same) this.stop();
    });
  }

  get active(): boolean {
    return this.targets.length > 0;
  }

  start(): void {
    if (this.doc.selection.length === 0) return this.toast('Select the objects to split');
    beginTool('split', () => this.stop());
    this.targets = [...this.doc.selection];
    this.gizmo.enabled = false;
    // Everything not being split fades back, so the split objects stand out.
    this.doc.setFaded(this.doc.objects.filter((o) => !this.targets.includes(o) && !o.hidden));
    this.bar.hidden = false;
    this.plane.visible = true;
    showHint('split', 'Split: slide or drag the orange plane, choose what to keep, then Apply.');
    this.setKeep('both');
    this.setAxis(this.axis);
  }

  /** Apply, if the tool is open and Apply is enabled (for the Enter key). */
  applyIfOpen(): void {
    if (!this.active || this.bar.querySelector<HTMLButtonElement>('[data-split="apply"]')?.disabled) return;
    this.apply();
  }

  stop(): void {
    // Only an open Split may clear the fading (stop() is also called when it isn't open).
    if (this.active) this.doc.setFaded(null);
    endTool('split');
    this.showDropped(false);
    this.targets = [];
    this.gizmo.enabled = true;
    this.bar.hidden = true;
    this.plane.visible = false;
    this.handleSvg.style.display = 'none';
    hideHint('split');
    this.viewport.invalidate();
  }

  private box(): THREE.Box3 {
    return this.doc.worldBox(this.targets);
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
    // The arrow takes its axis's colour (as on the move handles), so it stands out from the orange plane.
    this.handle.setAttribute('fill', AXIS_COLORS[axis]);
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
   * Show what Apply keeps: the objects are cut away at the plane on the side
   * that will be removed, and that side is drawn as a see-through grey ghost.
   */
  private updateDropped(): void {
    if (!this.targets.length || this.keep === 'both') return this.showDropped(false);
    const n = this.normal();
    const sign = this.keep === 'positive' ? 1 : -1;
    // A plane keeps the side where normal · p + constant >= 0.
    this.keepClip.set(n.clone().multiplyScalar(sign), -sign * this.offset);
    this.dropClip.set(n.clone().multiplyScalar(-sign), sign * this.offset);
    if (this.ghosts.length !== this.targets.length) {
      this.clearGhosts();
      this.ghosts = this.targets.map((obj) => {
        const ghost = new THREE.Mesh(obj.mesh.geometry, this.ghostMaterial);
        ghost.matrixAutoUpdate = false;
        ghost.raycast = () => {};
        this.viewport.scene.add(ghost);
        return ghost;
      });
    }
    this.targets.forEach((obj, i) => {
      obj.mesh.material.clippingPlanes = [this.keepClip];
      obj.mesh.updateMatrixWorld();
      this.ghosts[i].matrix.copy(obj.mesh.matrixWorld);
      this.ghosts[i].matrixWorldNeedsUpdate = true;
    });
    this.viewport.invalidate();
  }

  private clearGhosts(): void {
    for (const g of this.ghosts) this.viewport.scene.remove(g);
    this.ghosts = [];
  }

  private showDropped(on: boolean): void {
    if (!on) {
      for (const obj of this.targets) obj.mesh.material.clippingPlanes = null;
      this.clearGhosts();
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
    if (!this.targets.length) return;
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
      this.handle.removeEventListener('pointercancel', up);
      this.handle.removeEventListener('lostpointercapture', up);
    };
    this.handle.addEventListener('pointermove', move);
    this.handle.addEventListener('pointerup', up);
    this.handle.addEventListener('pointercancel', up);
    this.handle.addEventListener('lostpointercapture', up);
  }

  private apply(): void {
    const objs = [...this.targets];
    const keep = this.keep;
    const normal = this.normal().toArray();
    const offset = this.offset;
    void this.heavy(
      objs,
      () => Promise.all(objs.map((o) => runOp('split', { item: this.doc.placed(o), normal, offset }))),
      (results) => this.finish(objs, keep, results),
    );
  }

  /**
   * Every object the plane crosses is replaced by its pieces; objects wholly
   * on one side stay as they are (or go, if that side is not kept). The pieces
   * and whole objects of a group on each side form a group of their own.
   */
  private finish(objs: SceneObject[], keep: Keep, results: { positive: Piece | null; negative: Piece | null }[]): void {
    if (!results.some((r) => r.positive && r.negative)) {
      return this.toast(objs.length > 1 ? 'Move the plane so it cuts through the objects' : 'Move the plane so it cuts through the object');
    }
    this.doc.checkpoint();
    this.stop();
    const removed: SceneObject[] = [];
    const kept: SceneObject[] = [];
    // Side lists per original group (or per object without a group).
    const groupKey = (o: SceneObject) => (o.groupId !== undefined ? `g${o.groupId}` : `o${o.id}`);
    const bySide = { positive: new Map<string, SceneObject[]>(), negative: new Map<string, SceneObject[]>() };
    const add = (side: 'positive' | 'negative', from: SceneObject, o: SceneObject) => {
      const list = bySide[side].get(groupKey(from)) ?? [];
      list.push(o);
      bySide[side].set(groupKey(from), list);
      kept.push(o);
    };
    objs.forEach((obj, i) => {
      const r = results[i];
      for (const side of ['positive', 'negative'] as const) {
        const piece = r[side];
        const wanted = keep === 'both' || keep === side;
        if (!piece || !wanted) continue;
        if (!r.positive || !r.negative) {
          add(side, obj, obj); // wholly on this side: stays as it is
          continue;
        }
        // A cut object's second piece gets a new colour, so the two are easy to tell apart (when not in a group).
        const fresh = side === 'negative' && keep === 'both' && obj.groupId === undefined;
        const o = this.doc.add(obj.name.replace(/ \d+$/, ''), piece.mesh, fresh ? undefined : obj.color);
        o.mesh.position.set(...piece.center);
        add(side, obj, o);
      }
      const whole = !r.positive || !r.negative;
      const onKeptSide = keep === 'both' || (keep === 'positive' ? !!r.positive : !!r.negative);
      if (!whole || !onKeptSide) removed.push(obj);
    });
    this.doc.remove(removed);
    for (const side of ['positive', 'negative'] as const) {
      for (const list of bySide[side].values()) {
        if (list.length > 1) this.doc.group(list);
      }
    }
    this.doc.setSelection(kept.filter((o) => this.doc.objects.includes(o)));
  }}
