import { applyAccent, settings, updateSettings, updateUi, type AccentId } from '../settings';
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
  // Custom: the swatch holds a colour input laid over it (so it stays keyboard
  // accessible); picking a colour selects Custom and applies it live.
  const custom = input('accentCustom');
  const customRadio = form.querySelector<HTMLInputElement>('input[name="accent"][value="custom"]')!;
  const paintCustom = () => form.querySelector<HTMLElement>('.accent-swatch[data-accent="custom"]')!.style.setProperty('--swatch', settings.ui.accentCustom);
  custom.value = settings.ui.accentCustom;
  paintCustom();
  const chooseCustom = () => {
    customRadio.checked = true;
    updateUi((ui) => {
      ui.accent = 'custom';
      ui.accentCustom = custom.value;
    });
    paintCustom();
    applyAccent();
  };
  custom.addEventListener('input', chooseCustom);
  custom.addEventListener('change', chooseCustom);
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
