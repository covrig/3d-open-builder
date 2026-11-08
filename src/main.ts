import * as THREE from 'three';
import './style.css';
import type { BooleanOp } from './geometry/booleans';
import type { RoleOp } from './geometry/booleans';
import { loadManifold } from './geometry/loadManifold';
import { cancelAll, onBusyChange, runOp } from './geometry/workerClient';
import { Autosave, clearAutosave, fromSaved, loadAutosave, type SavedScene } from './app/autosave';
import { installErrorHandlers, watchGraphicsContext } from './app/errors';
import { bakeMesh, meshDataToManifold, type MeshData } from './geometry/meshData';
import { bounds, largestFlatFaceNormal, mirrorMesh, recenter } from './geometry/meshOps';
import { countPieces } from './geometry/meshCheck';
import { createPrimitive, PRIMITIVE_NAMES, type PrimitiveKind } from './geometry/primitives';
import { IMPORT_EXTENSIONS, importFile } from './io/importFile';
import { exportStl } from './io/stl';
import { export3mf } from './io/threemf';
import { OBJECT_COLORS, SceneDocument, setEdgeColor, type ObjectState, type SceneObject } from './scene/document';
import { Gizmo } from './scene/gizmo';
import { Ruler } from './scene/ruler';
import { Viewport } from './scene/viewport';
import { MM_PER_UNIT, settings, settingsEvents, toUnit, watchTheme } from './settings';
import { loadClipboard, saveClipboard } from './ui/clipboardStore';
import { ColorPopover } from './ui/colorPopover';
import { CombineTool } from './ui/combineTool';
import { ExtrudeTool } from './ui/extrudeTool';
import { renderIcons } from './ui/icons';
import { multiSelect, setupAbout, setupMultiSelect, setupPanelOrder, setupPanelToggle, setupPrivacy, setupShortcutsPanel, setupViewToggles } from './ui/chrome';
import { restrictNumberInputs } from './ui/numberInputs';
import { setupArrange } from './ui/arrange';
import { hideHint, showHint, watchTopBars } from './ui/hint';
import { setupItemsPanel } from './ui/itemsPanel';
import { MeasureTool } from './ui/measureTool';
import { CheckTools } from './ui/checkTools';
import { FeatureBar } from './ui/featureBar';
import { viewClicks } from './ui/interaction';
import { ModifyTools } from './ui/modifyTools';
import { PartsTools } from './ui/partsTools';
import { ReferenceImage } from './ui/referenceImage';
import { setupMenus } from './ui/menu';
import { setupSettingsDialog } from './ui/settingsDialog';
import { SplitTool } from './ui/splitTool';
import { setupTooltips } from './ui/tooltip';
import { isToolOpen, stopActiveTool } from './ui/toolLock';
import { TransformBar } from './ui/transformBar';

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
const $$ = <T extends HTMLElement = HTMLElement>(sel: string) => [...document.querySelectorAll<T>(sel)];
// Some actions have two buttons (toolbar, and the More menu on portrait screens).
const on = (sel: string, handler: () => void) => {
  for (const el of $$(sel)) el.addEventListener('click', handler);
};

renderIcons();
setupTooltips();
setupMenus();
restrictNumberInputs();
setupPanelOrder();
const wasm = await loadManifold();

/** Show why the app can't start, in place of the loading message, and stop here. */
async function cannotStart(message: string): Promise<never> {
  const el = $('#loading');
  el.textContent = message;
  el.classList.add('start-error');
  return new Promise<never>(() => {}); // never resolves: the rest of the app doesn't run
}

let viewport: Viewport;
try {
  viewport = new Viewport($('#viewport'));
} catch {
  // WebGL is missing or blocked (old driver, hardware acceleration off, locked-down browser).
  viewport = await cannotStart(
    'Your browser could not start 3D graphics (WebGL). Turn on hardware acceleration in the browser settings, '
    + 'update the browser or graphics driver, or try another browser.',
  );
}
const doc = new SceneDocument(viewport.objectRoot);
const gizmo = new Gizmo(viewport, doc);
new TransformBar($('#transform-bar'), gizmo, doc);
setupSettingsDialog($('[data-action="settings"]'));
setupAbout();
setupPrivacy();
setupShortcutsPanel();
watchTopBars();
setupArrange(doc, (msg) => toast(msg));
setupPanelToggle();
setupMultiSelect();
const ruler = new Ruler();
viewport.scene.add(ruler.group);
watchTheme((dark) => {
  viewport.setTheme(dark);
  setEdgeColor(viewport.palette.edges);
  updateRuler();
});
$('#loading').remove();

