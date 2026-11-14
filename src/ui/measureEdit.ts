import * as THREE from 'three';
import type { Measurement, MeasurePoint, SceneDocument, SceneObject } from '../scene/document';
import { isAxisAligned, scaleObjects } from '../scene/resize';
import { fromUnit, lockEvents, setKeepProportions, settings, toUnit } from '../settings';
import { setIcon } from './icons';
import { circleThrough } from './measureTool';
import { parseNumber } from './numberInputs';
import { BUSY_MESSAGE, LOCKED_MESSAGE } from './toolGuard';
import { isBusy, isLocked } from './toolLock';

/** What typing a new value for a measured distance does. */
export type DistanceEdit =
  | { kind: 'scale'; objs: SceneObject[]; factor: THREE.Vector3; note?: string }
  | { kind: 'move'; objs: SceneObject[]; delta: THREE.Vector3 }
  | { kind: 'refuse'; message: string };

/** A scale factor beyond these is refused (a typing slip, e.g. an extra zero). */
const MIN_FACTOR = 1e-3;
const MAX_FACTOR = 1e3;

/** The objects that move and resize together with this one: its whole group, or just itself. */
function unitOf(doc: Pick<SceneDocument, 'objects'>, obj: SceneObject): SceneObject[] {
  return obj.groupId === undefined ? [obj] : doc.objects.filter((o) => o.groupId === obj.groupId);
}

/** A part of a measurement this small (sine of 1 degree) is taken as not there: the line runs along the other axes. */
const SIN_1 = Math.sin((1 * Math.PI) / 180);

/** What a measurement measures now, in mm (a distance, or a circle's diameter), or null if its objects are gone. */
export function measuredValue(m: Measurement, world: (p: MeasurePoint) => THREE.Vector3 | null): number | null {
  const pts = m.points.map(world);
  if (pts.some((p) => p === null)) return null;
  const w = pts as THREE.Vector3[];
  if (m.kind === 'distance' && w.length === 2) return w[0].distanceTo(w[1]);
  if (m.kind === 'circle' && w.length === 3) {
    const c = circleThrough(w[0], w[1], w[2]);
    return c ? c.radius * 2 : null;
  }
  return null;
}

/** Do the points sit on different objects (typing then moves the second one instead of resizing)? */
export function movesObjects(doc: Pick<SceneDocument, 'objects'>, m: Measurement): boolean {
  if (m.kind !== 'distance' || m.points.length !== 2) return false;
  const objA = doc.objects.find((o) => o.id === m.points[0].objectId);
  const objB = doc.objects.find((o) => o.id === m.points[1].objectId);
  return !!objA && !!objB && objA !== objB && (objA.groupId === undefined || objA.groupId !== objB.groupId);
}

/**
 * How to stretch the objects so a measured size becomes `typed`. `axes` are the axes the
 * measurement spans and `rest` the squared length of its part along the others.
 * With the proportion lock on, or when it spans all three axes, everything is scaled evenly.
 * Otherwise only those axes are stretched, by the factor that makes the new size exactly `typed`
 * (the part of the line along the other axes keeps its length).
 */
function stretchFor(
  objs: SceneObject[], current: number, typed: number, keepProportions: boolean, axes: number[], rest: number,
): DistanceEdit {
  const refuse = (message: string): DistanceEdit => ({ kind: 'refuse', message });
  const even = new THREE.Vector3().setScalar(typed / current);
  if (typed / current < MIN_FACTOR || typed / current > MAX_FACTOR) return refuse('That is far from the measured size: check the number');
  if (keepProportions || axes.length === 3 || axes.length === 0) return { kind: 'scale', objs, factor: even };
  // Stretching some axes of an object turned off the axes would change its mesh (and the measured points
  // would no longer fit it): those are resized evenly instead.
  if (!objs.every((o) => isAxisAligned(o.mesh.quaternion))) return { kind: 'scale', objs, factor: even, note: 'Resized evenly: the object is turned' };
  const spanned = current * current - rest;
  const wanted = typed * typed - rest;
  if (wanted <= 0) return refuse('Too small: part of this distance runs along axes that are not stretched');
  const f = new THREE.Vector3(1, 1, 1);
  for (const k of axes) f.setComponent(k, Math.sqrt(wanted / spanned));
  if (f.toArray().some((x) => x < MIN_FACTOR || x > MAX_FACTOR)) return refuse('That is far from the measured size: check the number');
  return { kind: 'scale', objs, factor: f };
}

