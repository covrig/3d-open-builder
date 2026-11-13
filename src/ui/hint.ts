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
  // In this order from the top: a tool's bar, then the view panels' bars.
  const bars = ['#split-bar', '#feature-bar', '#section-bar', '#overhang-bar', '#thickness-bar']
    .map((s) => document.querySelector<HTMLElement>(s))
    .filter((b): b is HTMLElement => b !== null);
  const place = () => {

    const viewTop = messages.parentElement!.getBoundingClientRect().top;
    let top = 12;
    // Open bars stack one under the other; messages go below them.
    for (const b of bars) {
      if (b.hidden) continue;
      b.style.top = `${top}px`;
      top = b.getBoundingClientRect().bottom - viewTop + 8;
    }
    messages.style.top = `${top}px`;

  };
  const observer = new MutationObserver(place);
  const sizes = new ResizeObserver(place);
  for (const b of bars) {
    observer.observe(b, { attributes: true, attributeFilter: ['hidden'] });
    sizes.observe(b);
  }
  sizes.observe(messages.parentElement!);
  place();
}

/**
 * The floating buttons at the bottom right: level with the transform bar
 * when they fit beside it, otherwise stacked just above it.
 */
export function watchCorner(): void {
  const corner = document.querySelector<HTMLElement>('#view-corner')!;
  const bar = document.querySelector<HTMLElement>('#transform-bar')!;
  const view = corner.parentElement!;
  const place = () => {
    corner.style.bottom = '';
    const c = corner.getBoundingClientRect();
    const b = bar.getBoundingClientRect();
    if (b.width > 0 && c.left < b.right + 8) corner.style.bottom = `${view.getBoundingClientRect().bottom - b.top + 8}px`;
  };
  const sizes = new ResizeObserver(place);
  for (const el of [view, corner, bar]) sizes.observe(el);
  // The phone drawer moves the buttons sideways when it opens.
  new MutationObserver(place).observe(document.body, { attributes: true, attributeFilter: ['class'] });
  place();
}
