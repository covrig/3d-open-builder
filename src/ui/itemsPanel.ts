import type { SceneDocument, SceneObject } from '../scene/document';
import type { ColorPopover } from './colorPopover';
import { multiSelect } from './chrome';
import { icon } from './icons';

export interface RowActions {
  duplicate(obj: SceneObject): void;
  remove(obj: SceneObject): void;
  /** Hide the object from the view, or show it again. */
  toggleHidden(obj: SceneObject): void;
}

/** Sidebar "Objects" section: selection buttons and the list of objects. */
export function setupItemsPanel(el: HTMLElement, doc: SceneDocument, colors: ColorPopover, actions: RowActions): void {
  const list = el.querySelector<HTMLUListElement>('.items')!;
  const count = document.querySelector<HTMLElement>('#object-count')!;
  let renaming: SceneObject | undefined;

  el.querySelector('[data-action="select-all"]')!.addEventListener('click', () =>
    doc.setSelection(doc.objects),
  );
  el.querySelector('[data-action="deselect-all"]')!.addEventListener('click', () => doc.setSelection([]));
  el.querySelector('[data-action="invert-selection"]')!.addEventListener('click', () =>
    doc.setSelection(doc.objects.filter((o) => !doc.selection.includes(o))),
  );

  /** Swap the name for a text field; Enter or leaving the field saves, Esc cancels. */
  const startRename = (obj: SceneObject, nameEl: HTMLElement) => {
    renaming = obj;
    const input = document.createElement('input');
    input.className = 'rename';
    input.value = obj.name;
    nameEl.replaceWith(input);
    input.focus();
    input.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true;
      renaming = undefined;
      const name = input.value.trim();
      if (save && name && name !== obj.name) {
        doc.checkpoint();
        doc.rename(obj, name);
      } else {
        render();
      }
    };
    input.addEventListener('keydown', (e) => {
      e.stopPropagation(); // keep Delete / Ctrl+A etc. for the text field
      if (e.key === 'Enter') finish(true);
      if (e.key === 'Escape') finish(false);
    });
    input.addEventListener('blur', () => finish(true));
    input.addEventListener('click', (e) => e.stopPropagation());
  };

  const rows = new Map<SceneObject, HTMLLIElement>();

  /** Selection changes only restyle rows, so a double-click on a name still lands on it. */
  const updateSelected = () => {
    const n = doc.objects.length;
    const s = doc.selection.length;
    count.textContent = n === 0 ? '' : s > 0 ? `${s} of ${n} selected` : `${n}`;
    for (const [obj, li] of rows) li.classList.toggle('selected', doc.selection.includes(obj));
  };

  const render = () => {
    if (renaming) return; // don't destroy the text field while typing
    rows.clear();
    const n = doc.objects.length;
    if (n === 0) {
      const li = document.createElement('li');
      li.className = 'empty';
      li.textContent = 'Nothing yet. Add an object or open a file.';
      list.replaceChildren(li);
      return;
    }
    list.replaceChildren(
      ...doc.objects.map((obj) => {
        const li = document.createElement('li');
        const box = document.createElement('button');
        box.className = 'color-box';
        box.style.background = obj.color;
        box.dataset.tipTitle = 'Colour';
        box.dataset.tip = 'Click to pick a colour, copy one from another object, or go back to the default.';
        box.addEventListener('click', (e) => {
          e.stopPropagation();
          colors.open(box, obj);
        });
        const name = document.createElement('span');
        name.className = 'name';
        name.textContent = obj.name;
        name.dataset.tipTitle = obj.hidden ? `${obj.name} (hidden)` : obj.name;
        name.dataset.tip = obj.hidden
          ? 'Hidden from the view. Click the eye to show it again. Double-click to rename.'
          : 'Click to select (Ctrl+click adds). Double-click to rename.';
        li.classList.toggle('hidden-object', obj.hidden === true);
        name.addEventListener('dblclick', (e) => {
          e.stopPropagation();
          startRename(obj, name);
        });
        li.append(box, name);
        if (obj.groupId !== undefined) {
          const tag = document.createElement('span');
          tag.className = 'group-tag';
          tag.textContent = `G${obj.groupId}`;
          tag.dataset.tipTitle = `Group ${obj.groupId}`;
          tag.dataset.tip = 'This object is grouped with others; they select and move together.';
          li.append(tag);
        }
        // Small buttons that appear when hovering the row.
        const rowButton = (name: string, title: string, tip: string, fn: () => void) => {
          const b = document.createElement('button');
          b.className = 'row-action';
          b.append(icon(name));
          b.dataset.tipTitle = title;
          b.dataset.tip = tip;
          b.setAttribute('aria-label', title);
          b.addEventListener('click', (e) => {
            e.stopPropagation();
            fn();
          });
          return b;
        };
        const eye = obj.hidden
          ? rowButton('eye-off', 'Show', `Show ${obj.name} in the view again.`, () => actions.toggleHidden(obj))
          : rowButton('eye', 'Hide', `Hide ${obj.name} from the view. It stays in the drawing and is still exported.`, () => actions.toggleHidden(obj));
        eye.classList.add('visibility');
        li.append(
          rowButton('copy-plus', 'Duplicate', `Make a copy of ${obj.name}.`, () => actions.duplicate(obj)),
          rowButton('trash-2', 'Delete', `Remove ${obj.name}.`, () => actions.remove(obj)),
          eye,
        );
        li.addEventListener('click', (e) => doc.select(obj, e.ctrlKey || e.shiftKey || e.metaKey || multiSelect.on));
        rows.set(obj, li);
        return li;
      }),
    );
    updateSelected();
  };
  doc.addEventListener('change', render);
  doc.addEventListener('selection', updateSelected);
  render();
}
