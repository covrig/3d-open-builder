import * as THREE from 'three';
import './style.css';
import type { BooleanOp } from './geometry/booleans';
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
import { CrossSection } from './ui/crossSection';
import { ExtrudeTool } from './ui/extrudeTool';
import { setupLookSettings } from './ui/lookSettings';
import { OverhangTool } from './ui/overhangTool';
import { setupViewCube } from './ui/viewCube';
import { renderIcons } from './ui/icons';
import { multiSelect, setupAbout, setupMultiSelect, setupPanelOrder, setupPanelToggle, setupPrivacy, setupShortcutsPanel, setupViewToggles } from './ui/chrome';
import { restrictNumberInputs } from './ui/numberInputs';
import { setupArrange, units } from './ui/arrange';
import { hideHint, showHint, watchCorner, watchTopBars } from './ui/hint';
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
import { isLocked, isToolOpen, onlyViewLocked, onToolChange, stopActiveTool } from './ui/toolLock';
import { OverlapLines } from './ui/overlapLines';
import { setupToolbarFit } from './ui/toolbarFit';
import { LOCKED_MESSAGE, setupToolGuard } from './ui/toolGuard';
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
setupToolbarFit();
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
watchCorner();
setupArrange(doc, (msg) => toast(msg));
setupPanelToggle();
setupToolGuard((msg) => toast(msg), doc);
setupMultiSelect();

// With nothing selected and a single object in the drawing, the tools work on
// that object instead of asking to select it first. (After the tool guard, so a
// refused click changes nothing.) Delete and Cut are left out on purpose.
const NEEDS_AN_OBJECT = '[data-modify], [data-action="split"], [data-action="extrude-down"], [data-mirror], [data-action="check"], '
  + '[data-action="orient"], [data-action="duplicate"], [data-action="drop"], [data-action="lay-flat"], [data-action="center"]';
