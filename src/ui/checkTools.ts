import * as THREE from 'three';
import type { CheckResult } from '../geometry/meshTools';
import { runOp } from '../geometry/workerClient';
import type { SceneDocument, SceneObject } from '../scene/document';
import { settings, updateUi } from '../settings';
import { hideHint, showHint } from './hint';

type Heavy = <T>(objs: SceneObject[], compute: () => Promise<T>, apply: (r: T) => void) => Promise<void>;

const STATUS_ICON = { pass: '✓', warn: '!', fail: '✕' } as const;

/** The Check menu: print check report, automatic repair and best print orientation. */
export class CheckTools {
  private readonly dialog = document.querySelector<HTMLDialogElement>('#check-dialog')!;
  private checked: { obj: SceneObject; result: CheckResult }[] = [];

  constructor(
    private readonly doc: SceneDocument,
    private readonly heavy: Heavy,
    private readonly toast: (msg: string) => void,
  ) {
    document.querySelector('[data-action="check"]')!.addEventListener('click', () => void this.check());
    document.querySelector('[data-action="repair"]')!.addEventListener('click', () => this.repair([...this.doc.selection]));
    document.querySelector('[data-action="orient"]')!.addEventListener('click', () => void this.orientBest());

    const minWall = this.dialog.querySelector<HTMLInputElement>('#check-min-wall')!;
    minWall.value = String(settings.ui.minWall);
    minWall.addEventListener('change', () => {
      const v = Math.max(0.1, Number(minWall.value) || 0.8);
      updateUi((ui) => (ui.minWall = v));
    });
    this.dialog.querySelector('[data-action="check-again"]')!.addEventListener('click', () => void this.runChecks());
    this.dialog.addEventListener('close', () => {
      if (this.dialog.returnValue === 'repair') {
        this.repair(this.checked.filter((c) => c.result.items.some((i) => i.fixable && i.status !== 'pass')).map((c) => c.obj));
      }
      if (this.dialog.returnValue === 'orient') {
        const c = this.checked[0];
        if (c?.result.suggestedDown) this.orient(c.obj, c.result.suggestedDown);
      }
    });
  }

  private async check(): Promise<void> {
    if (this.doc.selection.length === 0) return this.toast('Select the objects to check');
    this.dialog.returnValue = '';
    this.dialog.showModal();
    await this.runChecks();
  }

  private async runChecks(): Promise<void> {
    const objs = [...this.doc.selection];
    const out = this.dialog.querySelector<HTMLElement>('#check-results')!;
    out.textContent = 'Checking…';
    this.dialog.querySelector<HTMLElement>('#check-repair')!.hidden = true;
    this.dialog.querySelector<HTMLElement>('#check-orient')!.hidden = true;
    try {
      const results = await Promise.all(objs.map((o) => runOp('check', { item: this.doc.placed(o), minWall: settings.ui.minWall })));
      this.checked = objs.map((obj, i) => ({ obj, result: results[i] }));
    } catch (err) {
      out.textContent = err instanceof Error ? err.message : String(err);
      return;
    }
    out.replaceChildren(...this.checked.map(({ obj, result }) => {
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
        detail.textContent = item.detail + (item.fixable && item.status !== 'pass' ? ' Repair can fix this.' : '');
        text.append(label, detail);
        li.append(icon, text);
        list.append(li);
      }
      section.append(h, list);
      return section;
    }));
    const fixable = this.checked.some((c) => c.result.items.some((i) => i.fixable && i.status !== 'pass'));
    this.dialog.querySelector<HTMLElement>('#check-repair')!.hidden = !fixable;
    this.dialog.querySelector<HTMLElement>('#check-orient')!.hidden = !(this.checked.length === 1 && this.checked[0].result.suggestedDown);
  }

  private repair(objs: SceneObject[]): void {
    if (objs.length === 0) return this.toast('Select the objects to repair');
    void this.heavy(objs, () => Promise.all(objs.map((o) => runOp('repair', { mesh: o.data }))), (results) => {
      this.doc.checkpoint();
      results.forEach((r, i) => this.doc.setData(objs[i], r.mesh));
      this.toast(results.map((r, i) => `${objs[i].name}: ${r.actions.join(', ')}`).join(' · '));
    });
  }

  private async orientBest(): Promise<void> {
    if (this.doc.selection.length !== 1) return this.toast('Select one object');
    const obj = this.doc.selection[0];
    showHint('busy', 'Working…');
    try {
      const r = await runOp('check', { item: this.doc.placed(obj), minWall: settings.ui.minWall });
      if (!r.suggestedDown) return this.toast('It is already in the best orientation');
      this.orient(obj, r.suggestedDown);
    } catch (err) {
      this.toast(err instanceof Error ? err.message : String(err));
    } finally {
      hideHint('busy');
    }
  }

  /** Turn so that `down` (a world direction) faces the plate, then rest on the plate. */
  private orient(obj: SceneObject, down: [number, number, number]): void {
    if (!this.doc.objects.includes(obj)) return;
    this.doc.checkpoint();
    const turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...down), new THREE.Vector3(0, 0, -1));
    obj.mesh.quaternion.premultiply(turn);
    obj.mesh.position.z -= this.doc.worldBox([obj]).min.z;
    this.doc.emit('transform');
    this.toast(`${obj.name} turned to the orientation with the fewest overhangs`);
  }
}
