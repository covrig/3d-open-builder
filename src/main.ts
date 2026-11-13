import * as THREE from 'three';
import './style.css';
import type { BooleanOp } from './geometry/booleans';
import { loadManifold } from './geometry/loadManifold';
import { cancelAll, onBusyChange, runOp } from './geometry/workerClient';
import { Autosave, clearAutosave, loadAutosave, restoreChoice } from './app/autosave';
import { setupEditActions, PASTE_OFFSET } from './app/clipboard';
import { setupFileActions } from './app/fileActions';
import { setupKeyboard } from './app/keyboard';
import { friendlyError } from './app/messages';
import { installErrorHandlers, watchGraphicsContext } from './app/errors';
import { bakeMesh } from './geometry/meshData';
import { largestFlatFaceNormal } from './geometry/meshOps';
import { countPieces } from './geometry/meshCheck';
import { createPrimitive, PRIMITIVE_NAMES } from './geometry/primitives';
import { OBJECT_COLORS, SceneDocument, setEdgeColor, type SceneObject } from './scene/document';
import { Gizmo } from './scene/gizmo';
import { Ruler } from './scene/ruler';
import { Viewport } from './scene/viewport';
import { settings, settingsEvents, watchTheme } from './settings';
import { ColorPopover } from './ui/colorPopover';
import { CombineTool } from './ui/combineTool';
import { CrossSection } from './ui/crossSection';
import { ExtrudeTool } from './ui/extrudeTool';
import { setupLookSettings } from './ui/lookSettings';
import { setupViewPopovers } from './ui/viewPopovers';
import { OverhangTool } from './ui/overhangTool';
import { setupViewCube } from './ui/viewCube';
import { renderIcons } from './ui/icons';
import { multiSelect, setupAbout, setupMultiSelect, setupPanelOrder, setupPanelToggle, setupPrivacy, setupShortcutsPanel, setupViewToggles } from './ui/chrome';
import { restrictNumberInputs } from './ui/numberInputs';
import { setupArrange, units } from './ui/arrange';
import { hideHint, showHint, watchCorner, watchTopBars } from './ui/hint';
import { setupDetailsPanel } from './ui/detailsPanel';
import { setupItemsPanel } from './ui/itemsPanel';
import { MeasureTool } from './ui/measureTool';
import { CheckTools } from './ui/checkTools';
import { FeatureBar } from './ui/featureBar';
import { viewClicks } from './ui/interaction';
import { setupCursorReadout } from './ui/cursorReadout';
import { ModifyTools } from './ui/modifyTools';
import { PartsTools } from './ui/partsTools';
import { TurnTools } from './ui/turnTools';
import { ShapeTools } from './ui/shapeTools';
import { ReferenceImage } from './ui/referenceImage';
import { setupMenus } from './ui/menu';
import { setupSettingsDialog } from './ui/settingsDialog';
import { SplitTool } from './ui/splitTool';
import { setupTooltips } from './ui/tooltip';
import { isBusy, isLocked, onlyViewLocked, onToolChange, setBusy } from './ui/toolLock';
import { OverlapLines } from './ui/overlapLines';
import { setupToolbarFit } from './ui/toolbarFit';
import { BUSY_MESSAGE, setupToolGuard } from './ui/toolGuard';
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
const { updateDetails, volumeOf } = setupDetailsPanel({ doc, wasm });
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
const NEEDS_AN_OBJECT = '[data-modify], [data-action="split"], [data-action="extrude-down"], [data-action="mirror"], [data-action="rotate90"], [data-action="check"], '
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
  const objs = doc.selection.length ? doc.selection : doc.objects.filter((o) => !o.hidden);
  ruler.update(objs.length ? doc.worldBox(objs) : null, viewport.palette, viewport.camera, viewport.labelFactor);
  viewport.invalidate();
}
// The rulers sit on the sides facing the camera: move them when it goes round to the other side.
viewport.beforeFrame(() => ruler.follow(viewport.camera));
// Their text keeps its size on screen: redo them when the zoom changes the label size.
viewport.addEventListener('labelscale', updateRuler);

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

/**
 * Run a heavy geometry job in the background worker, then apply its result.
 * One job at a time; while it runs a "Working…" hint shows. If the objects
 * it was computed for were deleted meanwhile, the result is dropped.
 */
