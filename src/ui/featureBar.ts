import * as THREE from 'three';
import type { MeshData } from '../geometry/meshData';
import { buildGeometry, type SceneDocument, type SceneObject } from '../scene/document';
import type { Gizmo } from '../scene/gizmo';
import type { Viewport } from '../scene/viewport';
import { MM_PER_UNIT, settings, settingsEvents } from '../settings';
import { hideHint, showHint } from './hint';
import { beginTool, endTool } from './toolLock';
import { touchFriendly } from './touchSelect';

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
  /** Show only when another field has this value, or when the function says so for the current values */
  showIf?: [string, string] | ((values: Values) => boolean);
}

export type Values = Record<string, number | string | boolean>;

/** Fields in 'mm' show and take values in the chosen unit; the values themselves stay in mm. */
const mmPerShown = (f: Field): number => (f.type === 'number' && f.unit === 'mm' ? MM_PER_UNIT[settings.unit] : 1);
/** A value (mm) as the input shows it, free of floating-point noise. */
const shown = (f: Field, mm: number): string => String(mmPerShown(f) === 1 ? mm : Math.round((mm / mmPerShown(f)) * 1e6) / 1e6);
/** 1, 2 or 5 times a power of ten, close to `rough`. */
function niceStep(rough: number): number {
  const p = 10 ** Math.floor(Math.log10(rough));
  const r = rough / p;
  return (r < 1.5 ? 1 : r < 3.5 ? 2 : r < 7.5 ? 5 : 10) * p;
}
/** The step for the input's arrows, in the shown unit. */
const shownStep = (f: Field): number | undefined =>
  f.step === undefined ? undefined : mmPerShown(f) === 1 ? f.step : niceStep(f.step / mmPerShown(f));