document.addEventListener('click', (e) => {
  if (doc.selection.length > 0 || !(e.target as Element).closest?.(NEEDS_AN_OBJECT)) return;
  const shown = doc.objects.filter((o) => !o.hidden);
  if (shown.length === 1) doc.setSelection(shown);
}, true);
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
// Cross-section view (More menu); measuring works on the cut.
const crossSection = new CrossSection(viewport, doc, gizmo);
measure.section = crossSection;
// Show overhangs (Check menu): a view tool like the cross-section.
const overhangs = new OverhangTool(viewport, gizmo);
// Faint lines where overlapping objects cross: 45% in the Edges view, 5% in X-ray
// without it, and snap targets while measuring.
const overlaps = new OverlapLines(
  viewport, doc,
  () => ({ opacity: settings.ui.view.edges ? 0.45 : settings.ui.view.xray ? 0.05 : 0, snap: measure.active }),
  () => isLocked() && !onlyViewLocked(),
);
measure.overlaps = overlaps;
onToolChange(() => overlaps.refresh());
for (const b of $$('[data-view="edges"], [data-view="xray"]')) b.addEventListener('click', () => overlaps.refresh());
setupViewCube(viewport);
setupLookSettings(viewport);
const colors = new ColorPopover(doc, (picking) => {
  $('#viewport').classList.toggle('picking', picking);
  if (picking) showHint('eyedropper', 'Copy colour: click the object whose colour you want.');
  else hideHint('eyedropper');
});
setupItemsPanel($('#sidebar'), doc, colors, {
  toggleHidden: (obj) => {
    doc.checkpoint();
    doc.setHidden([obj], !obj.hidden);
  },
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

const combine = new CombineTool(viewport, doc, featureBar, toast, heavy);

for (const btn of $$<HTMLButtonElement>('[data-boolean]')) {
  btn.addEventListener('click', () => {
    const op = btn.dataset.boolean as BooleanOp;
    // Subtract cuts the selection out of whatever it goes into; Intersect opens a step-by-step tool.
    if (op === 'difference') return combine.subtract();
    if (op === 'intersection') return combine.intersect();
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
  // Split shows its own cut; the cross-section would hide it.
  crossSection.close();
  if (splitTool.active) splitTool.stop();
  else splitTool.start();
});

// Extrude down: a level plane, and below it the shape at the plane down to the plate.
new ExtrudeTool(viewport, doc, featureBar, toast);
for (const btn of $$<HTMLButtonElement>('[data-mirror]')) {
  btn.addEventListener('click', () =>
    withSelection((objs) => {
      const axis = Number(btn.dataset.mirror) as 0 | 1 | 2;
      // A group mirrors as a whole: through the middle of the group, so its
      // parts swap sides too. A loose object mirrors through its own middle.
      for (const unit of units(doc, objs)) {
        const mid = (unit.box.min.getComponent(axis) + unit.box.max.getComponent(axis)) / 2;
        for (const obj of unit.objs) {
          // Bake rotation and scale into the geometry and mirror it about the
          // object's own origin, then place the origin's mirror image. The
          // object ends up with no rotation, which keeps the transform bar simple.
          const m = obj.mesh;
          const linear = new THREE.Matrix4().compose(new THREE.Vector3(), m.quaternion, m.scale);
          const mirrored = mirrorMesh(bakeMesh({ mesh: obj.data, matrix: linear.elements }), axis);
          const { mesh, center } = recenter(mirrored);
          doc.setData(obj, mesh);
          m.position.setComponent(axis, 2 * mid - m.position.getComponent(axis));
          m.position.add(new THREE.Vector3(...center));
          m.quaternion.identity();
          m.scale.set(1, 1, 1);
        }
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
  const cancel = el.querySelector<HTMLElement>('[data-action="cancel-op"]')!;
  onBusyChange((working) => {
    clearTimeout(timer);
    if (!working) {
      el.hidden = true;
      return;
    }
    timer = window.setTimeout(() => {
      // Its own box under any tool bar, so nothing resizes. Inside a tool its
      // Cancel is left out: the tool's Cancel also stops the calculation.
      el.hidden = false;
      cancel.hidden = isLocked();
    }, 400);
  });
  cancel.addEventListener('click', () => cancelAll());
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

// The Delete button in the view's corner (touch screens have no Delete key).
on('[data-action="delete-selection"]', actions.delete);

// --- Groups ---------------------------------------------------------------

on('[data-action="group"]', () => withSelection((objs) => doc.group(objs), 2));
on('[data-action="ungroup"]', () => {
  if (!doc.selection.some((o) => o.groupId !== undefined)) return toast('The selection has no groups');
  withSelection((objs) => doc.ungroup(objs));
});

// --- Arrange --------------------------------------------------------------

// A group rests on the plate as a whole: its lowest point, not each part's.
on('[data-action="drop"]', () => withSelection((objs) => {
  for (const unit of units(doc, objs)) for (const o of unit.objs) o.mesh.position.z -= unit.box.min.z;
}));

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
    // A group turns as a whole, onto the largest flat side of all its parts together.
    for (const unit of units(doc, objs)) {
      const baked = unit.objs.map((o) => bakeMesh(doc.placed(o)).positions);
      const all = new Float32Array(baked.reduce((n, p) => n + p.length, 0));
      baked.reduce((at, p) => (all.set(p, at), at + p.length), 0);
      const n = largestFlatFaceNormal(wasm, { positions: all, indices: new Uint32Array() });
      const turn = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(...n), new THREE.Vector3(0, 0, -1));
      const c = unit.box.getCenter(new THREE.Vector3());
      for (const o of unit.objs) {
        o.mesh.quaternion.premultiply(turn);
        o.mesh.position.sub(c).applyQuaternion(turn).add(c);
      }
      const low = doc.worldBox(unit.objs).min.z;
      for (const o of unit.objs) o.mesh.position.z -= low;
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

/** The file name used for the last export in this visit; proposed again next time. */
let lastExportName: string | null = null;
const EXPORT_SUFFIX = '_open_builder';

/** Proposed name: the last one used, else the imported file's name plus _open_builder, else open_builder. */
function defaultExportName(): string {
  if (lastExportName) return lastExportName;
  if (sceneName === 'scene') return 'open_builder';
  return sceneName.endsWith(EXPORT_SUFFIX) ? sceneName : sceneName + EXPORT_SUFFIX;
}

/** Ask for the file name in a small box; null if cancelled. */
async function askExportName(ext: '3mf' | 'stl'): Promise<string | null> {
  const dialog = $<HTMLDialogElement>('#export-dialog');
  const input = $<HTMLInputElement>('#export-name');
  $('#export-title').textContent = ext === '3mf' ? 'Export 3MF' : 'Export STL';
  $('#export-ext').textContent = `.${ext}`;
  $('#export-note').textContent = ext === '3mf'
    ? 'All objects, each with its own colour. Opens in most slicers.'
    : 'All objects as one mesh, without colours.';
  input.value = defaultExportName();
  dialog.returnValue = '';
  dialog.showModal();
  input.focus();
  input.select();
  await new Promise<void>((resolve) => dialog.addEventListener('close', () => resolve(), { once: true }));
  if (dialog.returnValue !== 'export') return null;
  // No folders or characters that file systems refuse; a typed extension is dropped.
  const name = input.value.trim().replace(/\.(3mf|stl)$/i, '').replace(/[\\/:*?"<>|]+/g, '_').trim();
  return name || defaultExportName();
}
{
  const dialog = $<HTMLDialogElement>('#export-dialog');
  // Enter in the name field exports (the form's first button is Cancel).
  $('#export-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      dialog.close('export');
    }
  });
  dialog.addEventListener('click', (e) => {
    if (e.target === dialog) dialog.close('cancel');
  });
}

async function exportThreeMf(): Promise<void> {
  if (doc.objects.length === 0) return toast('The scene is empty');
  const name = await askExportName('3mf');
  if (!name) return;
  const bytes = export3mf(doc.objects.map((o) => doc.placed(o)));
  download(bytes as Uint8Array<ArrayBuffer>, `${name}.3mf`, 'model/3mf');
  lastExportName = name;
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
  lastExportName = null;
  unexported = false;
  void clearAutosave();
  viewport.fit();
});
on('[data-action="export-3mf"]', () => void exportThreeMf());
on('[data-action="export-stl"]', async () => {
  if (doc.objects.length === 0) return toast('The scene is empty');
  const name = await askExportName('stl');
  if (!name) return;
  download(exportStl(doc.objects.map((o) => doc.placed(o))), `${name}.stl`, 'model/stl');
  lastExportName = name;
  unexported = false;
});

// --- Autosave, restore and error recovery ------------------------------------

const autosave = new Autosave(doc, () => sceneName);
/** Features that keep their own data in the autosave register how to restore it here. */
const extraRestorers = new Map<string, (value: unknown) => void>();
const reference = new ReferenceImage(viewport, doc, featureBar, toast, () => autosave.markDirty());
autosave.extras.set('reference', () => reference.serialize());

/** Save in the browser right away (Menu → Save, Ctrl+S); it also saves on its own every minute. */
const saveNow = () => void autosave.saveNow().then(() => {
  autosave.markClean();
  toast('Saved in this browser. To keep a file, use Export 3MF.');
});
on('[data-action="save"]', saveNow);
extraRestorers.set('reference', (v) => reference.restore(v));
function restoreExtras(extras: Record<string, unknown>): void {
  for (const [key, restore] of extraRestorers) restore(extras[key]);
}

async function restoreSaved(saved: SavedScene): Promise<void> {
  splitTool.stop();
  measure.setKind(null);
  doc.loadState(fromSaved(saved));
  sceneName = saved.name;
  lastExportName = null;
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
    lastExportName = null;
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

/** Single-key shortcuts: key → the button it presses (first match, the toolbar one when there are two). */
const TOOL_KEYS: Record<string, string> = {
  '1': '[data-insert="cube"]',
  '2': '[data-insert="cylinder"]',
  '3': '[data-insert="sphere"]',
  d: '[data-action="duplicate"]',
  s: '[data-action="split"]',
  m: '[data-boolean="union"]',
  n: '[data-boolean="difference"]',
  i: '[data-boolean="intersection"]',
  e: '[data-action="extrude-down"]',
  p: '[data-modify="pattern"]',
  b: '[data-modify="chamfer"]',
  o: '[data-modify="fillet"]',
};

/** Run the last tool again, but only once the previous operation is finished. */
function repeatLastTool(): void {
  if (!lastTool) return toast('Nothing to repeat yet: use a tool first');
  if (isToolOpen() || isLocked() || busy) return toast(LOCKED_MESSAGE);
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

// Esc always closes the open tool, whatever has the keyboard focus (a tool
// bar's field included) and whether shortcuts are on or not: a dropdown menu
// closes first, then the tool, then a view panel (cross-section, overhangs);
// else the selection clears. Dialogs close themselves.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || document.querySelector('dialog[open]')) return;
  if (document.querySelector('.menu:not([hidden]), .select-list')) return; // the menu or list closes itself
  if (stopActiveTool() || crossSection.close() || overhangs.close()) {
    e.preventDefault();
    e.stopPropagation();
    return;
  }
  if (!(e.target as HTMLElement).closest('input, textarea, select')) doc.setSelection([]);
}, true);

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
  // While a tool with Apply/Cancel is open (or a calculation runs), only what
  // can't disturb it works: Copy, the view keys, and the arrow keys the tool
  // itself uses. Undo, redo, cut, paste and Delete would change or remove what
  // the tool works on (docs/tool-rules.md).
  const locked = isLocked() || busy;
  const refuse = () => run(() => toast(LOCKED_MESSAGE));
  if (ctrl && key === 'c') return run(actions.copy);
  if (ctrl && key === 's') return run(saveNow);
  const editing = (ctrl && ['z', 'y', 'x', 'v', 'a'].includes(key)) || (!ctrl && (e.key === 'Delete' || e.key === 'Backspace'));
  if (editing && locked) return refuse();
  if (ctrl && key === 'z' && !e.shiftKey) return run(actions.undo);
  if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) return run(actions.redo);
  if (ctrl && key === 'x') return run(actions.cut);
  if (ctrl && key === 'v') return run(actions.paste);
  if (ctrl && key === 'a') return run(() => doc.setSelection(doc.objects));
  if (!ctrl && (e.key === 'Delete' || e.key === 'Backspace')) return run(actions.delete);
  // Single-key shortcuts, if switched on in Settings (off by default).
  const single = settings.shortcuts && !ctrl && !e.altKey && !e.shiftKey;
  if (single && key === 'f') return run(fitView);
  if (single && key === 'h') return run(homeView);
  if (single && key === 'r') return run(repeatLastTool); // refuses itself while a tool is open
  // Tool keys press the tool's button (so R can repeat them), only with no tool open.
  const button = single ? TOOL_KEYS[key] : undefined;
  if (button && (locked || isToolOpen())) return refuse();
  if (button) {
    return run(() => {
      const el = $(button);
      if (el.matches(REPEATABLE)) lastTool = el;
      el.click();
    });
  }
  // Arrow keys: an open tool (text, threaded hole) may use them to nudge;
  // with no tool open they move the selection.
  if (e.key.startsWith('Arrow') || e.key === 'PageUp' || e.key === 'PageDown') {
    if (viewClicks.onKey?.(e)) return e.preventDefault();
    if (doc.selection.length && !locked && !isToolOpen()) return run(() => nudgeSelection(e));
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
  // Inside a tool with Apply/Cancel, a click that isn't part of the tool's own
  // work (picking a face or edge, above) changes nothing: only Apply, Cancel
  // and Esc end a tool.
  if (isLocked()) return;

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
Object.assign(window, { app: { doc, viewport, gizmo, wasm, openFiles, autosave, measure, crossSection, overhangs, overlaps } });
