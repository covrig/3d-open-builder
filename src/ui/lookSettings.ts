import { settings, updateSettings, updateUi } from '../settings';
import { fitToolbar } from './toolbarFit';

/**
 * Settings for the keyboard and the toolbar: Enable shortcuts, hiding
 * Copy/Cut/Paste. (The plate and reflection live in the View panel.)
 */
export function setupLookSettings(): void {
  const form = document.querySelector<HTMLFormElement>('#settings-dialog form')!;
  const input = (name: string) => form.querySelector<HTMLInputElement>(`input[name="${name}"]`)!;

  // Single-key shortcuts (off by default). Hints in tooltips, menus and the shortcuts panel follow.
  const shortcuts = input('shortcuts');
  const applyShortcuts = () => document.body.classList.toggle('shortcuts-on', settings.shortcuts);
  shortcuts.checked = settings.shortcuts;
  shortcuts.addEventListener('change', () => {
    updateSettings({ shortcuts: shortcuts.checked });
    applyShortcuts();
  });
  applyShortcuts();

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