/** Put a number field's attributes (min, max, step) in the shown unit. */
function applyLimits(f: Field, input: HTMLInputElement): void {
  const k = mmPerShown(f);
  const set = (name: string, v: number | undefined) => {
    if (v === undefined) input.removeAttribute(name);
    else input.setAttribute(name, String(k === 1 ? v : Math.round((v / k) * 1e6) / 1e6));
  };
  set('min', f.min);
  set('max', f.max);
  const st = shownStep(f);
  if (st === undefined) input.removeAttribute('step');
  else input.setAttribute('step', String(st));
}

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
  /** On open, focus the first number or text field and select its contents, so a value can be typed straight away. */
  focusFirst?: boolean;
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
  /** The values the latest compute was started with (as text), to tell whether Enter finds newer ones */
  private computedValues = '';
  private sequence = 0;
  private timer: number | undefined;
  /** A compute for the latest values is running */
  private computing = false;
  /** Enter was pressed while the preview was still being worked out: apply once it is ready */
  private applyAfter = false;
  private readonly el: HTMLElement;
  private readonly fieldsEl: HTMLElement;
  private readonly mainEl: HTMLElement;
  private readonly actions: HTMLElement;
  /** The tool's own buttons, before Apply */
  private readonly extraActions: HTMLElement;
  /** The targets' meshes when the bar opened, to notice replacements */
  private watched: [SceneObject, MeshData][] = [];
  private readonly info: HTMLElement;
  private readonly applyButton: HTMLButtonElement;
  private readonly group = new THREE.Group();
  private shownUnit = settings.unit;

  constructor(
    readonly viewport: Viewport,
    private readonly gizmo: Gizmo,
    private readonly doc: SceneDocument,
    private readonly toast: (msg: string) => void,
  ) {
    this.el = document.querySelector<HTMLElement>('#feature-bar')!;
    this.fieldsEl = this.el.querySelector<HTMLElement>('.feature-fields')!;
    this.mainEl = this.el.querySelector<HTMLElement>('.feature-main')!;
    this.actions = this.el.querySelector<HTMLElement>('.bar-actions')!;
    this.extraActions = document.createElement('div');
    this.extraActions.className = 'extra-actions';
    this.actions.prepend(this.extraActions);
    doc.addEventListener('change', () => this.checkTargets());
    // A new unit in the settings: the open bar's fields follow.
    settingsEvents.addEventListener('change', () => {
      if (settings.unit === this.shownUnit) return;
      this.shownUnit = settings.unit;
      this.refreshUnits();
    });
    this.info = this.el.querySelector<HTMLElement>('.feature-info')!;
    viewport.scene.add(this.group);
    // Like Enter: a value just typed (its field still focused, or its 'change' only now
    // firing as the field loses focus) is computed first, then applied.
    this.el.querySelector('[data-feature="apply"]')!.addEventListener('click', () => this.applyWhenReady());
    this.applyButton = this.el.querySelector<HTMLButtonElement>('[data-feature="apply"]')!;
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
    // Buttons (e.g. "Center on face") act, so they sit with Apply and Cancel.
    this.fieldsEl.replaceChildren(...spec.fields.filter((f) => !f.prominent && f.type !== 'button').map((f) => this.fieldElement(f)));
    this.extraActions.replaceChildren(...spec.fields.filter((f) => f.type === 'button').map((f) => this.fieldElement(f)));
    this.mainEl.replaceChildren(...spec.fields.filter((f) => f.prominent).map((f) => this.fieldElement(f)));
    this.mainEl.hidden = !spec.fields.some((f) => f.prominent);
    // Apply and Cancel sit beside the main field when there is one (one row less), else at the end.
    if (this.mainEl.hidden) this.el.append(this.actions);
    else this.mainEl.append(this.actions);
    this.watched = (spec.targets ?? spec.hide ?? []).map((o) => [o, o.data]);
    beginTool('feature', () => this.close());
    this.updateVisibility();
    this.el.hidden = false;
    this.gizmo.enabled = false;
    for (const o of spec.hide ?? []) o.mesh.visible = false;
    // Everything the tool does not work on fades back, so its own objects stand out.
    const mine = new Set([...(spec.targets ?? []), ...(spec.hide ?? [])]);
    if (mine.size) this.doc.setFaded(this.doc.objects.filter((o) => !mine.has(o) && !o.hidden));
    showHint('feature', spec.hint);
    this.refresh(0);
    if (spec.focusFirst && !matchMedia('(pointer: coarse)').matches) {
      // (not on touch screens: the keyboard would cover the view)
      const first = this.el.querySelector<HTMLInputElement>('input[type="number"], input[type="text"]');
      first?.focus();
      first?.select();
    }
    this.viewport.invalidate();
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
      else i.value = f.type === 'number' ? shown(f, Number(f.value)) : String(f.value);
      if (f.type === 'number') applyLimits(f, i);
      else {
        if (f.min !== undefined) i.min = String(f.min);
        if (f.max !== undefined) i.max = String(f.max);
        if (f.step !== undefined) i.step = String(f.step);
      }
      input = i;
    }
    input.addEventListener(f.type === 'text' ? 'input' : 'change', () => {
      this.values[f.key] = this.read(f, input);
      this.updateVisibility();
      this.refresh();
    });
    // Typing in a field must not trigger shortcuts like Delete.
    input.addEventListener('keydown', (e) => e.stopPropagation());
    label.append(name, input instanceof HTMLSelectElement ? touchFriendly(input) : input);
    if (f.unit) {
      const u = document.createElement('span');
      u.className = 'muted unit-label';
      u.textContent = f.type === 'number' && f.unit === 'mm' ? settings.unit : f.unit;
      label.append(u);
    }
    return label;
  }

  /** A field's value as its input shows it right now. */
  private read(f: Field, input: HTMLInputElement | HTMLSelectElement): number | string | boolean {
    if (f.type === 'checkbox') return (input as HTMLInputElement).checked;
    if (f.type !== 'number') return input.value;
    // An empty or non-numeric entry keeps the previous value; others are held to the field's limits.
    const text = input.value.trim();
    const typed = text === '' ? NaN : Number(text) * mmPerShown(f);
    const previous = this.values[f.key];
    let v = Number.isFinite(typed) ? typed : typeof previous === 'number' ? previous : Number(f.value);
    if (f.min !== undefined) v = Math.max(f.min, v);
    if (f.max !== undefined) v = Math.min(f.max, v);
    const text2 = shown(f, v);
    if (input.value !== text2) input.value = text2;
    return v;
  }

  /** The unit changed while the bar is open: show every 'mm' field in it. */
  private refreshUnits(): void {
    for (const f of this.spec?.fields ?? []) {
      if (f.type !== 'number' || f.unit !== 'mm') continue;
      const label = this.el.querySelector<HTMLElement>(`[data-key="${f.key}"]`);
      const input = label?.querySelector<HTMLInputElement>('input');
      if (!label || !input) continue;
      applyLimits(f, input);
      input.value = shown(f, Number(this.values[f.key]));
      const u = label.querySelector<HTMLElement>('.unit-label');
      if (u) u.textContent = settings.unit;
    }
  }

  /** Take what the inputs show into the values, as their change handlers would (Enter can come before 'change' fires). */
  private readInputs(): void {
    for (const f of this.spec?.fields ?? []) {
      if (f.type === 'button') continue;
      const input = this.el.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-key="${f.key}"] input, [data-key="${f.key}"] select`);
      if (input) this.values[f.key] = this.read(f, input);
    }
    this.updateVisibility();
  }

  /** Change a field from outside (e.g. dragging a handle in the view) and recompute the preview soon (delay null: don't). */
  setValue(key: string, value: number | string | boolean, delay: number | null = 120): void {
    if (!this.spec) return;
    this.values[key] = value;
    const input = this.el.querySelector<HTMLInputElement | HTMLSelectElement>(`[data-key="${key}"] input, [data-key="${key}"] select`);
    const f = this.spec.fields.find((x) => x.key === key);
    if (input) {
      if (input instanceof HTMLInputElement && input.type === 'checkbox') input.checked = Boolean(value);
      else if (f?.type === 'number') {
        // Also while the field is focused (e.g. Pick point), but only when it shows something else.
        const text = shown(f, Number(value));
        if (!(Number(input.value) === Number(text) && input.value.trim() !== '')) input.value = text;
      } else if (input.value !== String(value)) {
        input.value = String(value);
        input.dispatchEvent(new Event('sync')); // a touch dropdown shows the new value
      }
    }
    this.updateVisibility();
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
      if (el) el.hidden = typeof f.showIf === 'function'
        ? !f.showIf(this.values)
        : String(this.values[f.showIf[0]]) !== f.showIf[1];
    }
  }

  /** Recompute the preview soon (call when something outside the fields changed, e.g. picked edges). */
  refresh(delay = 250): void {
    clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = undefined;
      void this.compute();
    }, delay);
  }

  /** Apply (like the Apply button) as soon as the preview for the current values is ready. For the Enter key. */
  applyWhenReady(): void {
    if (!this.spec || this.applyButton.disabled) return;
    // Typed values count even if no 'change' event came: compute again when they differ from the last result's.
    this.readInputs();
    if (JSON.stringify(this.values) !== this.computedValues) {
      this.applyAfter = true;
      this.refresh(0);
      return;
    }
    if (this.timer === undefined && !this.computing) return this.apply();
    this.applyAfter = true;
  }

  private async compute(): Promise<void> {
    const spec = this.spec;
    if (!spec) return;
    const seq = ++this.sequence;
    this.computing = true;
    this.computedValues = JSON.stringify(this.values);
    // "Working…" shows in its own box under the bar (main.ts), so this row never jumps.
    this.info.textContent = '';
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
    this.computing = false;
    this.viewport.invalidate();
    // Enter was pressed meanwhile: apply now (or show why there is nothing to apply).
    if (this.applyAfter) {
      this.applyAfter = false;
      if (!this.applyButton.disabled) this.apply();
    }
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
    this.timer = undefined;
    this.computing = false;
    this.applyAfter = false;
    this.sequence++;
    this.computedValues = '';
    this.spec = null;
    this.result = null;
    this.watched = [];
    endTool('feature');
    this.clearPreview();
    for (const o of spec.hide ?? []) o.mesh.visible = !o.hidden;
    this.doc.setFaded(null);
    this.el.hidden = true;
    this.gizmo.enabled = true;
    hideHint('feature');
    spec.onClose?.();
    this.viewport.invalidate();
  }
}
