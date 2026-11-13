import { friendlyError } from '../app/messages';
import { CANCELLED, runOp } from '../geometry/workerClient';
import { summarizeThickness, type ThicknessResult } from '../geometry/thickness';
import type { MeshData } from '../geometry/meshData';
import type { SceneDocument, SceneObject } from '../scene/document';
import type { Gizmo } from '../scene/gizmo';
import { disposeThicknessLayer, paintThickness, THICKNESS_COLORS, thicknessLayer } from '../scene/thickness';
import type { Viewport } from '../scene/viewport';
import type * as THREE from 'three';
import { fromUnit, settings, settingsEvents, toUnit, updateUi } from '../settings';
import { lengthText } from './checkTools';
import { parseNumber } from './numberInputs';
import { beginViewTool, endViewTool } from './toolLock';

/** One object's measurement, kept while the view is open: only the colours change with the minimum wall. */
interface Entry {
  obj: SceneObject;
  /** The shape that was measured: a different one means the numbers no longer fit */
  data: MeshData;
  result: ThicknessResult;
  layer: THREE.Mesh;
}

/**
 * Wall thickness (Check menu): a panel at the top and a heat map on the
 * objects (the selection, or every visible object when nothing is selected)
 * showing how thick the walls are against the minimum wall, so thin walls are
 * seen before printing. The thickness is measured once when the view opens (in
 * the geometry worker); typing another minimum wall only repaints. A view tool
 * like the overhangs: while it is open, objects can't be edited or moved
 * (docs/tool-rules.md); Close or Esc ends it.
 */
export class ThicknessTool {
  private on = false;
  private readonly bar = document.querySelector<HTMLElement>('#thickness-bar')!;
  private readonly field = this.bar.querySelector<HTMLInputElement>('#thickness-min')!;
  private readonly unitLabel = this.bar.querySelector<HTMLElement>('#thickness-unit')!;
  private readonly summary = this.bar.querySelector<HTMLElement>('#thickness-summary')!;
  private readonly menuItem = document.querySelector<HTMLElement>('[data-action="thickness"]')!;
  private entries: Entry[] = [];
  /** The objects the view was opened for (measured again when a larger minimum wall needs longer rays) */
  private targets: SceneObject[] = [];
  /** Aborts the measuring still running (closing the view, or opening it again) */
  private abort: AbortController | null = null;
  /** Objects the last open could not measure (not closed solids) */
  private skipped = 0;
  private measuring = false;

  constructor(
    private readonly viewport: Viewport,
    private readonly doc: SceneDocument,
    private readonly gizmo: Gizmo,
    private readonly toast: (message: string) => void,
  ) {
    this.menuItem.addEventListener('click', () => (this.on ? this.close() : void this.open()));
    this.bar.querySelector('[data-thickness="close"]')!.addEventListener('click', () => this.close());
    for (const [i, swatch] of this.bar.querySelectorAll<HTMLElement>('.legend-swatch').entries()) {
      swatch.style.background = THICKNESS_COLORS[i as 0 | 1 | 2 | 3];
    }
    // Same setting and limits as the Check dialog's field (0.1 to 10 mm), shown in the chosen unit.
    this.field.addEventListener('change', () => {
      const typed = fromUnit(parseNumber(this.field.value));
      const mm = Number.isFinite(typed) && typed !== 0 ? Math.min(10, Math.max(0.1, typed)) : settings.ui.minWall;
      updateUi((ui) => (ui.minWall = mm));
      this.repaint();
    });
    settingsEvents.addEventListener('change', () => this.on && this.showMinWall());
    // Layers follow the objects: one whose shape was replaced, or that was deleted, loses its layer.
    for (const type of ['change', 'history'] as const) doc.addEventListener(type, () => this.dropStale());
    this.bar.hidden = true;
  }

  get active(): boolean {
    return this.on;
  }

  async open(): Promise<void> {
    const objs = (this.doc.selection.length ? this.doc.selection : this.doc.objects).filter((o) => !o.hidden);
    if (objs.length === 0) return this.toast('Nothing to show: add or select an object first');
    beginViewTool('thickness', () => this.close());
    this.gizmo.enabled = false;
    this.on = true;
    this.bar.hidden = false;
    this.setMenuState();
    this.showMinWall();
    await this.measure(objs);
  }

