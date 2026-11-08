import * as THREE from 'three';
import type { Gizmo, GizmoMode } from '../scene/gizmo';
import type { SceneDocument, SceneObject } from '../scene/document';
import { fromUnit, settings, settingsEvents, toUnit, UNITS, updateSettings, updateUi } from '../settings';
import { setIcon } from './icons';

const AXES = ['x', 'y', 'z'] as const;

const LABELS: Record<GizmoMode, [string, string, string]> = {
  translate: ['X', 'Y', 'Z'],
  rotate: ['Roll', 'Pitch', 'Yaw'],
  scale: ['X', 'Y', 'Z'],
};

function fmt(v: number): string {
  return String(Math.round(v * 100) / 100);
}

/**
 * Floating bar at the bottom of the view:
 * Move / Rotate / Size buttons, three values, the unit, and a lock or
 * reset button depending on the mode. Works on the whole selection.
 */
export class TransformBar {
  private mode: GizmoMode = 'translate';
  private keepProportions = settings.ui.keepProportions;
  private readonly modeButtons: Record<GizmoMode, HTMLButtonElement>;
  private readonly labels: HTMLElement[];
  private readonly inputs: HTMLInputElement[];
  private readonly unitButton: HTMLButtonElement;
  private readonly lockButton: HTMLButtonElement;
  private readonly resetButton: HTMLButtonElement;

