import {
  settings, settingsEvents, snapDistanceChoices, snapDistanceLabel, updateSettings, updateUi, type ThemeChoice, type Unit,
} from '../settings';

/** Wire up the Settings dialog: units, colour mode, snapping and collision. */
export function setupSettingsDialog(openButton: HTMLElement): void {
  const dialog = document.querySelector<HTMLDialogElement>('#settings-dialog')!;
  const form = dialog.querySelector('form')!;

  const sync = () => {
    form.querySelector<HTMLInputElement>(`input[name="unit"][value="${settings.unit}"]`)!.checked = true;
    form.querySelector<HTMLInputElement>(`input[name="theme"][value="${settings.theme}"]`)!.checked = true;
    form.querySelector<HTMLInputElement>('input[name="snapping"]')!.checked = settings.snapping;
    // The step lists follow the unit (mm and cm: millimetres; inches: fractions) and wait while snapping is off.
    const distance = form.querySelector<HTMLSelectElement>('select[name="snapDistance"]')!;
    distance.replaceChildren(...snapDistanceChoices(settings.unit).map((mm) => new Option(snapDistanceLabel(mm, settings.unit), String(mm))));
    distance.value = String(settings.snapDistance);
    const angle = form.querySelector<HTMLSelectElement>('select[name="snapAngle"]')!;
    angle.value = String(settings.snapAngle);
    distance.disabled = angle.disabled = !settings.snapping;
    for (const el of [distance, angle]) el.closest('label')!.classList.toggle('disabled', !settings.snapping);
    form.querySelector<HTMLInputElement>('input[name="collision"]')!.checked = settings.collision;
    // The dashed lines belong to the Edges view: while it is off the choice is greyed out.
    const crossings = form.querySelector<HTMLInputElement>('input[name="internalIntersections"]')!;
    const off = !settings.ui.view.edges;
    crossings.checked = settings.ui.internalIntersections;
    crossings.disabled = off;
    const label = crossings.closest('label')!;
    label.classList.toggle('disabled', off);
    label.title = off ? 'Needs Edges on in View' : '';
    label.querySelector<HTMLElement>('.note')!.hidden = !off;
    // The inner edges come with the intersections: greyed while those are off.
    const inner = form.querySelector<HTMLInputElement>('input[name="internalEdges"]')!;
    const innerOff = !settings.ui.internalIntersections;
    inner.checked = settings.ui.internalEdges;
    inner.disabled = innerOff;
    inner.closest('label')!.classList.toggle('disabled', innerOff);
  };

  form.addEventListener('change', (e) => {
    const input = e.target as HTMLInputElement;
    switch (input.name) {
      case 'unit': updateSettings({ unit: input.value as Unit }); break;
      case 'theme': updateSettings({ theme: input.value as ThemeChoice }); break;
      case 'snapping': updateSettings({ snapping: input.checked }); break;
      case 'snapDistance': updateSettings({ snapDistance: Number(input.value) }); break;
      case 'snapAngle': updateSettings({ snapAngle: Number(input.value) }); break;
      case 'collision': updateSettings({ collision: input.checked }); break;
      case 'internalIntersections': updateUi((ui) => (ui.internalIntersections = input.checked)); break;
      case 'internalEdges': updateUi((ui) => (ui.internalEdges = input.checked)); break;
    }
    // The inner-edges checkbox depends on this one: grey it (or not) right away.
    if (input.name === 'internalIntersections') sync();
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
