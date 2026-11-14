import type { CrossSection } from '../ui/crossSection';
import type { OverhangTool } from '../ui/overhangTool';
import { BUSY_MESSAGE, LOCKED_MESSAGE } from '../ui/toolGuard';
import { isBusy, isLocked } from '../ui/toolLock';

/**
 * The commands Repeat (the toolbar button, and R) can run again: the tools of
 * the toolbar and its menus, measuring, aligning, the section view and the
 * Check menu. View options (X-ray, edges, grid, the Look sliders...), Undo,
 * Redo, Copy, Cut, Paste, Delete, Fit and Home are not repeatable.
 */
export const REPEATABLE = [
  '[data-modify]', '[data-boolean]', '[data-thread]', '[data-insert]',
  '[data-action="mirror"]', '[data-action="duplicate"]', '[data-action="rotate90"]', '[data-action="split"]', '[data-action="extrude-down"]',
  '[data-measure]', '[data-measure-quick]:not([data-measure-quick="stop"])',
  '[data-align]', '[data-distribute]',
  '[data-action="drop"]', '[data-action="lay-flat"]', '[data-action="center"]', '[data-action="pack"]',
  '[data-action="cross-section"]',
  '[data-action="check"]', '[data-action="overhangs"]', '[data-action="orient"]',
].join(', ');

const MEASURING = '[data-measure], [data-measure-quick]';

/** What the command is called in the Repeat button's tooltip. */
function nameOf(el: HTMLElement): string {
  const own = el.dataset.tipTitle ?? el.getAttribute('aria-label');
  const label = own ?? [...el.childNodes].filter((n) => !(n instanceof HTMLElement && n.matches('kbd, .key-hint'))).map((n) => n.textContent).join('').trim();
  return el.matches(MEASURING) ? `Measure ${label.toLowerCase()}` : label;
}

/**
 * The Repeat button and the R key: the last repeatable command is remembered
 * (a new one replaces it) and run again from the same button it first came
 * from. Refused while a tool is open or a calculation runs, like the other
 * toolbar buttons (docs/tool-rules.md).
 */
export function setupRepeat(ctx: {
  crossSection: Pick<CrossSection, 'active'>;
  overhangs: Pick<OverhangTool, 'active'>;
  toast: (message: string) => void;
}): { repeat: () => void; remember: (el: HTMLElement) => void } {
  const { crossSection, overhangs, toast } = ctx;
  const button = document.querySelector<HTMLButtonElement>('[data-action="repeat"]')!;
  let last: HTMLElement | null = null;

  const remember = (el: HTMLElement): void => {
    last = el;
    const name = nameOf(el);
    button.disabled = false;
    button.dataset.tipTitle = `Repeat: ${name}`;
    button.dataset.tip = `Do "${name}" again. Each new tool, measurement, arrange command, section or check replaces it.`;
  };

  document.addEventListener('click', (e) => {
    const el = (e.target as HTMLElement).closest<HTMLElement>(REPEATABLE);
    if (el && e.isTrusted) remember(el);
  }, true);

  const repeat = (): void => {
    if (!last) return toast('Nothing to repeat yet: use a tool first');
    // These switch on and off with one button: repeating never switches them off.
    if (last.matches('[data-action="cross-section"]') && crossSection.active) return toast('The section is already open');
    if (last.matches('[data-action="overhangs"]') && overhangs.active) return toast('Overhangs are already shown');
    if (last.matches(MEASURING) && last.classList.contains('active')) return toast('Already measuring');
    if (isLocked()) return toast(LOCKED_MESSAGE);
    if (isBusy()) return toast(BUSY_MESSAGE);
    if (last instanceof HTMLButtonElement && last.disabled) return toast('That command is not available right now: select an object first');
    last.click();
  };
  button.addEventListener('click', repeat);
  return { repeat, remember };
}