/** Rulers along the selection's footprint, or everything's when nothing is selected. */
function updateRuler(): void {
  const objs = doc.selection.length ? doc.selection : doc.objects;
  ruler.update(objs.length ? doc.worldBox(objs) : null, viewport.palette);
  viewport.invalidate();
}

// --- Messages -------------------------------------------------------------

let toastTimer: number | undefined;
function toast(message: string): void {
  const el = $('#toast');
  el.textContent = message;
  // "Select an object first" and the like: something the user has to do, so it stands out.
  el.classList.toggle('warn', /^(Select|Pick|Choose|Drop)\b/.test(message));
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => (el.hidden = true), 4000);
}

const errorText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * Run a heavy geometry job in the background worker, then apply its result.
 * One job at a time; while it runs a "Working…" hint shows. If the objects
 * it was computed for were deleted meanwhile, the result is dropped.
 */
let busy = false;
async function heavy<T>(objs: SceneObject[], compute: () => Promise<T>, apply: (result: T) => void): Promise<void> {
  if (busy) return toast('Still working on the previous operation…');
  busy = true;
  try {
    const result = await compute();
    if (!objs.every((o) => doc.objects.includes(o))) return toast('The objects changed while computing; nothing was applied');
    apply(result);
  } catch (err) {
    toast(errorText(err));
  } finally {
    busy = false;
  }
}


const splitTool = new SplitTool(viewport, doc, gizmo, heavy, toast);
new CheckTools(doc, toast);
const featureBar = new FeatureBar(viewport, gizmo, doc, toast);
new ModifyTools(viewport, doc, featureBar, heavy, toast);
new PartsTools(viewport, doc, gizmo, featureBar, heavy, toast);
const measure = new MeasureTool(viewport, doc, toast);
const colors = new ColorPopover(doc, (picking) => {
  $('#viewport').classList.toggle('picking', picking);
  if (picking) showHint('eyedropper', 'Copy colour: click the object whose colour you want. Esc to cancel.');
  else hideHint('eyedropper');
});
setupItemsPanel($('#sidebar'), doc, colors, {
  duplicate: (obj) => {
    doc.checkpoint();
    pasteStates([doc.capture(obj)], PASTE_OFFSET);
  },
  remove: (obj) => {
    doc.checkpoint();
    doc.remove([obj]);
  },
});

/** Run an action that needs a selection, with one undo step. */
function withSelection(action: (objs: SceneObject[]) => void, min = 1): void {
  if (doc.selection.length < min) {
    toast(min === 1 ? 'Select an object first' : `Select at least ${min} objects (Ctrl+click adds to the selection)`);
    return;
  }
  doc.checkpoint();
  action(doc.selection);
  doc.emit('transform');
}

// --- Add objects ----------------------------------------------------------

/** Rest an object on the plate. */
function drop(obj: SceneObject): void {
  obj.mesh.position.z -= doc.worldBox([obj]).min.z;
}

for (const btn of $$<HTMLButtonElement>('[data-insert]')) {
  btn.addEventListener('click', () => {
    doc.checkpoint();
    const kind = btn.dataset.insert as PrimitiveKind;
    const obj = doc.add(PRIMITIVE_NAMES[kind], createPrimitive(wasm, kind));
    drop(obj);
    doc.setSelection([obj]);
  });
}

// --- Combine --------------------------------------------------------------

const combine = new CombineTool(viewport, doc, featureBar, toast);
const ROLE_OPS: Partial<Record<BooleanOp, RoleOp>> = { difference: 'subtract', intersection: 'intersect' };