/**
 * Work out what typing `typed` (mm) for a measurement does:
 * - a distance with both points on one object (or group), or a circle on one object: resize it so the
 *   size becomes `typed`; evenly with the proportion lock on, otherwise only along the axes the line
 *   (or the circle's plane) spans;
 * - a distance between two different objects: move the second object (with its group) along the
 *   line until the distance is `typed`.
 */
export function planMeasureEdit(
  doc: Pick<SceneDocument, 'objects'>,
  m: Measurement,
  world: (p: MeasurePoint) => THREE.Vector3 | null,
  typed: number,
  keepProportions: boolean,
): DistanceEdit {
  const refuse = (message: string): DistanceEdit => ({ kind: 'refuse', message });
  if (m.kind === 'angle') return refuse('An angle cannot be typed');
  if (!Number.isFinite(typed) || typed <= 0) return refuse('Type a size above 0');
  const current = measuredValue(m, world);
  if (current === null) return refuse('An object of this measurement is gone');
  if (current < 1e-6) return refuse('Nothing to resize: the size is 0');
  const objs = m.points.map((p) => doc.objects.find((o) => o.id === p.objectId));
  if (objs.some((o) => !o)) return refuse('The points are not on objects, so there is nothing to change');
  const first = objs[0]!;
  const sameUnit = objs.every((o) => o === first || (first.groupId !== undefined && o!.groupId === first.groupId));

  if (m.kind === 'circle') {
    if (!sameUnit) return refuse('The three points are on different objects: measure the circle on one object');
    const w = m.points.map((p) => world(p)!);
    const c = circleThrough(w[0], w[1], w[2])!;
    // Lock off: a circle in a plane of the axes is stretched along those two axes (the third is its normal).
    const normalAxis = [0, 1, 2].find((k) => Math.abs(c.normal.getComponent(k)) > Math.cos((1 * Math.PI) / 180));
    const axes = normalAxis === undefined ? [] : [0, 1, 2].filter((k) => k !== normalAxis);
    return stretchFor(unitOf(doc, first), current, typed, keepProportions, axes, 0);
  }

  const a = world(m.points[0])!, b = world(m.points[1])!;
  const v = b.clone().sub(a);
  if (sameUnit) {
    // The axes the line runs along; what lies along the others (under a degree off) keeps its length.
    const axes = [0, 1, 2].filter((k) => Math.abs(v.getComponent(k)) / current > SIN_1);
    const rest = [0, 1, 2].filter((k) => !axes.includes(k)).reduce((s, k) => s + v.getComponent(k) ** 2, 0);
    return stretchFor(unitOf(doc, first), current, typed, keepProportions, axes, rest);
  }
  return { kind: 'move', objs: unitOf(doc, objs[1]!), delta: v.divideScalar(current).multiplyScalar(typed - current) };
}

/** Do the edit as one undo step. */
export function applyDistanceEdit(doc: SceneDocument, edit: Exclude<DistanceEdit, { kind: 'refuse' }>): void {
  doc.transact(() => {
    if (edit.kind === 'scale') scaleObjects(doc, edit.objs, edit.factor);
    else for (const o of edit.objs) o.mesh.position.add(edit.delta);
    doc.emit('transform');
  });
}

const fmt = (mm: number) => String(+toUnit(mm).toFixed(3));

/**
 * A small box that opens on a distance label: type the distance you want and
 * the objects are resized (or moved) to match. Enter or the tick applies; Esc,
 * the cross or a click elsewhere closes it. It lives beside the labels, so
 * redrawing them (turning the view) does not close it.
 */
export class DistanceEditor {
  private readonly box = document.createElement('div');
  private readonly input = document.createElement('input');
  private readonly unit = document.createElement('span');
  private readonly lock = document.createElement('button');
  private readonly diameter = document.createElement('span');
  private measurement: Measurement | null = null;

