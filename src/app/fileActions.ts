import type { Autosave, SavedScene } from './autosave';
import { clearAutosave, fromSaved, toSaved, validateSaved } from './autosave';
import { friendlyError } from './messages';
import { bounds, recenter } from '../geometry/meshOps';
import { IMPORT_EXTENSIONS, importFile, splitPieces } from '../io/importFile';
import { PROJECT_EXTENSION, readProject, writeProject } from '../io/project';
import { exportStl } from '../io/stl';
import { export3mf } from '../io/threemf';
import type { SceneDocument, SceneObject } from '../scene/document';
import type { Viewport } from '../scene/viewport';
import { IMPORT_UNITS, settings, updateSettings, updateUi, type ImportUnit } from '../settings';
import { isBusy, isLocked, setBusy } from '../ui/toolLock';
import { LOCKED_MESSAGE } from '../ui/toolGuard';

/** What the file actions need from the rest of the app. */
export interface FileActionsContext {
  doc: SceneDocument;
  viewport: Viewport;
  toast: (message: string) => void;
  autosave: Autosave;
  /** Stop Split and measuring: the drawing is about to be replaced. */
  stopTools: () => void;
  /** Remove what features keep in the autosave (the reference picture). */
  resetExtras: () => void;
  /** Give each feature its saved data back. */
  restoreExtras: (extras: Record<string, unknown>) => void;
  /** The object's volume, null if it is not a closed solid, undefined while a big mesh is still being checked. */
  solidState: (obj: SceneObject) => number | null | undefined;
  getSceneName: () => string;
  setSceneName: (name: string) => void;
}

export interface FileActions {
  openFiles: (files: File[]) => Promise<void>;
  /** Replace the drawing with a saved one (start-up restore, error recovery, Open project). */
  restoreSaved: (saved: SavedScene) => Promise<void>;
  /** The drawing counts as kept (a fresh starter object, say). */
  markExported: () => void;
}

// --- Export choices (pure, so they can be tested) -----------------------------