for (const btn of $$<HTMLButtonElement>('[data-boolean]')) {
  btn.addEventListener('click', () => {
    const op = btn.dataset.boolean as BooleanOp;
    // Subtract and Intersect open a step-by-step tool (which object is cut by which).
    const roleOp = ROLE_OPS[op];
    if (roleOp) return combine.start(roleOp);
    const selected = [...doc.selection];
    if (selected.length < 2) return toast('Select at least two objects (Ctrl+click adds to the selection)');
    void heavy(selected, () => runOp('boolean', { op, items: selected.map((o) => doc.placed(o)) }), (result) => {
      if (result.empty) return toast('Nothing is left: the objects do not overlap');
      doc.checkpoint();
      const color = selected[0].color;
      doc.remove(selected);
      const obj = doc.add('Object', result.mesh, color);
      const pieces = countPieces(result.mesh);
      if (pieces > 1) toast(`The objects don't touch, so the merged object is made of ${pieces} separate pieces.`);
      obj.mesh.position.set(...result.center);
      doc.setSelection([obj]);
    });
  });
}


// --- Edit: split, extrude down, mirror --------------------------------------

on('[data-action="split"]', () => {
  measure.setKind(null);
  if (splitTool.active) splitTool.stop();
  else splitTool.start();
});

// Extrude down: a level plane, and below it the shape at the plane down to the plate.
new ExtrudeTool(viewport, doc, featureBar, toast);
for (const btn of $$<HTMLButtonElement>('[data-mirror]')) {
  btn.addEventListener('click', () =>
    withSelection((objs) => {
      const axis = Number(btn.dataset.mirror) as 0 | 1 | 2;
      for (const obj of objs) {
        // Bake rotation and scale into the geometry, then mirror along the
        // plate axis through the object's centre. The object ends up with no
        // rotation, which keeps the numbers in the transform bar simple.
        const m = obj.mesh;
        const linear = new THREE.Matrix4().compose(new THREE.Vector3(), m.quaternion, m.scale);
        const mirrored = mirrorMesh(bakeMesh({ mesh: obj.data, matrix: linear.elements }), axis);
        const { mesh, center } = recenter(mirrored);
        doc.setData(obj, mesh);
        m.position.add(new THREE.Vector3(...center));
        m.quaternion.identity();
        m.scale.set(1, 1, 1);
      }
    }),
  );
}

// --- Working… and Cancel -------------------------------------------------------

// Shown while the geometry worker is busy for more than a moment (quick
// previews don't flash it). Cancel stops the calculation; nothing changes.
{
  const el = $('#busy');
  let timer: number | undefined;
  onBusyChange((working) => {
    clearTimeout(timer);
    if (working) timer = window.setTimeout(() => (el.hidden = false), 400);
    else el.hidden = true;
  });
  el.querySelector('[data-action="cancel-op"]')!.addEventListener('click', () => cancelAll());
}

// --- Clipboard ------------------------------------------------------------

let clipboard: ObjectState[] = await loadClipboard();
let pasteCount = 0;
const PASTE_OFFSET = 10; // mm, so pasted copies don't hide the original

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
  cut: () => withSelection((objs) => {
    setClipboard(objs);
    doc.remove(objs);
  }),
  paste: () => {
    if (clipboard.length === 0) return toast('Nothing has been copied yet');
    doc.checkpoint();
    pasteCount++;
    pasteStates(clipboard, PASTE_OFFSET * pasteCount);
  },
  duplicate: () => withSelection((objs) => pasteStates(objs.map((o) => doc.capture(o)), PASTE_OFFSET)),
  delete: () => withSelection((objs) => doc.remove(objs)),
  undo: () => {
    splitTool.stop();
    doc.undo();
  },
  redo: () => {
    splitTool.stop();
    doc.redo();
  },
};
for (const [name, fn] of Object.entries(actions)) {
  // Some actions (Delete) are keyboard and row-button only, with no toolbar button.
  document.querySelector(`[data-action="${name}"]`)?.addEventListener('click', fn);
}

// --- Groups ---------------------------------------------------------------

on('[data-action="group"]', () => withSelection((objs) => doc.group(objs), 2));
on('[data-action="ungroup"]', () => {
  if (!doc.selection.some((o) => o.groupId !== undefined)) return toast('The selection has no groups');
  withSelection((objs) => doc.ungroup(objs));
});

