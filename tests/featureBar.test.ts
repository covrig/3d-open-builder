// @vitest-environment happy-dom
import * as THREE from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SceneDocument } from '../src/scene/document';
import type { Gizmo } from '../src/scene/gizmo';
import type { Viewport } from '../src/scene/viewport';
import { FeatureBar, type FeatureSpec, type Values } from '../src/ui/featureBar';
import { isLocked } from '../src/ui/toolLock';

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  document.body.innerHTML = `<div id="feature-bar" hidden>
    <span class="bar-title"></span>
    <div class="feature-fields"></div>
    <div class="feature-main"></div>
    <span class="feature-info"></span>
    <div class="bar-actions">
      <button data-feature="apply">Apply</button>
      <button data-feature="cancel">Cancel</button>
    </div>
  </div>`;
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const setup = () => {
  const gizmo = { enabled: true } as unknown as Gizmo;
  const viewport = { scene: new THREE.Scene(), invalidate() {} } as unknown as Viewport;
  const doc = new SceneDocument(new THREE.Group());
  const toast = vi.fn();
  const bar = new FeatureBar(viewport, gizmo, doc, toast);
  return { bar, gizmo, toast };
};

type Result = { width: number };

/** A spec with one number field; `compute` can be replaced to control when and how it ends. */
function makeSpec(overrides: Partial<FeatureSpec<Result>> = {}) {
  const spec: FeatureSpec<Result> = {
    title: 'Test tool',
    hint: 'Do the thing',
    fields: [{ key: 'width', label: 'Width', type: 'number', value: 10, min: 1, unit: 'mm' }],
    compute: vi.fn(async (values: Values) => ({ width: Number(values.width) })),
    show: () => [],
    apply: vi.fn(),
    ...overrides,
  };
  return spec;
}

const input = () => document.querySelector<HTMLInputElement>('#feature-bar input[data-number]')!;
const info = () => document.querySelector<HTMLElement>('#feature-bar .feature-info')!.textContent;
const click = (selector: string) => document.querySelector<HTMLElement>(selector)!.click();
const apply = () => click('[data-feature="apply"]');
const cancel = () => click('[data-feature="cancel"]');
const type = (text: string) => {
  input().value = text;
  input().dispatchEvent(new Event('change'));
};
/** Run the debounce timer and let the compute promise settle. */
const settle = async () => {
  await vi.runOnlyPendingTimersAsync();
  await Promise.resolve();
};