/** The objects an export writes: all of them, or only the shown ones. */
export function exportTargets<T extends { hidden?: boolean }>(objects: readonly T[], includeHidden: boolean): T[] {
  return includeHidden ? [...objects] : objects.filter((o) => !o.hidden);
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The line under the export choices: what will be written, and what to watch out for. */
export function exportSummary(info: {
  total: number;
  hidden: number;
  includeHidden: boolean;
  notSolid: string[];
  checking: number;
}): string {
  const out = info.includeHidden ? info.total : info.total - info.hidden;
  if (out <= 0) return 'Nothing to export: every object is hidden.';
  const parts: string[] = [];
  const left = !info.includeHidden && info.hidden > 0
    ? `; ${plural(info.hidden, 'hidden object is', 'hidden objects are')} left out`
    : '';
  parts.push(`${plural(out, 'object', 'objects')} will be exported${left}.`);
  if (info.notSolid.length > 0) {
    const shown = info.notSolid.slice(0, 3).join(', ');
    const more = info.notSolid.length - 3;
    parts.push(`${info.notSolid.length === 1 ? 'Not a closed solid' : 'Not closed solids'}: ${shown}${more > 0 ? ` and ${more} more` : ''}. A slicer may refuse ${info.notSolid.length === 1 ? 'it' : 'them'}; Check and Repair can fix most.`);
  }
  if (info.checking > 0) parts.push(`${plural(info.checking, 'large object is', 'large objects are')} still being checked.`);
  return parts.join(' ');
}

// --- The file actions -----------------------------------------------------------

const $ = <T extends HTMLElement = HTMLElement>(sel: string) => document.querySelector<T>(sel)!;
// Some actions have two buttons (toolbar, and the More menu on portrait screens).
const on = (sel: string, handler: () => void) => {
  for (const el of document.querySelectorAll(sel)) el.addEventListener('click', handler);
};

type ExportKind = '3mf' | 'stl' | 'project';
const EXPORT_SUFFIX = '_open_builder';
const lower = (f: File) => f.name.toLowerCase();
const isProjectFile = (f: File) => lower(f).endsWith(PROJECT_EXTENSION);
const supported = (f: File) => IMPORT_EXTENSIONS.some((ext) => lower(f).endsWith(ext));
const is3mf = (f: File) => lower(f).endsWith('.3mf');

function download(data: BlobPart, filename: string, type: string): void {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function setupFileActions(ctx: FileActionsContext): FileActions {
  const { doc, viewport, toast, autosave } = ctx;

  /** True once the scene has changed since it was last exported (or started). */
  let unexported = false;
  for (const type of ['change', 'transform'] as const) doc.addEventListener(type, () => (unexported = true));

  /** The file name used for the last export in this visit; proposed again next time. */
  let lastExportName: string | null = null;

  /** Proposed name: the last one used, else the imported file's name plus _open_builder, else open_builder. */
  function defaultExportName(): string {
    if (lastExportName) return lastExportName;
    const sceneName = ctx.getSceneName();
    if (sceneName === 'scene') return 'open_builder';
    return sceneName.endsWith(EXPORT_SUFFIX) ? sceneName : sceneName + EXPORT_SUFFIX;
  }

  // --- Export box -----------------------------------------------------------

  const exportDialog = $<HTMLDialogElement>('#export-dialog');
  const exportGo = $<HTMLButtonElement>('#export-go');
  // Enter in the name field exports (the form's first button is Cancel).
  $('#export-name').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (!exportGo.disabled) exportDialog.close('export');
    }
  });
  exportDialog.addEventListener('click', (e) => {
    if (e.target === exportDialog) exportDialog.close('cancel');
  });

  /** Ask for the file name (and for 3MF and STL, whether hidden objects go in) in a small box; null if cancelled. */
  async function askExportName(kind: ExportKind): Promise<{ name: string; includeHidden: boolean } | null> {
    const input = $<HTMLInputElement>('#export-name');
    const hiddenRow = $('#export-hidden-row');
    const hiddenBox = $<HTMLInputElement>('#export-hidden');
    const summary = $('#export-summary');
    const exporting = kind !== 'project';
    const hiddenCount = doc.objects.filter((o) => o.hidden).length;
    $('#export-title').textContent = kind === '3mf' ? 'Export 3MF' : kind === 'stl' ? 'Export STL' : 'Save project';
    $('#export-ext').textContent = kind === 'project' ? PROJECT_EXTENSION : `.${kind}`;
    $('#export-note').textContent = kind === '3mf'
      ? 'Each object keeps its own colour. Opens in most slicers.'
      : kind === 'stl'
        ? 'All objects as one mesh, without colours.'
        : 'Everything in this drawing: objects, groups, hidden objects, measurements and the reference picture. '
          + 'Only this app opens it; use Export for a slicer.';
    exportGo.textContent = exporting ? 'Export' : 'Save';
    hiddenRow.hidden = !exporting || hiddenCount === 0;
    hiddenBox.checked = settings.ui.exportHidden;
    summary.hidden = !exporting;
    const includeHidden = () => hiddenCount > 0 && hiddenBox.checked;

    let timer: number | undefined;
    const refresh = () => {
      clearTimeout(timer);
      if (!exporting) return;
      const targets = exportTargets(doc.objects, includeHidden());
      const states = targets.map((o) => ({ name: o.name, state: ctx.solidState(o) }));
      const checking = states.filter((s) => s.state === undefined).length;
      summary.textContent = exportSummary({
        total: doc.objects.length,
        hidden: hiddenCount,
        includeHidden: includeHidden(),
        notSolid: states.filter((s) => s.state === null).map((s) => s.name),
        checking,
      });
      exportGo.disabled = targets.length === 0;
      // Big meshes are checked in the background: look again until they are done.
      if (checking > 0) timer = window.setTimeout(refresh, 500);
    };
    hiddenBox.onchange = refresh;
    exportGo.disabled = false;
    refresh();

    input.value = defaultExportName();
    exportDialog.returnValue = '';
    exportDialog.showModal();
    input.focus();
    input.select();
    await new Promise<void>((resolve) => exportDialog.addEventListener('close', () => resolve(), { once: true }));
    clearTimeout(timer);
    hiddenBox.onchange = null;
    if (exportDialog.returnValue !== 'export') return null;
    const withHidden = includeHidden();
    if (exporting && hiddenCount > 0) updateUi((ui) => (ui.exportHidden = hiddenBox.checked));
    // No folders or characters that file systems refuse; a typed extension is dropped.
    const name = input.value.trim().replace(/\.(3mf|stl|3dob)$/i, '').replace(/[\\/:*?"<>|]+/g, '_').trim();
    return { name: name || defaultExportName(), includeHidden: withHidden };
  }

  async function exportThreeMf(): Promise<void> {
    if (doc.objects.length === 0) return toast('The scene is empty');
    const choice = await askExportName('3mf');
    if (!choice) return;
    const bytes = export3mf(exportTargets(doc.objects, choice.includeHidden).map((o) => doc.placed(o)));
    download(bytes as Uint8Array<ArrayBuffer>, `${choice.name}.3mf`, 'model/3mf');
    lastExportName = choice.name;
    unexported = false;
  }

  async function exportStlFile(): Promise<void> {
    if (doc.objects.length === 0) return toast('The scene is empty');
    const choice = await askExportName('stl');
    if (!choice) return;
    download(exportStl(exportTargets(doc.objects, choice.includeHidden).map((o) => doc.placed(o))), `${choice.name}.stl`, 'model/stl');
    lastExportName = choice.name;
    unexported = false;
  }

  async function saveProject(): Promise<void> {
    if (doc.objects.length === 0) return toast('The scene is empty');
    const choice = await askExportName('project');
    if (!choice) return;
    const extras: Record<string, unknown> = {};
    for (const [key, fn] of autosave.extras) extras[key] = fn();
    const bytes = writeProject(toSaved(doc.exportState(), ctx.getSceneName(), extras));
    download(bytes as Uint8Array<ArrayBuffer>, `${choice.name}${PROJECT_EXTENSION}`, 'application/octet-stream');
    lastExportName = choice.name;
    unexported = false;
  }

  // --- New, restore --------------------------------------------------------

  on('[data-action="new"]', () => {
    if (doc.objects.length > 0 && unexported
      && !confirm('Start a new scene? Changes you have not exported will be lost, including the autosaved copy.')) return;
    ctx.stopTools();
    doc.clear();
    ctx.resetExtras();
    ctx.setSceneName('scene');
    lastExportName = null;
    unexported = false;
    void clearAutosave();
    viewport.fit();
  });

  async function restoreSaved(saved: SavedScene): Promise<void> {
    const valid = validateSaved(saved); // before anything is cleared: a bad record must not wipe the scene
    ctx.stopTools();
    doc.loadState(fromSaved(valid));
    ctx.setSceneName(valid.name);
    lastExportName = null;
    ctx.restoreExtras(valid.extras ?? {});
    if (doc.objects.length > 0) viewport.fit(doc.worldBox(doc.objects));
    else viewport.fit();
  }

  // --- Project file ------------------------------------------------------------

  /** Open a project file in place of the drawing. True when it was opened. */
  async function openProject(file: File): Promise<boolean> {
    if (isLocked() || isBusy()) {
      toast(LOCKED_MESSAGE);
      return false;
    }
    if (doc.objects.length > 0 && unexported
      && !confirm('Open this project? Changes you have not exported will be lost, including the autosaved copy.')) return false;
    // The dialog was open for a while: something may have started meanwhile.
    if (isLocked() || isBusy()) {
      toast(LOCKED_MESSAGE);
      return false;
    }
    // Reading takes a moment; nothing else may change the scene meanwhile.
    setBusy(true);
    try {
      let saved: SavedScene;
      try {
        saved = readProject(new Uint8Array(await file.arrayBuffer()));
      } catch (err) {
        toast(`${file.name}: ${friendlyError(err)}`);
        return false;
      }
      await restoreSaved(saved);
      autosave.markDirty(); // the opened drawing is saved in this browser too
      unexported = false;
      return true;
    } catch (err) {
      toast(friendlyError(err));
      return false;
    } finally {
      setBusy(false);
    }
  }

  // --- Import ---------------------------------------------------------------

  /** Ask which unit an imported file's numbers are in; null if cancelled. */
  async function askImportUnit(only3mf: boolean): Promise<{ unit: ImportUnit; separate: boolean } | null> {
    const dialog = $<HTMLDialogElement>('#import-dialog');
    const separateBox = $<HTMLInputElement>('#import-separate');
    separateBox.checked = settings.ui.importSeparate;
    // 3MF files carry their own size: the unit only matters for STL and OBJ.
    $('#import-unit-note').hidden = !only3mf;
    for (const r of [...dialog.querySelectorAll<HTMLInputElement>('input[name="import-unit"]')]) {
      r.checked = r.value === settings.ui.importUnit;
      r.disabled = only3mf;
    }
    dialog.returnValue = '';
    dialog.showModal();
    await new Promise<void>((resolve) => dialog.addEventListener('close', () => resolve(), { once: true }));
    if (dialog.returnValue !== 'import') return null;
    const unit = only3mf
      ? settings.ui.importUnit
      : ([...dialog.querySelectorAll<HTMLInputElement>('input[name="import-unit"]')].find((r) => r.checked)?.value ?? 'mm') as ImportUnit;
    const separate = separateBox.checked;
    updateUi((ui) => {
      ui.importUnit = unit;
      ui.importSeparate = separate;
    });
    return { unit, separate };
  }
  {
    const dialog = $<HTMLDialogElement>('#import-dialog');
    dialog.addEventListener('click', (e) => {
      if (e.target === dialog) dialog.close('cancel');
    });
  }

  async function openFiles(all: File[]): Promise<void> {
    // A project file replaces the drawing: it is opened on its own.
    const project = all.find(isProjectFile);
    if (project) {
      const opened = await openProject(project);
      if (opened && all.length > 1) toast('Opened the project file only; the other files were ignored.');
      return;
    }
    const files = all.filter(supported);
    const rejected = all.filter((f) => !supported(f));
    if (rejected.length) {
      const names = rejected.map((f) => f.name).join(', ');
      toast(`File not supported: ${names}. Open 3MF, STL, OBJ or project (${PROJECT_EXTENSION}) files.`);
    }
    if (files.length === 0) return;
    if (isLocked() || isBusy()) return toast(LOCKED_MESSAGE);
    const choice = await askImportUnit(files.every(is3mf));
    if (!choice) return;
    // The dialog was open for a while: something may have started meanwhile.
    if (isLocked() || isBusy()) return toast(LOCKED_MESSAGE);
    // Reading the files takes time (in the worker); nothing else may change the scene meanwhile.
    setBusy(true);
    try {
      await addImported(files, choice);
    } finally {
      setBusy(false);
    }
  }

  async function addImported(files: File[], choice: { unit: ImportUnit; separate: boolean }): Promise<void> {
    const factor = IMPORT_UNITS[choice.unit];
    const added: SceneObject[] = [];
    let checkpointed = false;
    /** An STL or OBJ file was opened in the chosen unit */
    let unitFromFile = false;
    for (const file of files) {
      let parts;
      try {
        parts = await importFile(file);
        // Optionally one object per separate piece (named like the part, numbered by doc.add).
        // Inside the try, before the checkpoint: a failure here changes nothing.
        if (choice.separate) parts = parts.flatMap((p) => splitPieces(p.data).map((data) => ({ ...p, data })));
      } catch (err) {
        toast(`${file.name}: ${friendlyError(err)}`);
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
      // The file's numbers are in its own unit; everything here is in mm.
      if (factor !== 1 && !is3mf(file)) {
        for (const p of parts) {
          const pos = p.data.positions;
          for (let i = 0; i < pos.length; i++) pos[i] *= factor;
        }
      }
      // Keep the parts' layout relative to each other, but centre the whole
      // file on the plate and rest it on the plate surface.
      const all = parts.map((p) => bounds(p.data));
      const min = [0, 1, 2].map((k) => Math.min(...all.map((b) => b.min[k])));
      const max = [0, 1, 2].map((k) => Math.max(...all.map((b) => b.max[k])));
      const shift = [-(min[0] + max[0]) / 2, -(min[1] + max[1]) / 2, -min[2]];
      doc.batch(() => {
        for (const part of parts) {
          const { mesh, center } = recenter(part.data);
          const obj = doc.add(part.name, mesh, part.color);
          obj.mesh.position.set(center[0] + shift[0], center[1] + shift[1], center[2] + shift[2]);
          added.push(obj);
        }
      });
      ctx.setSceneName(file.name.replace(/\.[^.]+$/, ''));
      lastExportName = null;
      if (!is3mf(file)) unitFromFile = true;
    }
    // The unit the file was made in is most likely the one to work in: the page
    // switches to it (rulers, grid, sizes and tool bars). 3MF files store their size, so they don't.
    if (unitFromFile && settings.unit !== choice.unit) updateSettings({ unit: choice.unit });
    if (added.length) {
      doc.setSelection(added);
      viewport.fit(doc.worldBox(added));
    }
  }

  // --- Wiring -----------------------------------------------------------------

  on('[data-action="export-3mf"]', () => void exportThreeMf());
  on('[data-action="export-stl"]', () => void exportStlFile());
  on('[data-action="save-project"]', () => void saveProject());

  const fileInput = $<HTMLInputElement>('#file-input');
  on('[data-action="open"]', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    void openFiles([...(fileInput.files ?? [])]);
    fileInput.value = '';
  });

  const projectInput = $<HTMLInputElement>('#project-input');
  on('[data-action="open-project"]', () => projectInput.click());
  projectInput.addEventListener('change', () => {
    const file = projectInput.files?.[0];
    projectInput.value = '';
    if (file) void openProject(file);
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
    if (isLocked() || isBusy()) return toast(LOCKED_MESSAGE);
    void openFiles(files);
  });

  return {
    openFiles,
    restoreSaved,
    markExported: () => {
      unexported = false;
    },
  };
}