// --- Arrange --------------------------------------------------------------

on('[data-action="drop"]', () => withSelection((objs) => objs.forEach(drop)));

on('[data-action="center"]', () =>
  withSelection((objs) => {
    const c = doc.worldBox(objs).getCenter(new THREE.Vector3());
    for (const o of objs) {
      o.mesh.position.x -= c.x;
      o.mesh.position.y -= c.y;
    }
  }),
);

on('[data-action="lay-flat"]', () =>
  withSelection((objs) => {
    for (const obj of objs) {
      const n = largestFlatFaceNormal(wasm, bakeMesh(doc.placed(obj)));
      const turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...n), new THREE.Vector3(0, 0, -1));
      obj.mesh.quaternion.premultiply(turn);
      drop(obj);
    }
  }),
);

// --- View -----------------------------------------------------------------

setupViewToggles(doc, viewport);
function fitView(): void {
  viewport.fit(doc.worldBox(doc.selection.length ? doc.selection : doc.objects));
}
on('[data-action="fit"]', fitView);
/** The starting view, zoomed out to show every object. */
const homeView = () => viewport.home(doc.objects.length ? doc.worldBox(doc.objects) : undefined);
on('[data-action="home"]', homeView);

/** Aim the shadow map at the objects so their shadows stay sharp wherever they are. */
function updateShadows(): void {
  viewport.setShadowFocus(doc.objects.length ? doc.worldBox(doc.objects) : null);
}

// --- File -----------------------------------------------------------------

let sceneName = 'scene';

