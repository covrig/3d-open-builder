// @vitest-environment happy-dom
import Module, { type ManifoldToplevel } from 'manifold-3d';
import * as THREE from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import type { CheckItem } from '../src/geometry/meshTools';
import { createPrimitive } from '../src/geometry/primitives';
import { SceneDocument } from '../src/scene/document';
import { otherBoxes, type Gizmo } from '../src/scene/gizmo';
import { packTargets, setupArrange } from '../src/ui/arrange';
import { describeCheck } from '../src/ui/checkTools';
import { parseNumber, restrictNumberInputs } from '../src/ui/numberInputs';
import { settings } from '../src/settings';
import { TransformBar } from '../src/ui/transformBar';
import { mirroredCopyStates } from '../src/ui/turnTools';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

describe('parseNumber', () => {
  it('reads a decimal point or a single comma, and refuses everything else', () => {
    expect(parseNumber('1,5')).toBe(1.5);
    expect(parseNumber('-0,25')).toBe(-0.25);
    expect(parseNumber('12.5')).toBe(12.5);
    expect(parseNumber(' 7 ')).toBe(7);
    expect(parseNumber('.5')).toBe(0.5);
    for (const bad of ['', '   ', 'abc', '1,2,3', '1.2.3', '1,2.3', '-', '1e3']) expect(parseNumber(bad)).toBeNaN();
  });
});

describe('number fields', () => {
  restrictNumberInputs();
  const field = (value: string, step?: string) => {
    const input = document.createElement('input');
    input.type = 'text';
    input.setAttribute('data-number', '');
    if (step) input.dataset.step = step;
    input.value = value;
    document.body.append(input);
    return input;
  };
  const press = (input: HTMLInputElement, key: string) => {
    const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
    input.dispatchEvent(e);
    return e.defaultPrevented;
  };

  it('lets digits, one decimal separator and a leading minus through', () => {
    const input = field('');
    input.focus();
    expect(press(input, '5')).toBe(false);
    expect(press(input, ',')).toBe(false);
    expect(press(input, '.')).toBe(false);
    expect(press(input, '-')).toBe(false);
    expect(press(input, 'e')).toBe(true);
    expect(press(input, 'a')).toBe(true);
    expect(press(input, 'Backspace')).toBe(false);
  });

  it('blocks a second separator and a minus that is not first', () => {
    const input = field('1,5');
    input.setSelectionRange(3, 3);
    expect(press(input, '.')).toBe(true);
    expect(press(input, '-')).toBe(true);
    input.setSelectionRange(0, 3); // selected text is replaced, so a separator is fine again
    expect(press(input, '.')).toBe(false);
  });

  it('Arrow Up and Down step the value and fire change', () => {
    const input = field('1,5', '0.5');
    let changes = 0;
    input.addEventListener('change', () => changes++);
    expect(press(input, 'ArrowUp')).toBe(true);
    expect(input.value).toBe('2');
    press(input, 'ArrowDown');
    press(input, 'ArrowDown');
    expect(input.value).toBe('1');
    expect(changes).toBe(3);
    const plain = field('4');
    press(plain, 'ArrowUp');
    expect(plain.value).toBe('5');
  });
});

describe('typed sizes in the transform bar', () => {
  const setup = () => {
    document.body.innerHTML = `<div id="bar">
      <button data-mode="translate"></button><button data-mode="rotate"></button><button data-mode="scale"></button>
      <label class="field"><span class="field-label"></span><input data-number /></label>
      <label class="field"><span class="field-label"></span><input data-number /></label>
      <label class="field"><span class="field-label"></span><input data-number /></label>
      <button data-action="unit"></button><button data-action="lock"></button><button data-action="reset-rotation"></button>
    </div>`;
    settings.ui.keepProportions = false; // one side at a time
    const doc = new SceneDocument(new THREE.Group());
    const gizmo = { setMode() {}, keepProportions: false } as unknown as Gizmo;
    const bar = new TransformBar(document.querySelector<HTMLElement>('#bar')!, gizmo, doc);
    const inputs = [...document.querySelectorAll<HTMLInputElement>('#bar input')];
    const type = (i: number, text: string) => {
      inputs[i].value = text;
      inputs[i].dispatchEvent(new Event('change'));
    };
    return { doc, bar, inputs, type };
  };

  it('an emptied or non-numeric field keeps the old value instead of moving to 0', () => {
    const { doc, inputs, type } = setup();
    const cube = doc.add('Cube', createPrimitive(wasm, 'cube'));
    cube.mesh.position.set(10, 20, 30);
    doc.setSelection([cube]);
    doc.emit('transform');
    expect(inputs[0].value).toBe('10');
    type(0, '');
    expect(cube.mesh.position.x).toBe(10);
    expect(inputs[0].value).toBe('10');
    type(1, 'abc');
    expect(cube.mesh.position.y).toBe(20);
    expect(inputs[1].value).toBe('20');
    type(2, '12,5');
    expect(cube.mesh.position.z).toBe(12.5);
  });

  it('a size typed for a cube on the plate keeps its bottom on the plate', () => {
    const { doc, bar, type } = setup();
    const cube = doc.add('Cube', createPrimitive(wasm, 'cube', 40));
    cube.mesh.position.set(0, 0, 20);
    doc.setSelection([cube]);
    bar.setMode('scale');
    type(2, '80');
    const box = doc.worldBox([cube]);
    expect(box.min.z).toBeCloseTo(0, 3);
    expect(box.max.z).toBeCloseTo(80, 3);
  });

  it('a size typed for two objects stretches the turned one along the world axis', () => {
    const { doc, bar, type } = setup();
    const a = doc.add('A', createPrimitive(wasm, 'cube', { width: 10, depth: 20, height: 30 }));
    const b = doc.add('B', createPrimitive(wasm, 'cube', { width: 10, depth: 20, height: 30 }));
    a.mesh.position.set(-30, 0, 15);
    b.mesh.position.set(30, 0, 15);
    b.mesh.rotation.z = Math.PI / 4; // not a quarter turn, so the mesh is changed
    doc.setSelection([a, b]);
    bar.setMode('scale');
    const before = doc.worldBox([b]).getSize(new THREE.Vector3());
    const selection = doc.worldBox([a, b]).getSize(new THREE.Vector3());
    type(0, String(selection.x * 2));
    const after = doc.worldBox([b]).getSize(new THREE.Vector3());
    expect(after.x).toBeCloseTo(before.x * 2, 2);
    expect(after.y).toBeCloseTo(before.y, 2);
    expect(after.z).toBeCloseTo(before.z, 2);
    expect(b.mesh.quaternion.w).toBeCloseTo(1, 6); // turn baked into the mesh
    expect(doc.worldBox([a]).getSize(new THREE.Vector3()).y).toBeCloseTo(20, 2);
  });
});

