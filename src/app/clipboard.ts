import type { SceneDocument, SceneObject, ObjectState } from '../scene/document';
import type { Gizmo } from '../scene/gizmo';
import { loadClipboard, saveClipboard } from '../ui/clipboardStore';
import type { SplitTool } from '../ui/splitTool';

/** How far (mm) a pasted copy is moved, so it doesn't hide the original. */
export const PASTE_OFFSET = 10;

/** What the edit actions need from the rest of the app. */
export interface EditActionsContext {
  doc: SceneDocument;
  gizmo: Gizmo;
  splitTool: SplitTool;
  toast: (message: string) => void;
  /** Run an action on the selection as one undo step (it asks for a selection first). */
  withSelection: (action: (objs: SceneObject[]) => void, min?: number) => void;
}

export interface EditActions {
  actions: Record<'copy' | 'cut' | 'paste' | 'duplicate' | 'delete' | 'undo' | 'redo', () => void>;
  /** Add copies of captured objects, moved along X by `offset`, and select them. */
  pasteStates: (states: ObjectState[], offset: number) => void;
}

/** Copy, cut, paste, duplicate, delete, undo and redo, with their buttons. */
export async function setupEditActions(ctx: EditActionsContext): Promise<EditActions> {
  const { doc, gizmo, splitTool, toast, withSelection } = ctx;
  let clipboard: ObjectState[] = await loadClipboard();
  let pasteCount = 0;

  function pasteStates(states: ObjectState[], offset: number): void {
    const copies = doc.addCopies(states);
    for (const c of copies) c.mesh.position.x += offset;
    doc.setSelection(copies);
  }

  function setClipboard(objs: SceneObject[]): void {
    clipboard = objs.map((o) => doc.capture(o));
    pasteCount = 0;
    void saveClipboard(clipboard);
  }

  const actions = {
    copy: () => {
      if (doc.selection.length === 0) return toast('Select an object first');
      setClipboard(doc.selection);
      toast(`Copied ${clipboard.length} object${clipboard.length > 1 ? 's' : ''}`);
    },
    cut: () => gizmo.dragging || withSelection((objs) => {
      setClipboard(objs);
      doc.remove(objs);
    }),
    paste: () => {
      if (clipboard.length === 0) return toast('Nothing has been copied yet');
      doc.transact(() => {
        pasteCount++;
        pasteStates(clipboard, PASTE_OFFSET * pasteCount);
      });
    },
    duplicate: () => withSelection((objs) => pasteStates(objs.map((o) => doc.capture(o)), PASTE_OFFSET)),
    delete: () => gizmo.dragging || withSelection((objs) => doc.remove(objs)),
    undo: () => {
      if (gizmo.dragging) return; // a handle is held: changing the scene now would break the drag
      splitTool.stop();
      doc.undo();
    },
    redo: () => {
      if (gizmo.dragging) return;
      splitTool.stop();
      doc.redo();
    },
  };
  for (const [name, fn] of Object.entries(actions)) {
    // Some actions (Delete) are keyboard and row-button only, with no toolbar button.
    document.querySelector(`[data-action="${name}"]`)?.addEventListener('click', fn);
  }

  // The Delete button in the view's corner (touch screens have no Delete key).
  for (const el of document.querySelectorAll('[data-action="delete-selection"]')) el.addEventListener('click', actions.delete);

  return { actions, pasteStates };
}