function download(data: BlobPart, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** True once the scene has changed since it was last exported (or started). */
let unexported = false;
for (const type of ['change', 'transform'] as const) doc.addEventListener(type, () => (unexported = true));

function exportThreeMf(): void {
  if (doc.objects.length === 0) return toast('The scene is empty');
  const bytes = export3mf(doc.objects.map((o) => doc.placed(o)));
  download(bytes as Uint8Array<ArrayBuffer>, `${sceneName}.3mf`, 'model/3mf');
  unexported = false;
}

on('[data-action="new"]', () => {
  if (doc.objects.length > 0 && unexported
    && !confirm('Start a new scene? Changes you have not exported will be lost, including the autosaved copy.')) return;
  splitTool.stop();
  measure.setKind(null);
  doc.clear();
  reference.restore(null);
  sceneName = 'scene';
  unexported = false;
  void clearAutosave();
  viewport.fit();
});
on('[data-action="export-3mf"]', exportThreeMf);
on('[data-action="export-stl"]', () => {
  if (doc.objects.length === 0) return toast('The scene is empty');
  download(exportStl(doc.objects.map((o) => doc.placed(o))), `${sceneName}.stl`, 'model/stl');
  unexported = false;
});

// --- Autosave, restore and error recovery ------------------------------------

const autosave = new Autosave(doc, () => sceneName);
/** Features that keep their own data in the autosave register how to restore it here. */
const extraRestorers = new Map<string, (value: unknown) => void>();
const reference = new ReferenceImage(viewport, doc, featureBar, toast, () => autosave.markDirty());
autosave.extras.set('reference', () => reference.serialize());
extraRestorers.set('reference', (v) => reference.restore(v));
function restoreExtras(extras: Record<string, unknown>): void {
  for (const [key, restore] of extraRestorers) restore(extras[key]);
}

async function restoreSaved(saved: SavedScene): Promise<void> {
  splitTool.stop();
  measure.setKind(null);
  doc.loadState(fromSaved(saved));
  sceneName = saved.name;
  restoreExtras(saved.extras ?? {});
  viewport.fit(doc.worldBox(doc.objects));
}

installErrorHandlers({
  restoreLastSave: async () => {
    const saved = await loadAutosave();
    if (!saved) return false;
    await restoreSaved(saved);
    toast('Returned to the last save point');
    return true;
  },
});
watchGraphicsContext(viewport.renderer.domElement);

/** A fresh start (nothing kept in this browser) gets a torus in the middle of the plate, in a random colour. */
function addStarter(): void {
  const color = OBJECT_COLORS[Math.floor(Math.random() * OBJECT_COLORS.length)];
  const obj = doc.add(PRIMITIVE_NAMES.torus, createPrimitive(wasm, 'torus'), color);
  drop(obj);
  doc.emit('transform');
  // Not something to warn about losing when starting a new drawing, nor to
  // offer to restore next time unless it gets changed.
  unexported = false;
  autosave.markClean();
}

/** On start, offer to continue with the autosaved scene, or start with a torus when there is none. */
async function offerRestore(): Promise<void> {
  const saved = await loadAutosave();
  if (!saved || saved.objects.length === 0) return addStarter();
  autosave.suspend(true);
  const dialog = $<HTMLDialogElement>('#restore-dialog');
  const n = saved.objects.length;
  $('#restore-text').textContent =
    `The last scene (${n} object${n > 1 ? 's' : ''}, saved ${new Date(saved.savedAt).toLocaleString()}) was kept in this browser.`;
  dialog.showModal();
  await new Promise<void>((resolve) => dialog.addEventListener('close', () => resolve(), { once: true }));
  autosave.suspend(false);
  if (dialog.returnValue === 'restore') await restoreSaved(saved);
  else await clearAutosave();
}

const supported = (f: File) => IMPORT_EXTENSIONS.some((ext) => f.name.toLowerCase().endsWith(ext));

async function openFiles(all: File[]): Promise<void> {
  const files = all.filter(supported);
  const rejected = all.filter((f) => !supported(f));
  if (rejected.length) {
    const names = rejected.map((f) => f.name).join(', ');
    toast(`File not supported: ${names}. Open 3MF, STL or OBJ files.`);
  }
  const added: SceneObject[] = [];
  let checkpointed = false;
  for (const file of files) {
    let parts;
    try {
      parts = await importFile(file);
    } catch (err) {
      toast(`${file.name}: ${errorText(err)}`);
      continue;
    }
    if (parts.length === 0) {
      toast(`${file.name} has no geometry`);
      continue;
    }
    if (!checkpointed) {
      doc.checkpoint();
      checkpointed = true;
    }
    // Keep the parts' layout relative to each other, but centre the whole
    // file on the plate and rest it on the plate surface.
    const all = parts.map((p) => bounds(p.data));
    const min = [0, 1, 2].map((k) => Math.min(...all.map((b) => b.min[k])));
    const max = [0, 1, 2].map((k) => Math.max(...all.map((b) => b.max[k])));
    const shift = [-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -min[2]];
    for (const part of parts) {
      const { mesh, center } = recenter(part.data);
      const obj = doc.add(part.name, mesh, part.color);
      obj.mesh.position.set(center[0] + shift[0], center[1] + shift[1], center[2] + shift[2]);
      added.push(obj);
    }
    sceneName = file.name.replace(/\.[^.]+$/, '');
  }
  if (added.length) {
    doc.setSelection(added);
    viewport.fit(doc.worldBox(added));
  }
}

const fileInput = $<HTMLInputElement>('#file-input');
const openDialog = () => fileInput.click();
on('[data-action="open"]', openDialog);
fileInput.addEventListener('change', () => {
  void openFiles([...(fileInput.files ?? [])]);
  fileInput.value = '';
});

const viewportEl = $('#viewport');
const dropHint = $('#drop-hint');
viewportEl.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropHint.hidden = false;
});
viewportEl.addEventListener('dragleave', () => (dropHint.hidden = true));
viewportEl.addEventListener('drop', (e) => {
  e.preventDefault();
  dropHint.hidden = true;
  const files = [...(e.dataTransfer?.files ?? [])];
  if (files.length === 0) return;
  void openFiles(files);
});

// --- Undo / redo state ----------------------------------------------------

const undoBtn = $<HTMLButtonElement>('[data-action="undo"]');
const redoBtn = $<HTMLButtonElement>('[data-action="redo"]');
const updateHistory = () => {
  undoBtn.disabled = !doc.canUndo;
  redoBtn.disabled = !doc.canRedo;
};
doc.addEventListener('history', updateHistory);
updateHistory();