describe('FeatureBar', () => {
  it('opening a spec shows the fields and locks the app; closing unlocks', async () => {
    const { bar, gizmo } = setup();
    expect(bar.active).toBe(false);
    bar.open(makeSpec());
    expect(document.querySelector<HTMLElement>('#feature-bar')!.hidden).toBe(false);
    expect(document.querySelector('#feature-bar .bar-title')!.textContent).toBe('Test tool');
    expect(document.querySelectorAll('#feature-bar .feature-fields input')).toHaveLength(1);
    expect(input().value).toBe('10');
    expect(bar.active).toBe(true);
    expect(isLocked()).toBe(true);
    expect(gizmo.enabled).toBe(false);
    cancel();
    expect(bar.active).toBe(false);
    expect(isLocked()).toBe(false);
    expect(gizmo.enabled).toBe(true);
    expect(document.querySelector<HTMLElement>('#feature-bar')!.hidden).toBe(true);
  });

  it('reads a typed decimal comma as a point', async () => {
    const { bar } = setup();
    const spec = makeSpec();
    bar.open(spec);
    type('2,5');
    await settle();
    expect(spec.compute).toHaveBeenLastCalledWith(expect.objectContaining({ width: 2.5 }), expect.any(AbortSignal));
    expect(input().value).toBe('2.5');
    bar.close();
  });

  it('an empty or non-numeric entry keeps the previous value', async () => {
    const { bar } = setup();
    const spec = makeSpec();
    bar.open(spec);
    type('7');
    type('');
    expect(input().value).toBe('7');
    type('abc');
    expect(input().value).toBe('7');
    await settle();
    expect(spec.compute).toHaveBeenLastCalledWith(expect.objectContaining({ width: 7 }), expect.any(AbortSignal));
    bar.close();
  });

  it('holds values to the field limits', async () => {
    const { bar } = setup();
    const spec = makeSpec({
      fields: [{ key: 'width', label: 'Width', type: 'number', value: 10, min: 1, max: 50, unit: 'mm' }],
    });
    bar.open(spec);
    type('0');
    expect(input().value).toBe('1');
    type('99');
    expect(input().value).toBe('50');
    await settle();
    expect(spec.compute).toHaveBeenLastCalledWith(expect.objectContaining({ width: 50 }), expect.any(AbortSignal));
    bar.close();
  });

  it('gives compute a signal that is aborted when a newer compute starts', async () => {
    const { bar } = setup();
    const signals: AbortSignal[] = [];
    const spec = makeSpec({
      compute: vi.fn((_values: Values, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<Result | null>(() => {}); // never ends by itself
      }),
    });
    bar.open(spec);
    await vi.runOnlyPendingTimersAsync(); // first compute (from open)
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    type('20');
    await vi.runOnlyPendingTimersAsync(); // second compute
    expect(signals).toHaveLength(2);
    expect(signals[0].aborted).toBe(true);
    expect(signals[1].aborted).toBe(false);
    bar.close();
  });

  it('aborts the running compute when the bar closes', async () => {
    const { bar } = setup();
    const signals: AbortSignal[] = [];
    const spec = makeSpec({
      compute: vi.fn((_values: Values, signal: AbortSignal) => {
        signals.push(signal);
        return new Promise<Result | null>(() => {});
      }),
    });
    bar.open(spec);
    await vi.runOnlyPendingTimersAsync();
    expect(signals[0].aborted).toBe(false);
    cancel();
    expect(signals[0].aborted).toBe(true);
  });

  it('Apply passes the latest result to spec.apply and closes the bar', async () => {
    const { bar } = setup();
    const spec = makeSpec();
    bar.open(spec);
    await settle();
    type('30');
    await settle();
    apply();
    expect(spec.apply).toHaveBeenCalledTimes(1);
    expect(spec.apply).toHaveBeenCalledWith({ width: 30 }, expect.objectContaining({ width: 30 }));
    expect(bar.active).toBe(false);
    expect(isLocked()).toBe(false);
  });

  it('Apply while a newer value is still being worked out waits for it', async () => {
    const { bar } = setup();
    const spec = makeSpec();
    bar.open(spec);
    await settle();
    input().value = '40'; // typed, but no change event yet (Enter can come first)
    apply();
    expect(spec.apply).not.toHaveBeenCalled();
    await settle();
    expect(spec.apply).toHaveBeenCalledWith({ width: 40 }, expect.objectContaining({ width: 40 }));
    expect(bar.active).toBe(false);
  });

  it('Cancel closes without applying', async () => {
    const { bar } = setup();
    const spec = makeSpec({ onClose: vi.fn() });
    bar.open(spec);
    await settle();
    cancel();
    expect(spec.apply).not.toHaveBeenCalled();
    expect(spec.onClose).toHaveBeenCalledTimes(1);
    expect(bar.active).toBe(false);
  });

  it('an error from compute shows in the info line, and Apply then does nothing', async () => {
    const { bar } = setup();
    const spec = makeSpec({
      compute: vi.fn(async () => {
        throw new Error('The shape is too thin');
      }),
    });
    bar.open(spec);
    await settle();
    expect(info()).toBe('The shape is too thin');
    apply();
    await settle();
    expect(spec.apply).not.toHaveBeenCalled();
    expect(bar.active).toBe(true);
    bar.close();
  });

  it('a result of null leaves nothing to apply', async () => {
    const { bar } = setup();
    const spec = makeSpec({ compute: vi.fn(async () => null) });
    bar.open(spec);
    await settle();
    apply();
    await settle();
    expect(spec.apply).not.toHaveBeenCalled();
    expect(info()).toBe('Nothing to apply yet');
    bar.close();
  });
});
