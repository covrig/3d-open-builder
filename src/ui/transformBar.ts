import * as THREE from 'three';
import type { Gizmo, GizmoMode } from '../scene/gizmo';
import type { SceneDocument, SceneObject } from '../scene/document';
import { fromUnit, lockEvents, setKeepProportions, settings, settingsEvents, toUnit, UNITS, updateSettings } from '../settings';
import { scaleObjects } from '../scene/resize';
import { setIcon } from './icons';
import { parseNumber } from './numberInputs';

const AXES = ['x', 'y', 'z'] as const;

const LABELS: Record<GizmoMode, [string, string, string]> = {
  translate: ['X', 'Y', 'Z'],
  // Rotating about X, Y and Z: the axis letter says which ring turns.
  rotate: ['Roll X', 'Pitch Y', 'Yaw Z'],
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
      input.addEventListener('change', () => this.applyInput(i, parseNumber(input.value)));
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
      });
      // The handle of the axis being typed in lights up in the view.
      input.addEventListener('focus', () => this.gizmo.setFocusAxis(i));
      input.addEventListener('input', () => this.gizmo.setFocusAxis(i));
      input.addEventListener('blur', () => this.gizmo.setFocusAxis(null));
    });
    this.unitButton.addEventListener('click', () => {
      updateSettings({ unit: UNITS[(UNITS.indexOf(settings.unit) + 1) % UNITS.length] });
    });
    const showLock = () => {
      const keep = settings.ui.keepProportions;
      this.gizmo.keepProportions = keep;
      this.lockButton.classList.toggle('active', keep);
      setIcon(this.lockButton, keep ? 'lock' : 'lock-open');
    };
    showLock();
    this.lockButton.addEventListener('click', () => {
      setKeepProportions(!settings.ui.keepProportions);
    });
    // Also switched from the box that types a measured distance.
    lockEvents.addEventListener('change', showLock);
    this.resetButton.addEventListener('click', () => {
      const objs = this.doc.selection;
      if (objs.length === 0) return;
      this.doc.transact(() => {
        for (const o of objs) o.mesh.rotation.set(0, 0, 0);
        this.doc.emit('transform');
      });
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

  /**
   * Size of the selection's box along the world axes, in mm: the same X, Y and
   * Z as the rulers, the Details panel and the Size handles, also for a turned
   * object (a typed size stretches along these axes, see scaleObjects).
   */
  private size(): THREE.Vector3 {
    return this.doc.worldBox(this.targets).getSize(new THREE.Vector3());
  }

  /** Show the current values; `force` also rewrites the field being edited (an entry that was refused). */
  private refresh(force = false): void {
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
      if (force || document.activeElement !== input) input.value = fmt(values[i]);
    });
  }

  private applyInput(axisIndex: number, value: number): void {
    const objs = this.targets;
    if (objs.length === 0 || !Number.isFinite(value)) return this.refresh(true);
    const axis = AXES[axisIndex];
    if (this.mode === 'scale' && value <= 0) return this.refresh(true);
    this.doc.transact(() => {
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
          scaleObjects(this.doc, objs, settings.ui.keepProportions ? new THREE.Vector3().setScalar(factor) : new THREE.Vector3(1, 1, 1).setComponent(axisIndex, factor));
          break;
        }
      }
      this.doc.emit('transform');
    });
  }
}
