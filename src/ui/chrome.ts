import libraries from '../libraries.json';
import type { SceneDocument } from '../scene/document';
import type { Viewport } from '../scene/viewport';
import { settings, updateUi } from '../settings';

/** About dialog: the bundled libraries with version, licence and a link to the local licence text. */
export function setupAbout(): void {
  const dialog = document.querySelector<HTMLDialogElement>('#about-dialog')!;
  const body = dialog.querySelector('#library-list')!;
  for (const lib of libraries) {
    const row = document.createElement('tr');
    const name = document.createElement('td');
    const link = document.createElement('a');
    link.href = lib.url;
    link.target = '_blank';
    link.rel = 'noopener';
    link.textContent = lib.name;
    name.append(link);
    const version = document.createElement('td');
    version.textContent = lib.version;
    const licence = document.createElement('td');
    if (lib.licenseFile) {
      const a = document.createElement('a');
      a.href = lib.licenseFile;
      a.target = '_blank';
      a.textContent = lib.license;
      licence.append(a);
    } else {
      licence.textContent = lib.license;
    }
    row.append(name, version, licence);
    body.append(row);
  }
  document.querySelector('[data-action="about"]')!.addEventListener('click', () => dialog.showModal());
}

/** The small keyboard-shortcuts panel on the view, toggled from the File menu and remembered. */
export function setupShortcutsPanel(): void {
  const panel = document.querySelector<HTMLElement>('#shortcuts-panel')!;
  panel.hidden = !settings.ui.shortcuts;
  for (const b of document.querySelectorAll('[data-action="shortcuts"]')) {
    b.addEventListener('click', () => {
      updateUi((ui) => (ui.shortcuts = !ui.shortcuts));
      panel.hidden = !settings.ui.shortcuts;
    });
  }
}

/** View toggles (X-ray, wireframe, edges, ground, shadows), restored from the last visit. */
export function setupViewToggles(doc: SceneDocument, viewport: Viewport): void {
  const apply = (key: keyof typeof settings.ui.view, on: boolean) => {
    switch (key) {
      case 'wireframe': doc.setView({ wireframe: on }); break;
      case 'xray': doc.setView({ xray: on }); break;
      case 'edges':
        doc.setView({ edges: on });
        // Measurement lines switch colour so they don't blend into edge lines.
        document.body.classList.toggle('edges-on', on);
        break;
      case 'grid': viewport.setGridVisible(on); break;
      case 'shadows': viewport.setShadows(on); break;
    }
    viewport.invalidate();
  };
  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-view]')) {
    const key = btn.dataset.view as keyof typeof settings.ui.view;
    btn.classList.toggle('active', settings.ui.view[key]);
    apply(key, settings.ui.view[key]);
    btn.addEventListener('click', () => {
      const on = !settings.ui.view[key];
      updateUi((ui) => (ui.view[key] = on));
      btn.classList.toggle('active', on);
      apply(key, on);
    });
  }
}
