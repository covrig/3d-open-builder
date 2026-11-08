import * as THREE from 'three';
import type { MeshData } from '../geometry/meshData';
import { buildGeometry, type SceneDocument, type SceneObject } from '../scene/document';
import type { Gizmo } from '../scene/gizmo';
import type { Viewport } from '../scene/viewport';
import { hideHint, showHint } from './hint';
import { beginTool, endTool } from './toolLock';

export interface Field {
  key: string;
  label: string;
  type: 'number' | 'select' | 'checkbox' | 'text' | 'button';
  /** For type 'button': what clicking it does */
  onClick?: () => void;
  value: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
  unit?: string;
  options?: [string, string][];
  tip?: string;
  /** Put the field on its own line just above Apply, highlighted (e.g. the text to emboss) */
  prominent?: boolean;
  /** Show only when another field has this value */
  showIf?: [string, string];
}

export type Values = Record<string, number | string | boolean>;

export interface FeatureSpec<R> {
  title: string;
  hint: string;
  fields: Field[];
  /** Objects hidden while the preview shows (their replacement is previewed instead). */
  hide?: SceneObject[];
  /**
   * Objects the tool works on (default: the hidden ones). If one is deleted
   * or its shape is replaced (e.g. by undo), the tool closes.
   */
  targets?: SceneObject[];
  /** Compute the result for the current values (usually in the worker). Return null for "nothing yet". */
  compute(values: Values): Promise<R | null>;
  /** Objects to show as the preview. */
  show(result: R): THREE.Object3D[];
  apply(result: R, values: Values): void;
  /** Called when the bar closes (Apply or Cancel). */
  onClose?(): void;
}

const ghost = new THREE.MeshStandardMaterial({
  color: 0xf2a33a, transparent: true, opacity: 0.75, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -1,
});

/** Preview mesh for world-space geometry centred at `center`. */
export function previewMesh(mesh: MeshData, center: [number, number, number]): THREE.Mesh {
  const m = new THREE.Mesh(buildGeometry(mesh), ghost);
  m.position.set(...center);
  return m;
}

/**
 * The parameter bar for modelling features: a row of fields at the top of the
 * view, a live preview computed whenever a value changes, and Apply/Cancel.
 */
export class FeatureBar {
  private spec: FeatureSpec<unknown> | null = null;
  private values: Values = {};
  private result: unknown = null;
  private sequence = 0;
  private timer: number | undefined;
  private readonly el: HTMLElement;
  private readonly fieldsEl: HTMLElement;
  private readonly mainEl: HTMLElement;
  /** The targets' meshes when the bar opened, to notice replacements */
  private watched: [SceneObject, MeshData][] = [];
  private readonly info: HTMLElement;
  private readonly group = new THREE.Group();

  constructor(
    private readonly viewport: Viewport,
    private readonly gizmo: Gizmo,
    private readonly doc: SceneDocument,
    private readonly toast: (msg: string) => void,
  ) {
    this.el = document.querySelector<HTMLElement>('#feature-bar')!;
    this.fieldsEl = this.el.querySelector<HTMLElement>('.feature-fields')!;
    this.mainEl = this.el.querySelector<HTMLElement>('.feature-main')!;
    doc.addEventListener('change', () => this.checkTargets());
    this.info = this.el.querySelector<HTMLElement>('.feature-info')!;
    viewport.scene.add(this.group);
    this.el.querySelector('[data-feature="apply"]')!.addEventListener('click', () => this.apply());
    this.el.querySelector('[data-feature="cancel"]')!.addEventListener('click', () => this.close());
  }

  get active(): boolean {
    return this.spec !== null;
  }

  open<R>(spec: FeatureSpec<R>): void {
    this.close();
    this.spec = spec as FeatureSpec<unknown>;
    this.values = Object.fromEntries(spec.fields.filter((f) => f.type !== 'button').map((f) => [f.key, f.value]));
    this.el.querySelector('.bar-title')!.textContent = spec.title;
    this.el.querySelector<HTMLButtonElement>('[data-feature="apply"]')!.disabled = false;
    this.fieldsEl.replaceChildren(...spec.fields.filter((f) => !f.prominent).map((f) => this.fieldElement(f)));
    this.mainEl.replaceChildren(...spec.fields.filter((f) => f.prominent).map((f) => this.fieldElement(f)));
    this.mainEl.hidden = !spec.fields.some((f) => f.prominent);
    this.watched = (spec.targets ?? spec.hide ?? []).map((o) => [o, o.data]);
    beginTool('feature', () => this.close());
    this.updateVisibility();
    this.el.hidden = false;
    this.gizmo.enabled = false;
    for (const o of spec.hide ?? []) o.mesh.visible = false;
    showHint('feature', spec.hint);
    this.refresh(0);
  }