// --- Repeat the last tool (R) ------------------------------------------------

/** Buttons whose tool can be run again with R (e.g. a second brace): edit, combine, add and mirror tools. */
const REPEATABLE = '[data-modify], [data-boolean], [data-thread], [data-insert], [data-mirror], [data-action="split"], [data-action="extrude-down"]';
let lastTool: HTMLElement | null = null;
document.addEventListener('click', (e) => {
  const el = (e.target as HTMLElement).closest<HTMLElement>(REPEATABLE);
  if (el && e.isTrusted) lastTool = el;
}, true);

/** Run the last tool again, but only once the previous operation is finished. */
function repeatLastTool(): void {
  if (!lastTool) return toast('Nothing to repeat yet: use a tool first');
  if (isToolOpen() || busy) return toast('Finish the current tool first (Apply, or Esc to cancel)');
  lastTool.click();
}

// --- Keyboard -------------------------------------------------------------

/**
 * Move the selection with the keyboard: arrows along X (left/right) and Y
 * (up/down, as seen on the plate), Page Up/Down along Z. The step is 1 mm
 * with snapping on (0.1 mm off); Shift moves ten times as far. A burst of
 * key presses is one undo step.
 */
let lastNudge = 0;
function nudgeSelection(e: KeyboardEvent): void {
  const step = (settings.snapping ? 1 : 0.1) * (e.shiftKey ? 10 : 1);
  const d = new THREE.Vector3(
    e.key === 'ArrowRight' ? step : e.key === 'ArrowLeft' ? -step : 0,
    e.key === 'ArrowUp' ? step : e.key === 'ArrowDown' ? -step : 0,
    e.key === 'PageUp' ? step : e.key === 'PageDown' ? -step : 0,
  );
  const now = performance.now();
  if (now - lastNudge > 1000) doc.checkpoint();
  lastNudge = now;
  for (const o of doc.selection) o.mesh.position.add(d);
  doc.emit('transform');
}

document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  // Leave typing in fields and dialogs alone.
  if (t.closest('input, textarea, select, dialog')) return;
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.toLowerCase();
  const run = (fn: () => void) => {
    e.preventDefault();
    fn();
  };
  if (ctrl && key === 'z' && !e.shiftKey) return run(actions.undo);
  if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) return run(actions.redo);
  if (ctrl && key === 'c') return run(actions.copy);
  if (ctrl && key === 'x') return run(actions.cut);
  if (ctrl && key === 'v') return run(actions.paste);
  if (ctrl && key === 'd') return run(actions.duplicate);
  if (ctrl && key === 'a') return run(() => doc.setSelection(doc.objects));
  if (!ctrl && (e.key === 'Delete' || e.key === 'Backspace')) return run(actions.delete);
  if (!ctrl && !e.altKey && key === 'f') return run(fitView);
  if (!ctrl && !e.altKey && key === 'h') return run(homeView);
  if (!ctrl && !e.altKey && key === 'r') return run(repeatLastTool);
  // Arrow keys: an active tool (text, threaded hole) may use them to nudge;
  // otherwise they move the selection.
  if (e.key.startsWith('Arrow') || e.key === 'PageUp' || e.key === 'PageDown') {
    if (viewClicks.onKey?.(e)) return e.preventDefault();
    if (doc.selection.length && !featureBar.active) return run(() => nudgeSelection(e));
  }
  if (e.key === 'Escape') {
    // Close the open tool (feature bar, split, measuring, colour picking), else deselect.
    if (!stopActiveTool()) doc.setSelection([]);

  }
});

// --- Clicking in the view -------------------------------------------------

// A click selects (or places a measuring point); a drag turns the camera.
// Gizmo handles sit in a layer above the canvas, so their clicks never get here.
const canvas = viewport.renderer.domElement;
let down: { x: number; y: number } | undefined;
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY };
});
canvas.addEventListener('pointermove', (e) => {
  if (viewClicks.onMove) return viewClicks.onMove(e);
  measure.move(e.clientX, e.clientY);
});
canvas.addEventListener('pointerup', (e) => {
  if (e.button !== 0 || !down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 4) return;
  if (viewClicks.onClick) return viewClicks.onClick(e);
  if (measure.active) return measure.click(e.clientX, e.clientY);

  const hit = viewport.pick(e.clientX, e.clientY);
  const obj = hit ? doc.byMesh(hit) : undefined;
  if (colors.pickingFor) return colors.finishPick(obj);

  const additive = e.ctrlKey || e.shiftKey || e.metaKey || multiSelect.on;
  if (obj) doc.select(obj, additive);
  else if (!additive) doc.setSelection([]);
});

