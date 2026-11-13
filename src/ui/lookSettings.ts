import { applyAccent, settings, updateSettings, updateUi, type AccentId } from '../settings';
import { openColorPicker } from './colorPicker';
import { fitToolbar } from './toolbarFit';

/**
 * Settings for the keyboard and the toolbar: Enable shortcuts, hiding
 * Copy/Cut/Paste. (The plate and reflection live in the View panel.)
 */
export function setupLookSettings(): void {
  const form = document.querySelector<HTMLFormElement>('#settings-dialog form')!;
  const input = (name: string) => form.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;

  // Single-key shortcuts (on by default). Hints in tooltips, menus and the shortcuts panel follow.
  const shortcuts = input('shortcuts');
  const applyShortcuts = () => document.body.classList.toggle('shortcuts-on', settings.shortcuts);
  shortcuts.checked = settings.shortcuts;
  shortcuts.addEventListener('change', () => {
    updateSettings({ shortcuts: shortcuts.checked });
    applyShortcuts();
  });
  applyShortcuts();

  // Accent colour: round swatches; the choice is remembered and applied at once.
  const accents = form.querySelectorAll<HTMLInputElement>('input[name="accent"]');
  for (const a of accents) {
    a.checked = a.value === settings.ui.accent;
    a.addEventListener('change', () => {
      if (!a.checked) return;
      updateUi((ui) => (ui.accent = a.value as AccentId));
      applyAccent();
    });
  }
  // Custom: clicking the swatch (or Space/Enter on its radio) selects it and opens the in-app
  // picker; the colour applies live as it is dragged.
  const customRadio = form.querySelector<HTMLInputElement>('input[name="accent"][value="custom"]')!;
  const customSwatch = form.querySelector<HTMLElement>('.accent-swatch[data-accent="custom"]')!;
  const paintCustom = () => customSwatch.style.setProperty('--swatch', settings.ui.accentCustom);
  paintCustom();
  const chooseCustom = (hex: string) => {
    customRadio.checked = true;
    updateUi((ui) => {
      ui.accent = 'custom';
      ui.accentCustom = hex;
    });
    paintCustom();
    applyAccent();
  };
  const pickCustom = () => {
    customRadio.checked = true;
    openColorPicker({ anchor: customSwatch, value: settings.ui.accentCustom, onInput: chooseCustom });
  };
  customRadio.addEventListener('click', pickCustom); // mouse, touch, and Space on the focused radio
  customRadio.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      pickCustom();
    }
  });
  applyAccent();

  // Copy, Cut and Paste out of the toolbar (only on mouse screens, see the stylesheet): room for more tools.
  const hideClipboard = input('hideClipboard');
  const applyClipboard = () => {
    document.body.classList.toggle('hide-clipboard', settings.ui.hideClipboard);
    fitToolbar();
  };
  hideClipboard.checked = settings.ui.hideClipboard;
  hideClipboard.addEventListener('change', () => {
    updateUi((ui) => (ui.hideClipboard = hideClipboard.checked));
    applyClipboard();
  });
  applyClipboard();
}