  private fieldElement(f: Field): HTMLElement {
    if (f.type === 'button') {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = f.label;
      b.dataset.key = f.key;
      if (f.tip) {
        b.dataset.tipTitle = f.label;
        b.dataset.tip = f.tip;
      }
      b.addEventListener('click', () => f.onClick?.());
      return b;
    }
    const label = document.createElement('label');
    label.className = f.prominent ? 'bar-field prominent' : 'bar-field';
    label.dataset.key = f.key;
    if (f.tip) {
      label.dataset.tipTitle = f.label;
      label.dataset.tip = f.tip;
    }
    const name = document.createElement('span');
    name.className = 'muted';
    name.textContent = f.label;
    let input: HTMLInputElement | HTMLSelectElement;
    if (f.type === 'select') {
      const s = document.createElement('select');
      for (const [value, text] of f.options ?? []) s.add(new Option(text, value));
      s.value = String(f.value);
      input = s;
    } else {
      const i = document.createElement('input');
      i.type = f.type;
      if (f.type === 'checkbox') i.checked = Boolean(f.value);
      else i.value = String(f.value);
      if (f.min !== undefined) i.min = String(f.min);
      if (f.max !== undefined) i.max = String(f.max);
      if (f.step !== undefined) i.step = String(f.step);
      input = i;
    }
    input.addEventListener(f.type === 'text' ? 'input' : 'change', () => {
      this.values[f.key] =
        f.type === 'number' ? Number((input as HTMLInputElement).value)
          : f.type === 'checkbox' ? (input as HTMLInputElement).checked
            : input.value;
      this.updateVisibility();
      this.refresh();
    });
    // Typing in a field must not trigger shortcuts like Delete.
    input.addEventListener('keydown', (e) => e.stopPropagation());
    label.append(name, input);
    if (f.unit) {
      const u = document.createElement('span');
      u.className = 'muted';
      u.textContent = f.unit;
      label.append(u);
    }
    return label;
  }

  /** Change a field from outside (e.g. dragging a handle in the view) and recompute the preview soon (delay null: don't). */
  setValue(key: string, value: number | string | boolean, delay: number | null = 120): void {
    if (!this.spec) return;
    this.values[key] = value;
    const input = this.el.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-key="${key}"] input, [data-key="${key}"] select`);
    if (input && document.activeElement !== input) {
      if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = Boolean(value);
      else input.value = String(value);
    }
    // null: only show the value (the preview already uses it).
    if (delay !== null) this.refresh(delay);
  }

  /** Close if an object the tool works on was deleted or got a new shape. */
  private checkTargets(): void {
    if (!this.spec || this.watched.length === 0) return;
    const lost = this.watched.some(([o, data]) => !this.doc.objects.includes(o) || o.data !== data);
    if (!lost) return;
    const title = this.spec.title;
    this.close();
    this.toast(`${title} was cancelled: its object was deleted or changed`);
  }

  private updateVisibility(): void {
    for (const f of this.spec?.fields ?? []) {
      if (!f.showIf) continue;
      const el = this.el.querySelector<HTMLElement>(`[data-key="${f.key}"]`);
      if (el) el.hidden = String(this.values[f.showIf[0]]) !== f.showIf[1];
    }
  }

  /** Recompute the preview soon (call when something outside the fields changed, e.g. picked edges). */
  refresh(delay = 250): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => void this.compute(), delay);
  }

  private async compute(): Promise<void> {
    const spec = this.spec;
    if (!spec) return;
    const seq = ++this.sequence;
    this.info.textContent = 'Working…';
    try {
      const result = await spec.compute({ ...this.values });
      if (seq !== this.sequence || spec !== this.spec) return;
      this.result = result;
      this.clearPreview();
      if (result !== null) this.group.add(...spec.show(result));
      this.info.textContent = '';
    } catch (err) {
      if (seq !== this.sequence) return;
      this.result = null;
      this.clearPreview();
      this.info.textContent = err instanceof Error ? err.message : String(err);
    }
    this.viewport.invalidate();
  }

  private clearPreview(): void {
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      child.traverse((o) => {
        if (!o.userData.sharedGeometry) (o as THREE.Mesh).geometry?.dispose();
      });
    }
  }

  private apply(): void {
    const spec = this.spec;
    if (!spec) return;
    if (this.result === null) {
      this.info.textContent = this.info.textContent || 'Nothing to apply yet';
      return;
    }
    const result = this.result;
    const values = { ...this.values };
    this.close();
    spec.apply(result, values);
  }

  close(): void {
    const spec = this.spec;
    if (!spec) return;
    clearTimeout(this.timer);
    this.sequence++;
    this.spec = null;
    this.result = null;
    this.watched = [];
    endTool('feature');
    this.clearPreview();
    for (const o of spec.hide ?? []) o.mesh.visible = true;
    this.el.hidden = true;
    this.gizmo.enabled = true;
    hideHint('feature');
    spec.onClose?.();
    this.viewport.invalidate();
  }
}
