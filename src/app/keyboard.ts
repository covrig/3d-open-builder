import * as THREE from 'three';
import type { SceneDocument } from '../scene/document';
import type { Gizmo } from '../scene/gizmo';
import { settings } from '../settings';
import type { CrossSection } from '../ui/crossSection';
import type { FeatureBar } from '../ui/featureBar';
import { viewClicks } from '../ui/interaction';
import type { OverhangTool } from '../ui/overhangTool';
import type { SplitTool } from '../ui/splitTool';
import { isBusy, isLocked, isToolOpen, stopActiveTool } from '../ui/toolLock';
import { BUSY_MESSAGE, LOCKED_MESSAGE } from '../ui/toolGuard';
import type { EditActions } from './clipboard';

/** What the keyboard shortcuts need from the rest of the app. */
export interface KeyboardContext {
  doc: SceneDocument;
  gizmo: Gizmo;
  featureBar: FeatureBar;
  splitTool: SplitTool;
  crossSection: CrossSection;
  overhangs: OverhangTool;
  actions: EditActions['actions'];
  toast: (message: string) => void;
  saveNow: () => void;
  fitView: () => void;
  homeView: () => void;
}

/** Buttons whose tool can be run again with R (e.g. a second brace): edit, combine, add and mirror tools. */
const REPEATABLE = '[data-modify], [data-boolean], [data-thread], [data-insert], [data-action="mirror"], [data-action="duplicate"], [data-action="rotate90"], [data-action="split"], [data-action="extrude-down"]';

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

/** The element a key event is aimed at; the page body when its target is not an element (the document itself). */
const targetElement = (e: Event): HTMLElement => (e.target instanceof HTMLElement ? e.target : document.body);

/** Keyboard shortcuts: Esc, Enter, copy and paste, undo, nudging, and the single-key tool shortcuts. */
export function setupKeyboard(ctx: KeyboardContext): void {
  const { doc, gizmo, featureBar, splitTool, crossSection, overhangs, actions, toast } = ctx;

  // --- Repeat the last tool (R) ------------------------------------------------

  let lastTool: HTMLElement | null = null;
  document.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(REPEATABLE);
    if (el && e.isTrusted) lastTool = el;
  }, true);

  /** Run the last tool again, but only once the previous operation is finished. */
  function repeatLastTool(): void {
    if (!lastTool) return toast('Nothing to repeat yet: use a tool first');
    if (isBusy() && !isLocked() && !isToolOpen()) return toast(BUSY_MESSAGE);
    if (isToolOpen() || isLocked() || isBusy()) return toast(LOCKED_MESSAGE);
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
    if (document.querySelector('.menu:not([hidden]), .select-list, .view-popover:not([hidden])')) return; // the menu, list or popover closes itself
    if (stopActiveTool() || crossSection.close() || overhangs.close()) {
      e.preventDefault();
      e.stopPropagation();
      return;
    }
    if (!targetElement(e).closest('input, textarea, select')) doc.setSelection([]);
  }, true);

  // Enter applies the open tool, like its Apply button. A field being typed in
  // commits its value first (blur fires "change"); the feature bar then waits
  // for the preview of the new value before applying.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' || e.isComposing || e.repeat || e.ctrlKey || e.metaKey || e.altKey) return;
    if (document.querySelector('dialog[open], .select-list')) return;
    const t = targetElement(e);
    // Enter on a button or dropdown does that control's own thing.
    if (t.closest('button, select, textarea, a, [contenteditable]')) return;
    const inBar = t.closest('#feature-bar, #split-bar');
    if (t.closest('input') && !inBar) return;
    if (!featureBar.active && !splitTool.active) return;
    e.preventDefault();
    e.stopPropagation();
    if (t instanceof HTMLInputElement && inBar) t.blur();
    if (featureBar.active) featureBar.applyWhenReady();
    else splitTool.applyIfOpen();
  }, true);

  document.addEventListener('keydown', (e) => {
    const t = targetElement(e);
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
    const locked = isLocked() || isBusy() || gizmo.dragging;
    const refuse = () => run(() => toast(LOCKED_MESSAGE));
    if (ctrl && key === 'c') return run(actions.copy);
    if (ctrl && key === 's') return run(ctx.saveNow);
    const editing = (ctrl && ['z', 'y', 'x', 'v', 'a'].includes(key)) || (!ctrl && (e.key === 'Delete' || e.key === 'Backspace'));
    if (editing && locked) return refuse();
    if (ctrl && key === 'z' && !e.shiftKey) return run(actions.undo);
    if (ctrl && (key === 'y' || (key === 'z' && e.shiftKey))) return run(actions.redo);
    if (ctrl && key === 'x') return run(actions.cut);
    if (ctrl && key === 'v') return run(actions.paste);
    if (ctrl && key === 'a') return run(() => doc.setSelection(doc.objects));
    if (!ctrl && (e.key === 'Delete' || e.key === 'Backspace')) return run(actions.delete);
    // Single-key shortcuts, unless switched off in Settings (on by default).
    const single = settings.shortcuts && !ctrl && !e.altKey && !e.shiftKey;
    if (single && key === 'f') return run(ctx.fitView);
    if (single && key === 'h') return run(ctx.homeView);
    if (single && key === 'r') return run(repeatLastTool); // refuses itself while a tool is open
    // Tool keys press the tool's button (so R can repeat them), only with no tool open.
    const button = single ? TOOL_KEYS[key] : undefined;
    if (button && (locked || isToolOpen())) return refuse();
    if (button) {
      return run(() => {
        const el = document.querySelector<HTMLElement>(button)!;
        if (el.matches(REPEATABLE)) lastTool = el;
        el.click();
      });
    }
    // Arrow keys: an open tool (text) may use them to nudge;
    // with no tool open they move the selection.
    if (e.key.startsWith('Arrow') || e.key === 'PageUp' || e.key === 'PageDown') {
      if (viewClicks.onKey?.(e)) return e.preventDefault();
      if (doc.selection.length && !locked && !isToolOpen()) return run(() => nudgeSelection(e));
    }
  });
}