/** What an object's result depends on: its shape (by reference) and its placement. */
function snapshot(objs: SceneObject[]): { data: unknown; matrix: number[] }[] {
  return objs.map((o) => {
    o.mesh.updateMatrixWorld();
    return { data: o.data, matrix: [...o.mesh.matrixWorld.elements] };
  });
}
async function heavy<T>(objs: SceneObject[], compute: () => Promise<T>, apply: (result: T) => void): Promise<void> {
  if (isBusy()) return toast(BUSY_MESSAGE);
  setBusy(true);
  try {
    const before = snapshot(objs);
    const result = await compute();
    const after = snapshot(objs);
    const same = objs.every((o, i) => doc.objects.includes(o)
      && before[i].data === after[i].data && before[i].matrix.every((v, k) => v === after[i].matrix[k]));
    if (!same) return toast('The objects changed while computing; nothing was applied');
    apply(result);
  } catch (err) {
    toast(friendlyError(err));
  } finally {
    setBusy(false);
  }
}


const splitTool = new SplitTool(viewport, doc, gizmo, heavy, toast);
new CheckTools(doc, toast);
const featureBar = new FeatureBar(viewport, gizmo, doc, toast);
new ModifyTools(viewport, doc, featureBar, heavy, toast);
new PartsTools(viewport, doc, featureBar, toast);
new TurnTools(doc, featureBar, toast);
new ShapeTools(wasm, doc, featureBar);
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
  () => ({
    opacity: settings.ui.view.edges ? (settings.ui.internalIntersections ? 0.45 : 0) : settings.ui.view.xray ? 0.05 : 0,
    snap: measure.active,
  }),
  () => isLocked() && !onlyViewLocked(),
);
measure.overlaps = overlaps;
onToolChange(() => overlaps.refresh());
$('#settings-dialog').addEventListener('change', (e) => {
  if ((e.target as HTMLInputElement).name === 'internalIntersections') overlaps.refresh();
});
for (const b of $$('[data-view="edges"], [data-view="xray"]')) b.addEventListener('click', () => overlaps.refresh());
setupViewCube(viewport);
setupLookSettings();
setupViewPopovers(viewport);
const colors = new ColorPopover(doc, (picking) => {
  $('#viewport').classList.toggle('picking', picking);
  if (picking) showHint('eyedropper', 'Copy colour: click the object whose colour you want.');
  else hideHint('eyedropper');
});
setupItemsPanel($('#sidebar'), doc, colors, {
  toggleHidden: (obj) => doc.transact(() => doc.setHidden([obj], !obj.hidden)),
  duplicate: (obj) => doc.transact(() => pasteStates([doc.capture(obj)], PASTE_OFFSET)),
  remove: (obj) => doc.transact(() => doc.remove([obj])),
});

/** Run an action that needs a selection, with one undo step. */
function withSelection(action: (objs: SceneObject[]) => void, min = 1): void {
  if (doc.selection.length < min) {
    toast(min === 1 ? 'Select an object first' : `Select at least ${min} objects (Ctrl+click adds to the selection)`);
    return;
  }
  doc.transact(() => {
    action(doc.selection);
    doc.emit('transform');
  });
}

// --- Add objects ----------------------------------------------------------

/** Rest an object on the plate. */
function drop(obj: SceneObject): void {
  obj.mesh.position.z -= doc.worldBox([obj]).min.z;
}

// The shapes of the Add object menu ([data-insert]) open their own bar: see ShapeTools.

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
      if (result.empty) return toast("The objects don't overlap");
      doc.transact(() => {
        const color = selected[0].color;
        doc.remove(selected);
        const obj = doc.add('Object', result.mesh, color);
        const pieces = countPieces(result.mesh);
        if (pieces > 1) toast(`The objects don't touch, so the merged object is made of ${pieces} separate pieces.`);
        obj.mesh.position.set(...result.center);
        doc.setSelection([obj]);
      });
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
// Mirror and Rotate open the parameter bar: see TurnTools.

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

// Copy, cut, paste, duplicate, delete, undo and redo (and their buttons): see app/clipboard.ts.
const { actions, pasteStates } = await setupEditActions({ doc, gizmo, splitTool, toast, withSelection });

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