  constructor(
    private readonly el: HTMLElement,
    private readonly gizmo: Gizmo,
    private readonly doc: SceneDocument,
  ) {
    const q = <T extends HTMLElement>(sel: string) => el.querySelector<T>(sel)!;
    this.modeButtons = {
      translate: q('[data-mode="translate"]'),
      rotate: q('[data-mode="rotate"]'),
      scale: q('[data-mode="scale"]'),
    };
    this.labels = [...el.querySelectorAll<HTMLElement>('.field-label')];
    this.inputs = [...el.querySelectorAll<HTMLInputElement>('.field input')];
    this.unitButton = q('[data-action="unit"]');
    this.lockButton = q('[data-action="lock"]');
    this.resetButton = q('[data-action="reset-rotation"]');

    for (const m of Object.keys(this.modeButtons) as GizmoMode[]) {
      this.modeButtons[m].addEventListener('click', () => this.setMode(m));
    }
    this.inputs.forEach((input, i) => {
      input.addEventListener('change', () => this.applyInput(i, Number(input.value)));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
      });
    });
    this.unitButton.addEventListener('click', () => {
      updateSettings({ unit: UNITS[(UNITS.indexOf(settings.unit) + 1) % UNITS.length] });
    });
    const showLock = () => {
      this.gizmo.keepProportions = this.keepProportions;
      this.lockButton.classList.toggle('active', this.keepProportions);
      setIcon(this.lockButton, this.keepProportions ? 'lock' : 'lock-open');
    };
    showLock();
    this.lockButton.addEventListener('click', () => {
      this.keepProportions = !this.keepProportions;
      updateUi((ui) => (ui.keepProportions = this.keepProportions));
      showLock();
    });
    this.resetButton.addEventListener('click', () => {
      const objs = this.doc.selection;
      if (objs.length === 0) return;
      this.doc.checkpoint();
      for (const o of objs) o.mesh.rotation.set(0, 0, 0);
      this.doc.emit('transform');
    });

    // While a tool hands the handles its own object (a threaded hole being
    // placed), only Move and Rotate are offered and the fields don't apply.
    gizmo.proxyListeners.add((proxy) => {
      this.modeButtons.scale.disabled = proxy !== null;
      if (proxy && this.mode === 'scale') this.setMode('translate');
      else this.refresh();
    });
    doc.addEventListener('selection', () => this.refresh());
    doc.addEventListener('transform', () => this.refresh());
    settingsEvents.addEventListener('change', () => this.setMode(this.mode));
    this.setMode('translate');
  }

  setMode(mode: GizmoMode): void {
    this.mode = mode;
    this.gizmo.setMode(mode);
    for (const m of Object.keys(this.modeButtons) as GizmoMode[]) {
      this.modeButtons[m].classList.toggle('active', m === mode);
    }
    LABELS[mode].forEach((text, i) => (this.labels[i].textContent = text));
    this.unitButton.textContent = mode === 'rotate' ? 'deg' : settings.unit;
    this.unitButton.disabled = mode === 'rotate';
    this.lockButton.hidden = mode !== 'scale';
    this.resetButton.hidden = mode !== 'rotate';
    this.refresh();
  }

  private get targets(): SceneObject[] {
    return this.doc.selection;
  }

  /** Size along an object's own axes (one object) or of the selection's box (several), in mm. */
  private size(): THREE.Vector3 {
    const objs = this.targets;
    if (objs.length === 1) {
      const m = objs[0].mesh;
      const s = m.geometry.boundingBox!.getSize(new THREE.Vector3());
      return s.set(s.x * Math.abs(m.scale.x), s.y * Math.abs(m.scale.y), s.z * Math.abs(m.scale.z));
    }
    return this.doc.worldBox(objs).getSize(new THREE.Vector3());
  }

  private refresh(): void {
    if (this.gizmo.hasProxy) {
      this.el.classList.remove('disabled');
      this.inputs.forEach((i) => {
        i.disabled = true;
        i.value = '';
      });
      return;
    }
    const objs = this.targets;
    const rotateMany = this.mode === 'rotate' && objs.length > 1;
    this.el.classList.toggle('disabled', objs.length === 0);
    this.inputs.forEach((i) => (i.disabled = objs.length === 0 || rotateMany));
    if (objs.length === 0 || rotateMany) {
      this.inputs.forEach((i) => (i.value = ''));
      return;
    }
    let values: number[];
    switch (this.mode) {
      case 'translate': {
        const p = objs.length === 1 ? objs[0].mesh.position : this.doc.worldBox(objs).getCenter(new THREE.Vector3());
        values = AXES.map((a) => toUnit(p[a]));
        break;
      }
      case 'rotate':
        values = AXES.map((a) => THREE.MathUtils.radToDeg(objs[0].mesh.rotation[a]));
        break;
      case 'scale': {
        const s = this.size();
        values = AXES.map((a) => toUnit(s[a]));
        break;
      }
    }
    this.inputs.forEach((input, i) => {
      if (document.activeElement !== input) input.value = fmt(values[i]);
    });
  }

  private applyInput(axisIndex: number, value: number): void {
    const objs = this.targets;
    if (objs.length === 0 || !Number.isFinite(value)) return this.refresh();
    const axis = AXES[axisIndex];
    if (this.mode === 'scale' && value <= 0) return this.refresh();
    this.doc.checkpoint();
    switch (this.mode) {
      case 'translate': {
        const current = objs.length === 1
          ? objs[0].mesh.position[axis]
          : this.doc.worldBox(objs).getCenter(new THREE.Vector3())[axis];
        const delta = fromUnit(value) - current;
        for (const o of objs) o.mesh.position[axis] += delta;
        break;
      }
      case 'rotate':
        objs[0].mesh.rotation[axis] = THREE.MathUtils.degToRad(value);
        break;
      case 'scale': {
        const factor = fromUnit(value) / this.size()[axis];
        this.scaleBy(objs, this.keepProportions ? new THREE.Vector3().setScalar(factor) : new THREE.Vector3(1, 1, 1).setComponent(axisIndex, factor));
        break;
      }
    }
    this.doc.emit('transform');
  }

  /** Scale objects by per-axis factors around the selection's centre (bottom stays put). */
  private scaleBy(objs: SceneObject[], f: THREE.Vector3): void {
    if (objs.length === 1) {
      objs[0].mesh.scale.multiply(f);
      return;
    }
    const box = this.doc.worldBox(objs);
    const anchor = box.getCenter(new THREE.Vector3()).setZ(box.min.z);
    for (const o of objs) {
      o.mesh.position.sub(anchor).multiply(f).add(anchor);
      o.mesh.scale.multiply(f);
    }
  }
}