  /** Measure the objects (the worker looks as far as the minimum wall needs) and paint their layers. */
  private async measure(objs: SceneObject[]): Promise<void> {
    this.targets = objs;
    this.skipped = 0;
    this.setMeasuring(true);
    this.summary.textContent = 'Measuring…';
    this.abort?.abort();
    const abort = new AbortController();
    this.abort = abort;
    const shapes = objs.map((o) => o.data);
    const minWall = settings.ui.minWall;
    const settled = await Promise.allSettled(
      objs.map((o) => runOp('thickness', { item: this.doc.placed(o), minWall }, { quiet: true, signal: abort.signal })),
    );
    // Closed (or measured again) meanwhile: nothing of this run is wanted.
    if (this.abort !== abort || !this.on) return;
    this.abort = null;
    this.setMeasuring(false);
    const refused: string[] = [];
    settled.forEach((s, i) => {
      const obj = objs[i];
      if (s.status === 'rejected') {
        if (!(s.reason instanceof Error && s.reason.message === CANCELLED)) refused.push(friendlyError(s.reason));
        this.skipped++;
        return;
      }
      // The object may have been removed or reshaped meanwhile.
      if (!this.doc.objects.includes(obj) || obj.data !== shapes[i]) return;
      const layer = thicknessLayer(obj.mesh.geometry, s.value.thickness, settings.ui.minWall);
      if (!layer) {
        this.skipped++;
        return;
      }
      obj.mesh.add(layer);
      this.entries.push({ obj, data: shapes[i], result: s.value, layer });
    });
    if (this.entries.length === 0) {
      this.toast(refused[0] ?? 'Nothing could be measured');
      this.close();
      return;
    }
    if (refused.length) this.toast(`${refused.length === 1 ? '1 object' : `${refused.length} objects`} skipped: ${refused[0]}`);
    this.updateSummary();
    this.viewport.invalidate();
  }

  /** Close the panel; false if it wasn't open. */
  close(): boolean {
    if (!this.on) return false;
    this.on = false;
    this.setMeasuring(false);
    this.abort?.abort();
    this.abort = null;
    for (const e of this.entries) disposeThicknessLayer(e.layer);
    this.entries = [];
    endViewTool('thickness');
    this.gizmo.enabled = true;
    this.bar.hidden = true;
    this.setMenuState();
    this.viewport.invalidate();
    return true;
  }

  /** While the walls are measured the field waits (a new minimum wall could need longer rays than this run uses). */
  private setMeasuring(value: boolean): void {
    this.measuring = value;
    this.field.disabled = value;
  }

  private setMenuState(): void {
    this.menuItem.setAttribute('aria-checked', String(this.on));
    this.menuItem.classList.toggle('checked', this.on);
  }

  /** The minimum wall in the field, in the unit chosen in Settings. */
  private showMinWall(): void {
    this.unitLabel.textContent = settings.unit;
    this.field.value = String(+toUnit(settings.ui.minWall).toFixed(3));
    if (!this.measuring) this.updateSummary();
  }

  private repaint(): void {
    this.showMinWall();
    // Colours are exact while 1.5 x the minimum wall is within what the rays looked at; a much larger one measures again.
    const reach = Math.min(...this.entries.map((e) => e.result.reach));
    if (this.entries.length && settings.ui.minWall * 1.5 > reach) {
      for (const e of this.entries) disposeThicknessLayer(e.layer);
      this.entries = [];
      void this.measure(this.targets.filter((o) => this.doc.objects.includes(o)));
      return;
    }
    for (const e of this.entries) paintThickness(e.layer, e.result.thickness, settings.ui.minWall);
    this.viewport.invalidate();
  }

  private dropStale(): void {
    if (!this.on || this.entries.length === 0) return;
    const keep = this.entries.filter((e) => this.doc.objects.includes(e.obj) && e.obj.data === e.data);
    if (keep.length === this.entries.length) return;
    for (const e of this.entries) if (!keep.includes(e)) disposeThicknessLayer(e.layer);
    this.entries = keep;
    if (keep.length === 0) {
      this.close();
      return;
    }
    this.updateSummary();
    this.viewport.invalidate();
  }

  /** "12 % of the surface is thinner than 0.8 mm, thinnest 0.42 mm" (and "(sampled)" when only part of it was measured). */
  private updateSummary(): void {
    const min = settings.ui.minWall;
    const s = summarizeThickness(this.entries.map((e) => e.result), min);
    if (!s.measured) {
      this.summary.textContent = 'No wall thickness could be measured.';
      return;
    }
    const pct = s.thinPercent > 0 && s.thinPercent < 1 ? '<1' : String(Math.round(s.thinPercent));
    const sampled = this.entries.some((e) => e.result.sampled) ? ' (sampled)' : '';
    const skipped = this.skipped ? `; ${this.skipped} object${this.skipped > 1 ? 's' : ''} not measured` : '';
    this.summary.textContent = `${pct}% of the surface is thinner than ${lengthText(min, settings.unit)}, thinnest ${lengthText(s.thinnestMm!, settings.unit)}${sampled}${skipped}`;
  }
}