  constructor(
    private readonly host: HTMLElement,
    private readonly doc: SceneDocument,
    private readonly world: (p: MeasurePoint) => THREE.Vector3 | null,
    private readonly toast: (message: string) => void,
  ) {
    this.box.className = 'm-edit';
    this.box.hidden = true;
    this.input.type = 'text';
    this.input.inputMode = 'decimal';
    this.input.setAttribute('aria-label', 'Distance');
    this.unit.className = 'unit';
    this.diameter.className = 'unit';
    this.diameter.textContent = 'Ø';
    // The same proportion lock as the size fields: locked resizes evenly, unlocked only along the axes the measurement spans.
    this.lock.type = 'button';
    this.lock.className = 'm-lock';
    this.lock.addEventListener('click', () => setKeepProportions(!settings.ui.keepProportions));
    lockEvents.addEventListener('change', () => this.showLock());
    this.showLock();
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.textContent = '✓';
    ok.setAttribute('aria-label', 'Apply the distance');
    const no = document.createElement('button');
    no.type = 'button';
    no.dataset.no = '';
    no.textContent = '✕';
    no.setAttribute('aria-label', 'Close');
    this.box.append(this.diameter, this.input, this.unit, this.lock, ok, no);
    host.append(this.box);
    ok.addEventListener('click', () => this.apply());
    no.addEventListener('click', () => this.close());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        this.apply();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.close();
      }
    });
    // A click anywhere else closes it (capture: before the view reacts to the click).
    document.addEventListener('pointerdown', (e) => {
      if (!this.box.hidden && !this.box.contains(e.target as Node) && !(e.target as HTMLElement).closest?.('.m-label[data-m]')) this.close();
    }, true);
  }

  get active(): boolean {
    return !this.box.hidden;
  }

  /** Open on a measurement, near the label's screen rectangle. */
  open(m: Measurement, at: DOMRect): void {
    if (isLocked()) return this.toast(LOCKED_MESSAGE);
    if (isBusy()) return this.toast(BUSY_MESSAGE);
    const size = measuredValue(m, this.world);
    if (size === null) return;
    this.measurement = m;
    this.unit.textContent = settings.unit;
    this.diameter.hidden = m.kind !== 'circle';
    // Moving a second object has nothing to do with proportions.
    this.lock.hidden = movesObjects(this.doc, m);
    this.input.value = fmt(size);
    this.box.hidden = false;
    const view = this.host.getBoundingClientRect();
    const w = this.box.offsetWidth, h = this.box.offsetHeight;
    const x = Math.min(Math.max(at.left + at.width / 2 - view.left, w / 2 + 4), Math.max(w / 2 + 4, view.width - w / 2 - 4));
    const y = Math.min(Math.max(at.top - view.top - 6, h + 4), Math.max(h + 4, view.height - 4));
    this.box.style.left = `${x}px`;
    this.box.style.top = `${y}px`;
    this.input.focus();
    this.input.select();
  }

  private showLock(): void {
    const keep = settings.ui.keepProportions;
    this.lock.classList.toggle('active', keep);
    setIcon(this.lock, keep ? 'lock' : 'lock-open');
    this.lock.title = keep ? 'Proportions locked: the whole object is resized evenly. Click to unlock.' : 'Unlocked: only the axes this measurement runs along are stretched. Click to lock.';
    this.lock.setAttribute('aria-label', this.lock.title);
    this.lock.setAttribute('aria-pressed', String(keep));
  }

  close(): void {
    this.box.hidden = true;
    this.measurement = null;
  }

  private apply(): void {
    const m = this.measurement;
    if (!m || !this.doc.measurements.includes(m)) return this.close();
    if (isLocked()) return this.toast(LOCKED_MESSAGE);
    if (isBusy()) return this.toast(BUSY_MESSAGE);
    const typed = parseNumber(this.input.value);
    if (!Number.isFinite(typed)) return this.toast('Type a number');
    const edit = planMeasureEdit(this.doc, m, this.world, fromUnit(typed), settings.ui.keepProportions);
    if (edit.kind === 'refuse') return this.toast(edit.message);
    applyDistanceEdit(this.doc, edit);
    if (edit.kind === 'scale' && edit.note) this.toast(edit.note);
    this.close();
  }
}