setupViewToggles(doc, viewport, ruler.group);
function fitView(): void {
  const objs = doc.selection.length ? doc.selection : doc.objects.filter((o) => !o.hidden);
  viewport.fit(doc.worldBox(objs));
}
on('[data-action="fit"]', fitView);
/** The starting view, zoomed out to show every object. */
const homeView = () => {
  const shown = doc.objects.filter((o) => !o.hidden);
  viewport.home(shown.length ? doc.worldBox(shown) : undefined);
};
on('[data-action="home"]', homeView);

/** Aim the shadow map at the objects so their shadows stay sharp wherever they are. */
function updateShadows(): void {
  const shown = doc.objects.filter((o) => !o.hidden);
  viewport.setShadowFocus(shown.length ? doc.worldBox(shown) : null);
}

// --- File -----------------------------------------------------------------

let sceneName = 'scene';

// --- Autosave, restore and error recovery ------------------------------------

const autosave = new Autosave(doc, () => sceneName, () =>
  toast('Autosave is not working: the browser storage is blocked or full. Use Export or Save project to keep your work.'));
/** Features that keep their own data in the autosave register how to restore it here. */
const extraRestorers = new Map<string, (value: unknown) => void>();
const reference = new ReferenceImage(viewport, doc, featureBar, toast, () => autosave.markDirty());
autosave.extras.set('reference', () => reference.serialize());

/** Save in the browser right away (Menu → Save, Ctrl+S); it also saves on its own every minute. */
const saveNow = () => void autosave.saveNow().then((ok) => {
  if (!ok) return toast('Could not save in this browser (its storage is blocked or full). Use Export or Save project to keep your work.');
  autosave.markClean();
  toast('Saved in this browser. To keep a file, use Export 3MF.');
});
on('[data-action="save"]', saveNow);
extraRestorers.set('reference', (v) => reference.restore(v));
function restoreExtras(extras: Record<string, unknown>): void {
  for (const [key, restore] of extraRestorers) restore(extras[key]);
}

const { openFiles, restoreSaved, markExported } = setupFileActions({
  doc,
  viewport,
  toast,
  autosave,
  stopTools: () => {
    splitTool.stop();
    measure.setKind(null);
  },
  resetExtras: () => reference.restore(null),
  restoreExtras,
  solidState: volumeOf,
  getSceneName: () => sceneName,
  setSceneName: (name) => (sceneName = name),
});

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
  markExported();
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
  dialog.returnValue = '';
  // Esc must not count as an answer: only the two buttons close this question.
  dialog.addEventListener('cancel', (e) => e.preventDefault());
  dialog.showModal();
  await new Promise<void>((resolve) => dialog.addEventListener('close', () => resolve(), { once: true }));
  autosave.suspend(false);
  if (restoreChoice(dialog.returnValue) === 'discard') return clearAutosave();
  try {
    await restoreSaved(saved);
  } catch (err) {
    toast(friendlyError(err));
    addStarter();
  }
}


// --- Undo / redo state ----------------------------------------------------

const undoBtn = $<HTMLButtonElement>('[data-action="undo"]');
const redoBtn = $<HTMLButtonElement>('[data-action="redo"]');
const updateHistory = () => {
  undoBtn.disabled = !doc.canUndo;
  redoBtn.disabled = !doc.canRedo;
};
doc.addEventListener('history', updateHistory);
updateHistory();

// --- Keyboard -------------------------------------------------------------

setupKeyboard({ doc, gizmo, featureBar, splitTool, crossSection, overhangs, actions, toast, saveNow, fitView, homeView });

// --- Clicking in the view -------------------------------------------------

// A click selects (or places a measuring point); a drag turns the camera.
// Gizmo handles sit in a layer above the canvas, so their clicks never get here.
const canvas = viewport.renderer.domElement;
let down: { x: number; y: number } | undefined;
canvas.addEventListener('pointerdown', (e) => {
  down = { x: e.clientX, y: e.clientY };
});
const cursorReadout = setupCursorReadout(viewport);
canvas.addEventListener('pointerleave', () => cursorReadout.hide());
canvas.addEventListener('pointermove', (e) => {
  // Before the tools' early return, so the readout works inside them too.
  if (e.pointerType !== 'touch') cursorReadout.update(e.clientX, e.clientY);
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

// Exposed for debugging in the browser console. The browser checks (scripts/browser-check.mjs) rely on these keys.
Object.assign(window, { app: { doc, viewport, gizmo, wasm, openFiles, autosave, measure, crossSection, overhangs, overlaps } });