describe('hidden objects', () => {
  const three = () => {
    const doc = new SceneDocument(new THREE.Group());
    const a = doc.add('A', createPrimitive(wasm, 'cube', 10));
    const b = doc.add('B', createPrimitive(wasm, 'cube', 10));
    const c = doc.add('C', createPrimitive(wasm, 'cube', 10));
    a.mesh.position.set(0, 0, 5);
    b.mesh.position.set(100, 0, 5);
    c.mesh.position.set(200, 0, 5);
    return { doc, a, b, c };
  };

  it('are not snapped to or bumped into while dragging', () => {
    const { doc, a, b } = three();
    expect(otherBoxes(doc, [a.mesh])).toHaveLength(2);
    doc.setHidden([b], true);
    const boxes = otherBoxes(doc, [a.mesh]);
    expect(boxes).toHaveLength(1);
    expect(boxes[0].min.x).toBeCloseTo(195, 3);
  });

  it('are left out of Pack when nothing is selected', () => {
    const { doc, a, b, c } = three();
    doc.setHidden([b], true);
    doc.setSelection([]);
    expect(packTargets(doc)).toEqual([a, c]);
    document.body.innerHTML = '<button data-action="pack"></button>';
    setupArrange(doc, () => {});
    document.querySelector<HTMLElement>('[data-action="pack"]')!.click();
    expect(b.mesh.position.x).toBe(100); // the hidden object did not move
    expect(a.mesh.position.x).not.toBe(0);
  });
});

describe('Mirror with "Keep the original"', () => {
  it('the copy of a bolt keeps no thread info', () => {
    const doc = new SceneDocument(new THREE.Group());
    const bolt = doc.add('Bolt', createPrimitive(wasm, 'cube', 10));
    bolt.thread = { kind: 'bolt', size: 'M6', length: 20, clearance: 0, origin: [0, 0, 0] };
    const mirrored = createPrimitive(wasm, 'cube', 12);
    const [state] = mirroredCopyStates(doc, [{ obj: bolt, mesh: mirrored, position: new THREE.Vector3(1, 2, 3) }]);
    expect(state.thread).toBeUndefined();
    expect(state.data).toBe(mirrored);
    expect(state.position).toEqual([1, 2, 3]);
    expect(bolt.thread).toBeDefined(); // the original keeps it
  });
});

describe('check messages in the chosen unit', () => {
  const thin: CheckItem = {
    id: 'thickness', label: 'Wall thickness', status: 'warn', fixable: false, detail: 'mm text',
    values: { minWall: 0.8, thinnest: 0.5, thinPercent: '12', halfPercent: '0' },
  };
  const orient: CheckItem = {
    id: 'orientation', label: 'Print orientation', status: 'warn', fixable: false, detail: 'mm text',
    values: { overhang: 100, overhangNow: 645.16, contact: 645.16, contactNow: 10 },
  };

  it('rebuilds thickness sentences from millimetres', () => {
    expect(describeCheck(thin, 'mm')).toBe('About 12% of the surface is thinner than 0.8 mm (thinnest 0.5 mm): it prints, but with fewer lines and less strength.');
    expect(describeCheck(thin, 'in')).toContain('thinner than 0.031 in (thinnest 0.02 in)');
    expect(describeCheck({ ...thin, status: 'fail', values: { minWall: 0.8, halfPercent: '3' } }, 'cm')).toBe(
      'About 3% of the surface is thinner than 0.04 cm: such thin parts may not print at all.');
  });

  it('rebuilds orientation sentences with squared units', () => {
    expect(describeCheck(orient, 'mm')).toBe('Turning it would cut overhangs from 645 mm² to 100 mm² (fewer supports) and rest it on 645 mm² instead of 10 mm² (sticks and stands better).');
    expect(describeCheck(orient, 'in')).toContain('cut overhangs from 1 in² to 0.16 in²');
    expect(describeCheck({ ...orient, status: 'pass', values: { overhangNow: 645.16 } }, 'in')).toBe('Current orientation is good (1 in² of overhang).');
  });

  it('keeps the original text for items without numbers', () => {
    expect(describeCheck({ id: 'normals', label: 'Normals', status: 'pass', fixable: false, detail: 'All faces point outward.' }, 'in')).toBe('All faces point outward.');
  });
});
