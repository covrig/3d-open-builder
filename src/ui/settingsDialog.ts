import { settings, settingsEvents, updateSettings, type ThemeChoice, type Unit } from '../settings';

/** Wire up the Settings dialog: units, colour mode, snapping and collision. */
export function setupSettingsDialog(openButton: HTMLElement): void {
  const dialog = document.querySelector<HTMLDialogElement>('#settings-dialog')!;
  const form = dialog.querySelector('form')!;

  const sync = () => {
    form.querySelector<HTMLInputElement>(`input[name="unit"][value="${settings.unit}"]`)!.checked = true;
    form.querySelector<HTMLInputElement>(`input[name="theme"][value="${settings.theme}"]`)!.checked = true;
    form.querySelector<HTMLInputElement>('input[name="snapping"]')!.checked = settings.snapping;
    form.querySelector<HTMLInputElement>('input[name="collision"]')!.checked = settings.collision;
  };

  form.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    switch (input.name) {
      case 'unit': updateSettings({ unit: input.value as Unit }); break;
      case 'theme': updateSettings({ theme: input.value as ThemeChoice }); break;
      case 'snapping': updateSettings({ snapping: input.checked }); break;
      case 'collision': updateSettings({ collision: input.checked }); break;
    }
  });
  settingsEvents.addEventListener('change', sync);
  openButton.addEventListener('click', () => {
    sync();
    dialog.showModal();
  });
  dialog.querySelector('[data-action="close-settings"]')!.addEventListener('click', () => dialog.close());
  // Clicking the dimmed backdrop closes the dialog.
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
}
