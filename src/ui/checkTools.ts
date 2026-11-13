import * as THREE from 'three';
import type { CheckItem, CheckResult } from '../geometry/meshTools';
import { runOp } from '../geometry/workerClient';
import { friendlyError } from '../app/messages';
import type { SceneDocument, SceneObject } from '../scene/document';
import { MM_PER_UNIT, settings, updateUi, type Unit } from '../settings';
import { parseNumber } from './numberInputs';

const STATUS_ICON = { pass: '✓', warn: '!', fail: '✕' } as const;
const NOTHING = 'Nothing needed repairing';

/** A length (mm) in the unit, with up to 2 decimals (3 for inches): "0.8 mm", "0.031 in". */
function lengthText(mm: number, unit: Unit): string {
  const v = mm / MM_PER_UNIT[unit];
  return `${+v.toFixed(unit === 'in' ? 3 : 2)} ${unit}`;
}

/** An area (mm²) in the unit squared: "120 mm²", "1.2 cm²", "0.19 in²". */
function areaText(mm2: number, unit: Unit): string {
  if (unit === 'mm') return `${Math.round(mm2)} mm²`;
  return `${+(mm2 / MM_PER_UNIT[unit] ** 2).toFixed(2)} ${unit}²`;
}

/**
 * The sentence for a check item. The worker writes its sentences in mm; when
 * the item carries its numbers, the thickness and orientation sentences are
 * rebuilt here in the chosen unit. Other items (and items without numbers) keep their text.
 */
export function describeCheck(item: CheckItem, unit: Unit): string {
  const v = item.values;
  if (!v) return item.detail;
  if (item.id === 'thickness' && v.minWall !== undefined) {
    const thinnest = v.thinnest !== undefined ? ` (thinnest ${lengthText(v.thinnest, unit)})` : '';
    if (item.status === 'fail') {
      return `About ${v.halfPercent}% of the surface is thinner than ${lengthText(v.minWall / 2, unit)}: such thin parts may not print at all.`;
    }
    if (item.status === 'warn') {
      return `About ${v.thinPercent}% of the surface is thinner than ${lengthText(v.minWall, unit)}${thinnest}: it prints, but with fewer lines and less strength.`;
    }
    return `No significant area thinner than ${lengthText(v.minWall, unit)} found${thinnest}.`;
  }
  if (item.id === 'orientation' && v.overhangNow !== undefined) {
    if (item.status === 'pass') return `Current orientation is good (${areaText(v.overhangNow, unit)} of overhang).`;
    const parts: string[] = [];
    if (v.overhang !== undefined && v.overhang < v.overhangNow - 1) {
      parts.push(`cut overhangs from ${areaText(v.overhangNow, unit)} to ${areaText(v.overhang, unit)} (fewer supports)`);
    }
    if (v.contact !== undefined && v.contactNow !== undefined && v.contact > v.contactNow + 1) {
      parts.push(`rest it on ${areaText(v.contact, unit)} instead of ${areaText(v.contactNow, unit)} (sticks and stands better)`);
    }
    return `Turning it would ${parts.join(' and ')}.`;
  }
  return item.detail;
}

/**
 * The Fix menu: the Check and Repair box (print check report, automatic repair
 * with its log, undo of the repair) and best print orientation.
 */
export class CheckTools {
  private readonly dialog = document.querySelector<HTMLDialogElement>('#check-dialog')!;
  private readonly results = this.dialog.querySelector<HTMLElement>('#check-results')!;
  private readonly repairButton = this.dialog.querySelector<HTMLButtonElement>('#check-repair')!;
  private readonly log = this.dialog.querySelector<HTMLOListElement>('#repair-log')!;
  private readonly undoButton = this.dialog.querySelector<HTMLButtonElement>('#repair-undo')!;
  private readonly orientButton = this.dialog.querySelector<HTMLButtonElement>('#check-orient')!;
  /** The objects the box was opened for */
  private objs: SceneObject[] = [];
  private checked: { obj: SceneObject; result: CheckResult }[] = [];
  private working = false;

  constructor(
    private readonly doc: SceneDocument,
    private readonly toast: (msg: string) => void,
  ) {
    document.querySelector('[data-action="check"]')!.addEventListener('click', () => void this.open());
    document.querySelector('[data-action="orient"]')!.addEventListener('click', () => void this.orientBest());

    const minWall = this.dialog.querySelector<HTMLInputElement>('#check-min-wall')!;
    minWall.value = String(settings.ui.minWall);
    minWall.addEventListener('change', () => {
      const typed = parseNumber(minWall.value);
      const v = Math.max(0.1, Number.isFinite(typed) && typed !== 0 ? typed : settings.ui.minWall);
      minWall.value = String(v);
      updateUi((ui) => (ui.minWall = v));
      void this.runChecks();
    });
    this.dialog.querySelector('[data-action="check-again"]')!.addEventListener('click', () => void this.runChecks());
    this.repairButton.addEventListener('click', () => void this.repair());
    this.undoButton.addEventListener('click', () => void this.undoRepair());
    this.orientButton.addEventListener('click', () => {
      const c = this.checked[0];
      this.dialog.close();
      if (c?.result.suggestedDown) this.orient(c.obj, c.result.suggestedDown);
    });
    // Esc must not close the box while a repair runs (its result would have nowhere to show).
    this.dialog.addEventListener('cancel', (e) => {
      if (this.working) e.preventDefault();
    });
    // Clicking the dimmed backdrop closes the box.
    this.dialog.addEventListener('click', (e) => {
      if (e.target === this.dialog && !this.working) this.dialog.close();
    });
  }

