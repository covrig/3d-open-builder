import type { SceneDocument } from '../scene/document';
import { isBusy, isLocked, onlyViewLocked, onToolChange } from './toolLock';

/**
 * While a tool with Apply/Cancel is open, the controls that would disturb it
 * are dimmed and don't respond; clicking one says why. The control that
 * opened the tool stays highlighted. Which controls stay usable is decided in
 * docs/tool-rules.md: the view (camera, view toggles, view cube, side panel),
 * Copy, settings, export, and the tool's own bar.
 */
export const LOCKED = [
  '.toolbar button:not([data-menu="file-menu"]):not([data-action="copy"]):not([data-action="settings-shortcut"])',
  '#file-menu [data-action="new"]',
  '#file-menu [data-action="open"]',
  '#file-menu [data-action="open-project"]',
  '#file-menu [data-action="reference"]',
  '#sidebar [data-panel="arrange"] button',
  '#sidebar [data-panel="objects"] button',
  '#sidebar .items li',
  '#measure-panel button',
  '#reference-panel button',
  '#transform-bar input',
  '#transform-bar [data-action="reset-rotation"]',
  '#transform-bar [data-action="lock"]',
  '#view-corner [data-action="multi-select"]',
  '#view-corner [data-action="delete-selection"]',
].join(', ');

export const LOCKED_MESSAGE = 'Finish or cancel the current tool first (Apply or Cancel)';
export const BUSY_MESSAGE = 'Still working on the previous operation…';

/** With only a view tool open (cross-section, overhangs), measuring still works. */
const VIEW_TOOL_ALLOWED = '#measure-panel button';

/** While a calculation runs, its Cancel button must keep working. */
const BUSY_ALLOWED = '[data-action="cancel-op"]';

/** Is this element locked right now? */
export function lockedNow(el: Element): boolean {
  if (isBusy() && el.closest(LOCKED) !== null && !el.closest(BUSY_ALLOWED)) return true;
  return isLocked() && el.closest(LOCKED) !== null && !(onlyViewLocked() && el.closest(VIEW_TOOL_ALLOWED));
}

/**
 * Tools that work on a single object. With a group or several objects
 * selected they are unavailable (docs/tool-rules.md lists every operation).
 */
export const SINGLE_ONLY = [
  '[data-modify="chamfer"]', '[data-modify="fillet"]', '[data-modify="shell"]', '[data-modify="soften"]',
  '[data-modify="gusset"]', '[data-modify="text"]', '[data-action="orient"]',
].join(', ');
export const SINGLE_ONLY_MESSAGE = 'Works on one object at a time. For a group, Merge it into one object first (or Ungroup and select one part).';
let manySelected = false;

/** Tools that need two or more objects in the drawing: dimmed while only one is shown. */
export const NEEDS_TWO = [
  '[data-boolean]', '[data-action="group"]', '[data-menu="align-menu"]', '[data-menu="distribute-menu"]',
  '#align-menu button', '#distribute-menu button',
].join(', ');
export const NEEDS_TWO_MESSAGE = 'Needs at least two objects in the drawing';
/** Ungroup only means something while a group is selected. */
export const NEEDS_GROUP = '[data-action="ungroup"]';
export const NEEDS_GROUP_MESSAGE = 'Select a group to ungroup';
let groupSelected = false;
let singleObject = false;

/** Why this control can't be used right now, or null if it can. */
export function blockReason(el: Element): string | null {
  if (lockedNow(el)) return isLocked() ? LOCKED_MESSAGE : BUSY_MESSAGE;
  if (manySelected && el.closest(SINGLE_ONLY)) return SINGLE_ONLY_MESSAGE;
  if (singleObject && el.closest(NEEDS_TWO)) return NEEDS_TWO_MESSAGE;
  if (!groupSelected && el.closest(NEEDS_GROUP)) return NEEDS_GROUP_MESSAGE;
  return null;
}

export function setupToolGuard(toast: (msg: string) => void, doc: SceneDocument): void {
  doc.addEventListener('selection', () => {
    manySelected = doc.selection.length > 1;
    document.body.classList.toggle('many-selected', manySelected);
  });
  // Exactly one visible object in the drawing: the two-object tools have nothing to work on.
  const countObjects = () => {
    singleObject = doc.objects.filter((o) => !o.hidden).length === 1;
    document.body.classList.toggle('single-object', singleObject);
  };
  for (const type of ['change', 'selection', 'history'] as const) doc.addEventListener(type, countObjects);
  countObjects();
  // A group is selected (some selected object has a group id): only then Ungroup does anything.
  const markGroup = () => {
    groupSelected = doc.selection.some((o) => o.groupId !== undefined);
    document.body.classList.toggle('group-selected', groupSelected);
  };
  for (const type of ['change', 'selection', 'history'] as const) doc.addEventListener(type, markGroup);
  markGroup();
  // The control last pressed: when it opens a tool, it is that tool's button.
  let pressed: HTMLElement | null = null;
  let current: HTMLElement | null = null;

  document.addEventListener('click', (e) => {
    const el = (e.target as Element).closest<HTMLElement>('button, li');
    const reason = el ? blockReason(el) : null;
    if (reason) {
      e.preventDefault();
      e.stopImmediatePropagation();
      toast(reason);
      return;
    }
    if (el) pressed = el;
  }, true);
  // Typing into locked fields is stopped too (the transform bar's numbers).
  document.addEventListener('focusin', (e) => {
    if (lockedNow(e.target as Element)) (e.target as HTMLElement).blur();
  });

  onToolChange(() => {
    const locked = isLocked();
    // A running calculation dims the same controls as a tool does.
    document.body.classList.toggle('tool-locked', locked || isBusy());
    document.body.classList.toggle('view-tool-only', onlyViewLocked());
    current?.classList.remove('tool-current');
    current = null;
    if (!(locked || isBusy()) || !pressed) return;
    // A menu item's tool: highlight the toolbar button whose menu it is in.
    const menu = pressed.closest<HTMLElement>('.menu');
    current = menu ? document.querySelector<HTMLElement>(`[data-menu="${menu.id}"]`) : pressed.closest('.toolbar button');
    current?.classList.add('tool-current');
  });
}