// --- Selection feedback ---------------------------------------------------

// The outline in the view; the object list in the side panel names the selection.
function updateSelectionFeedback(): void {
  viewport.setOutlined(doc.selection.map((o) => o.mesh));
}

// --- Details --------------------------------------------------------------

const fmt = (v: number, digits = 1) => v.toLocaleString(undefined, { maximumFractionDigits: digits });

/**
 * Volume of each mesh, computed once. Moving and turning don't change it and
 * scaling multiplies it, so dragging never has to rebuild the solid.
 */
const volumeCache = new WeakMap<MeshData, number | null>();
function volumeOf(o: SceneObject): number | null {
  if (!volumeCache.has(o.data)) {
    try {
      const m = meshDataToManifold(wasm, o.data);
      volumeCache.set(o.data, m.volume());
      m.delete();
    } catch {
      volumeCache.set(o.data, null);
    }
  }
  const base = volumeCache.get(o.data)!;
  const s = o.mesh.scale;
  return base === null ? null : base * Math.abs(s.x * s.y * s.z);
}

function updateDetails(): void {
  const objs = doc.selection.length ? doc.selection : doc.objects;
  $('#details-scope').textContent = doc.selection.length ? 'Selection' : 'Whole scene';
  if (objs.length === 0) {
    for (const id of ['#detail-size', '#detail-tris', '#detail-volume']) $(id).textContent = '–';
    return;
  }
  const size = doc.worldBox(objs).getSize(new THREE.Vector3());
  const u = settings.unit;
  $('#detail-size').textContent = `${fmt(toUnit(size.x), 2)} × ${fmt(toUnit(size.y), 2)} × ${fmt(toUnit(size.z), 2)} ${u}`;
  $('#detail-tris').textContent = fmt(objs.reduce((n, o) => n + o.data.indices.length / 3, 0), 0);
  const volumes = objs.map(volumeOf);
  const open = volumes.filter((v) => v === null).length;
  const volume = volumes.reduce<number>((sum, v) => sum + (v ?? 0), 0);
  // Metric units show cm³ (what slicers use); imperial shows in³.
  const imperial = u === 'in';
  $('#detail-volume').textContent = open
    ? `${open} object${open > 1 ? 's are' : ' is'} not a closed solid`
    : imperial
      ? `${fmt(volume / MM_PER_UNIT.in ** 3, 2)} in³`
      : `${fmt(volume / 1000, 2)} cm³`;
}

function updateSections(): void {
  const n = doc.selection.length;
  for (const s of $$('#sidebar .needs-selection')) s.classList.toggle('inactive', n === 0);
}

doc.addEventListener('selection', () => {
  updateSections();
  updateDetails();
  updateSelectionFeedback();
  updateRuler();
});
doc.addEventListener('change', () => {
  updateDetails();
  updateSelectionFeedback();
  updateShadows();
  updateRuler();
});
// Moves come in with every mouse event; update the panels at most once a
// frame. While a handle is held only the rulers follow; the details and the
// shadow area catch up when it is let go (the drag ends with one more event).
let transformQueued = false;
doc.addEventListener('transform', () => {
  if (transformQueued) return;
  transformQueued = true;
  requestAnimationFrame(() => {
    transformQueued = false;
    updateRuler();
    if (gizmo.dragging) return;
    updateDetails();
    updateShadows();
  });
});
settingsEvents.addEventListener('change', () => {
  updateDetails();
  updateRuler();
});
updateSections();
updateDetails();
updateShadows();
void offerRestore();

// Exposed for debugging in the browser console.
Object.assign(window, { app: { doc, viewport, gizmo, wasm, openFiles, autosave } });