  private async open(): Promise<void> {
    if (this.doc.selection.length === 0) return this.toast('Select the objects to check');
    this.objs = [...this.doc.selection];
    this.log.replaceChildren();
    this.log.hidden = true;
    this.undoButton.hidden = true;
    this.dialog.querySelector('#check-scope')!.textContent =
      this.objs.length === 1 ? this.objs[0].name : `${this.objs.length} objects`;
    this.dialog.showModal();
    await this.runChecks();
  }

  /** The box's objects as they are now in the drawing (undo rebuilds objects, keeping their ids). */
  private live(): SceneObject[] {
    this.objs = this.objs
      .map((o) => this.doc.objects.find((x) => x.id === o.id))
      .filter((o): o is SceneObject => o !== undefined);
    return this.objs;
  }

  private async runChecks(): Promise<void> {
    const objs = this.live();
    this.results.textContent = 'Checking…';
    this.orientButton.hidden = true;
    try {
      const results = await Promise.all(objs.map((o) => runOp('check', { item: this.doc.placed(o), minWall: settings.ui.minWall })));
      this.checked = objs.map((obj, i) => ({ obj, result: results[i] }));
    } catch (err) {
      this.results.textContent = friendlyError(err);
      return;
    }
    this.results.replaceChildren(...this.checked.map(({ obj, result }) => {
      const section = document.createElement('section');
      section.className = 'check-object';
      const h = document.createElement('h3');
      h.textContent = obj.name;
      const list = document.createElement('ul');
      list.className = 'check-list';
      for (const item of result.items) {
        const li = document.createElement('li');
        li.className = item.status;
        const icon = document.createElement('span');
        icon.className = 'check-icon';
        icon.textContent = STATUS_ICON[item.status];
        const text = document.createElement('div');
        const label = document.createElement('strong');
        label.textContent = item.label;
        const detail = document.createElement('div');
        detail.className = 'muted';
        detail.textContent = describeCheck(item, settings.unit) + (item.fixable && item.status !== 'pass' ? ' Repair can fix this.' : '');
        text.append(label, detail);
        li.append(icon, text);
        list.append(li);
      }
      section.append(h, list);
      return section;
    }));
    const fixable = this.checked.some((c) => c.result.items.some((i) => i.fixable && i.status !== 'pass'));
    this.repairButton.classList.toggle('primary', fixable);
    this.orientButton.hidden = !(this.checked.length === 1 && this.checked[0].result.suggestedDown);
  }

  private addLog(text: string, kind: 'done' | 'none' | 'error' | 'info' = 'info'): void {
    const li = document.createElement('li');
    li.className = kind;
    li.textContent = text;
    this.log.append(li);
    this.log.hidden = false;
    this.log.scrollTop = this.log.scrollHeight;
  }

  /** Repair every object in the box; one undo step takes all of it back. */
  private async repair(): Promise<void> {
    const objs = this.live();
    if (objs.length === 0 || this.working) return;
    this.working = true;
    this.repairButton.disabled = true;
    this.log.replaceChildren();
    this.addLog('Repairing…');
    // The meshes that are sent: a result only fits an object that still has this mesh.
    const sent = new Map(objs.map((o) => [o, o.data] as const));
    try {
      const settled = await Promise.allSettled(objs.map((o) => runOp('repair', { mesh: o.data })));
      this.log.replaceChildren();
      const changed: { obj: SceneObject; mesh: (typeof settled)[number] }[] = [];
      settled.forEach((r, i) => {
        const obj = objs[i];
        if (r.status === 'rejected') {
          this.addLog(`${obj.name}: ${r.reason instanceof Error ? r.reason.message : String(r.reason)}`, 'error');
        } else if (r.value.actions.length === 1 && r.value.actions[0] === NOTHING) {
          this.addLog(`${obj.name}: nothing needed repairing`, 'none');
        } else {
          for (const a of r.value.actions) this.addLog(`${obj.name}: ${a}`, 'done');
          changed.push({ obj, mesh: r });
        }
      });
      const apply = changed.filter((c) => this.doc.objects.includes(c.obj) && c.obj.data === sent.get(c.obj));
      for (const c of changed) {
        if (this.doc.objects.includes(c.obj) && !apply.includes(c)) this.addLog(`${c.obj.name}: changed during the repair, so the result was not applied`, 'error');
      }
      if (apply.length) {
        this.doc.transact(() => {
          for (const c of apply) if (c.mesh.status === 'fulfilled') this.doc.setData(c.obj, c.mesh.value.mesh);
          this.doc.emit('transform');
        });
        this.undoButton.hidden = false;
      }
      await this.runChecks();
    } finally {
      this.working = false;
      this.repairButton.disabled = false;
    }
  }

  private async undoRepair(): Promise<void> {
    this.doc.undo();
    this.undoButton.hidden = true;
    this.addLog('Repair undone: the objects are back as they were', 'info');
    await this.runChecks();
  }

  private async orientBest(): Promise<void> {
    if (this.doc.selection.length !== 1) return this.toast('Select one object');
    const obj = this.doc.selection[0];
    try {
      const r = await runOp('check', { item: this.doc.placed(obj), minWall: settings.ui.minWall });
      if (!r.suggestedDown) return this.toast('It is already in the best orientation');
      this.orient(obj, r.suggestedDown);
    } catch (err) {
      this.toast(friendlyError(err));
    }
  }

  /** Turn so that `down` (a world direction) faces the plate, then rest on the plate. */
  private orient(obj: SceneObject, down: [number, number, number]): void {
    if (!this.doc.objects.includes(obj)) return;
    this.doc.transact(() => {
      const turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...down), new THREE.Vector3(0, 0, -1));
      obj.mesh.quaternion.premultiply(turn);
      obj.mesh.position.z -= this.doc.worldBox([obj]).min.z;
      this.doc.emit('transform');
    });
    this.toast(`${obj.name} turned to the orientation with the fewest overhangs`);
  }
}
