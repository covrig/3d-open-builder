import libraries from '../libraries.json';
import type { SceneDocument } from '../scene/document';
import type { Viewport } from '../scene/viewport';
import { PANELS, settings, updateUi } from '../settings';
import { icon } from './icons';

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
  // The build plate is switched in Settings.
  const plate = document.querySelector<HTMLInputElement>('#settings-dialog input[name="plate"]')!;
  plate.checked = settings.ui.view.grid;
  apply('grid', settings.ui.view.grid);
  plate.addEventListener('change', () => {
    updateUi((ui) => (ui.view.grid = plate.checked));
    apply('grid', plate.checked);
  });
}

/** Same condition as the stylesheet's: the side panel is a drawer over the view. */
const DRAWER = window.matchMedia('(max-width: 900px), (orientation: portrait) and (max-width: 1100px)');

/**
 * The side panel opens from the Panel button at the top right of the view and
 * closes with the > button in the same spot (just left of the open panel). On wide screens it sits beside the view and
 * starts open; on narrow ones it slides over the view and starts closed.
 */
export function setupPanelToggle(): void {
  const body = document.body;
  const isOpen = () => (DRAWER.matches ? body.classList.contains('sidebar-open') : !body.classList.contains('sidebar-hidden'));
  const sync = () => body.classList.toggle('panel-closed', !isOpen());
  const setOpen = (open: boolean) => {
    if (DRAWER.matches) body.classList.toggle('sidebar-open', open);
    else body.classList.toggle('sidebar-hidden', !open);
    sync();
  };
  document.querySelector('[data-action="open-panel"]')!.addEventListener('click', () => setOpen(true));
  document.querySelector('[data-action="close-panel"]')!.addEventListener('click', () => setOpen(false));
  // Switching between drawer and side-by-side layouts starts that layout's default (open beside, closed as a drawer).
  DRAWER.addEventListener('change', () => {
    body.classList.remove('sidebar-open', 'sidebar-hidden');
    sync();
  });
  sync();
}

/**
 * "Select several": on touch screens there is no Ctrl key, so this switch
 * makes every tap add or remove an object, in the view and in the list.
 */
export const multiSelect = { on: false };

export function setupMultiSelect(): void {
  const button = document.querySelector<HTMLButtonElement>('[data-action="multi-select"]')!;
  button.addEventListener('click', () => {
    multiSelect.on = !multiSelect.on;
    button.classList.toggle('active', multiSelect.on);
    button.setAttribute('aria-pressed', String(multiSelect.on));
  });
}

/** Privacy statement in a box over the app (the separate privacy page stays for links). */
export function setupPrivacy(): void {
  const dialog = document.querySelector<HTMLDialogElement>('#privacy-dialog')!;
  document.querySelector('[data-action="privacy"]')!.addEventListener('click', () => dialog.showModal());
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close();
  });
}

/** Side panel sections in the order chosen in Settings (remembered), with up/down buttons to change it. */
export function setupPanelOrder(): void {
  const sidebar = document.querySelector<HTMLElement>('#sidebar')!;
  const list = document.querySelector<HTMLOListElement>('#panel-order')!;
  const names = new Map<string, string>(PANELS);

  const arrange = () => {
    for (const id of settings.ui.panelOrder) {
      const el = sidebar.querySelector(`:scope > [data-panel="${id}"]`);
      if (el) sidebar.append(el);
    }
    // The reference picture panel (shown only with a picture) stays just above Measure.
    const reference = sidebar.querySelector('#reference-panel');
    const measure = sidebar.querySelector('[data-panel="measure"]');
    if (reference && measure) measure.before(reference);
  };

  const move = (index: number, by: -1 | 1) => {
    const order = [...settings.ui.panelOrder];
    const j = index + by;
    if (j < 0 || j >= order.length) return;
    [order[index], order[j]] = [order[j], order[index]];
    updateUi((ui) => (ui.panelOrder = order));
    arrange();
    render();
    // Keep the keyboard focus on the moved row's same button.
    list.children[j]?.querySelector<HTMLButtonElement>(by < 0 ? '.up' : '.down')?.focus();
  };

  const render = () => {
    list.replaceChildren(...settings.ui.panelOrder.map((id, i, all) => {
      const li = document.createElement('li');
      const label = document.createElement('span');
      label.textContent = names.get(id) ?? id;
      const up = document.createElement('button');
      up.type = 'button';
      up.className = 'up';
      up.setAttribute('aria-label', `Move ${label.textContent} up`);
      up.append(icon('chevron-up'));
      up.disabled = i === 0;
      up.addEventListener('click', () => move(i, -1));
      const down = document.createElement('button');
      down.type = 'button';
      down.className = 'down';
      down.setAttribute('aria-label', `Move ${label.textContent} down`);
      down.append(icon('chevron-down'));
      down.disabled = i === all.length - 1;
      down.addEventListener('click', () => move(i, 1));
      li.append(label, up, down);
      return li;
    }));
  };

  arrange();
  render();
}
