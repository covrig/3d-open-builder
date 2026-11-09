import type { Viewport } from '../scene/viewport';
import { settings, updateSettings, updateUi } from '../settings';

/**
 * Settings for how things look and the keyboard: plate see-through,
 * reflection, Enable shortcuts.
 */
export function setupLookSettings(viewport: Viewport): void {
  const form = document.querySelector<HTMLFormElement>('#settings-dialog form')!;
  const input = (name: string) => form.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;
  const shownValue = (el: HTMLInputElement, text: string) => {
    const out = el.parentElement!.querySelector('output');
    if (out) out.textContent = text;
  };
  const pct = (v: number) => `${Math.round(v * 100)}%`;

  // Single-key shortcuts (off by default). Hints in tooltips, menus and the shortcuts panel follow.
  const shortcuts = input('shortcuts');
  const applyShortcuts = () => document.body.classList.toggle('shortcuts-on', settings.shortcuts);
  shortcuts.checked = settings.shortcuts;
  shortcuts.addEventListener('change', () => {
    updateSettings({ shortcuts: shortcuts.checked });
    applyShortcuts();
  });
  applyShortcuts();

  // Plate see-through.
  const plate = input('plateOpacity');
  const applyPlate = () => {
    plate.value = String(settings.ui.plateOpacity);
    shownValue(plate, pct(1 - settings.ui.plateOpacity));
    viewport.setPlateOpacity(settings.ui.plateOpacity);
  };
  // The slider reads as "see-through": right is clearer.
  plate.addEventListener('input', () => {
    updateUi((ui) => (ui.plateOpacity = Number(plate.value)));
    applyPlate();
  });
  plate.style.direction = 'rtl';
  applyPlate();

  // Reflection.
  const reflectOn = input('reflection'), strength = input('reflectionStrength'), depth = input('reflectionDepth');
  const applyReflection = () => {
    const r = settings.ui.reflection;
    reflectOn.checked = r.on;
    strength.value = String(r.strength);
    depth.value = String(r.depth);
    strength.disabled = depth.disabled = !r.on;
    shownValue(strength, pct(r.strength));
    shownValue(depth, `${r.depth} mm`);
    viewport.reflection.set(r.on, r.strength, r.depth);
    viewport.invalidate();
  };
  reflectOn.addEventListener('change', () => {
    updateUi((ui) => (ui.reflection.on = reflectOn.checked));
    applyReflection();
  });
  strength.addEventListener('input', () => {
    updateUi((ui) => (ui.reflection.strength = Number(strength.value)));
    applyReflection();
  });
  depth.addEventListener('input', () => {
    updateUi((ui) => (ui.reflection.depth = Number(depth.value)));
    applyReflection();
  });
  applyReflection();
}
