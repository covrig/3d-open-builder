import { isLocked, onToolChange } from './toolLock';

/**
 * While a tool with Apply/Cancel is open, the controls that would disturb it
 * are dimmed and don't respond; clicking one says why. The control that
 * opened the tool stays highlighted. Which controls stay usable is decided in
 * docs/tool-rules.md: the view (camera, view toggles, view cube, side panel),
 * Copy, settings, export, and the tool's own bar.
 */
export const LOCKED = [
  '.toolbar button:not([data-menu="file-menu"]):not([data-action="copy"])',
  '#file-menu [data-action="new"]',
  '#file-menu [data-action="open"]',
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

export const LOCKED_MESSAGE = 'Finish or cancel the current tool first (Apply, Cancel or Esc)';

/** Is this element locked right now? */
export function lockedNow(el: Element): boolean {
  return isLocked() && el.closest(LOCKED) !== null;
}

export function setupToolGuard(toast: (msg: string) => void): void {
  // The control last pressed: when it opens a tool, it is that tool's button.
  let pressed: HTMLElement | null = null;
  let current: HTMLElement | null = null;

  document.addEventListener('click', (e) => {
    const el = (e.target as Element).closest<HTMLElement>('button, li');
    if (el && lockedNow(el)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      toast(LOCKED_MESSAGE);
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
    document.body.classList.toggle('tool-locked', locked);
    current?.classList.remove('tool-current');
    current = null;
    if (!locked || !pressed) return;
    // A menu item's tool: highlight the toolbar button whose menu it is in.
    const menu = pressed.closest<HTMLElement>('.menu');
    current = menu ? document.querySelector<HTMLElement>(`[data-menu="${menu.id}"]`) : pressed.closest('.toolbar button');
    current?.classList.add('tool-current');
  });
}
