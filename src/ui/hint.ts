/**
 * A tooltip-style instruction that stays on the 3D view (where short messages
 * appear) for as long as a multi-step operation is active, e.g. "Distance:
 * click two points". Each tool shows and hides its own hint; the most recent
 * one is displayed.
 */
const active = new Map<string, string>();
let el: HTMLElement | null = null;

function render(): void {
  el ??= document.querySelector<HTMLElement>('#op-hint');
  if (!el) return;
  const texts = [...active.values()];
  el.hidden = texts.length === 0;
  el.textContent = texts[texts.length - 1] ?? '';
}

export function showHint(owner: string, text: string): void {
  active.delete(owner); // re-insert so it becomes the newest
  active.set(owner, text);
  render();
}

export function hideHint(owner: string): void {
  if (active.delete(owner)) render();
}

/**
 * Keep messages and hints just below whichever tool bar is open at the top of
 * the view (Split, a tool's settings), so they never cover it.
 */
export function watchTopBars(): void {
  const messages = document.querySelector<HTMLElement>('#messages')!;
  const bars = ['#split-bar', '#feature-bar']
    .map((s) => document.querySelector<HTMLElement>(s))
    .filter((b): b is HTMLElement => b !== null);
  const corner = document.querySelector<HTMLElement>('#view-corner');
  const place = () => {
    const viewTop = messages.parentElement!.getBoundingClientRect().top;
    let top = 12;
    for (const b of bars) {
      if (b.hidden) continue;
      top = Math.max(top, b.getBoundingClientRect().bottom - viewTop + 8);
    }
    // On narrow views the messages would run under the buttons at the top right.
    const c = corner?.getBoundingClientRect();
    if (c && c.width > 0 && messages.getBoundingClientRect().right > c.left - 4) top = Math.max(top, c.bottom - viewTop + 8);
    messages.style.top = `${top}px`;
  };
  const observer = new MutationObserver(place);
  const sizes = new ResizeObserver(place);
  for (const b of bars) {
    observer.observe(b, { attributes: true, attributeFilter: ['hidden'] });
    sizes.observe(b);
  }
  // The corner buttons change with the window size and when the panel opens or closes.
  sizes.observe(messages.parentElement!);
  if (corner) sizes.observe(corner);
  place();
}
