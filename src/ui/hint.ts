/**
 * A tooltip-style instruction that stays on the 3D view (where short messages
 * appear) for as long as a multi-step operation is active, e.g. "Distance:
 * click two points". Each tool shows and hides its own hint; the most recent
 * one is displayed. A hint can carry a note, shown under it in yellow (a warning
 * that touch screens, which have no hover tooltips, still see).
 */
const active = new Map<string, { text: string; note?: string }>();
let el: HTMLElement | null = null;

function render(): void {
  el ??= document.querySelector<HTMLElement>('#op-hint');
  if (!el) return;
  const shown = [...active.values()].pop();
  el.hidden = !shown;
  el.textContent = shown?.text ?? '';
  if (shown?.note) {
    const note = document.createElement('span');
    note.className = 'hint-note';
    note.textContent = shown.note;
    el.append(note);
  }
}

export function showHint(owner: string, text: string, note?: string): void {
  active.delete(owner); // re-insert so it becomes the newest
  active.set(owner, { text, note });
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
  const bars = ['#split-bar', '#feature-bar', '#section-bar', '#overhang-bar']
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

/** Everything that can lie over the app name and the view cube (they sit below these in the stacking order). */
const COVERERS = '#tooltip:not([hidden]), #split-bar:not([hidden]), #feature-bar:not([hidden]), #section-bar:not([hidden]), '
  + '#overhang-bar:not([hidden]), #messages > :not([hidden])';

/**
 * The app name and the view cube step aside (class "covered": invisible) while a tooltip, a tool bar, a hint, a
 * message or the measuring buttons lie over them, even partly. Their boxes are tested as laid out right now:
 * the cube's box is 80 px square but the cube itself is smaller, so it is tested a little inset.
 */
export function updateCovers(): void {
  const over = [...document.querySelectorAll<HTMLElement>(COVERERS)]
    .map((e) => e.getBoundingClientRect())
    .filter((r) => r.width > 0 && r.height > 0);
  for (const [id, inset] of [['view-cube', 10], ['brand-overlay', 0]] as const) {
    const e = document.getElementById(id);
    if (!e) continue;
    const r = e.getBoundingClientRect();
    const covered = r.width > 0 && over.some((o) => o.left < r.right - inset && o.right > r.left + inset && o.top < r.bottom - inset && o.bottom > r.top + inset);
    e.classList.toggle('covered', covered);
  }
}

/** Check the covers again whenever a bar, a hint or a message appears, goes, moves or changes size. */
export function watchCovers(): void {
  let frame = 0;
  const schedule = () => {
    if (frame) return;
    // One frame later: the bars' own placement (watchTopBars) has run by then.
    frame = requestAnimationFrame(() => {
      frame = 0;
      updateCovers();
    });
  };
  const view = document.querySelector<HTMLElement>('#viewport')!;
  const watched = [...document.querySelectorAll<HTMLElement>('#split-bar, #feature-bar, #section-bar, #overhang-bar, #messages')];
  const changes = new MutationObserver(schedule);
  const sizes = new ResizeObserver(schedule);
  for (const w of watched) {
    changes.observe(w, { attributes: true, attributeFilter: ['hidden', 'style', 'class'], childList: true, subtree: true, characterData: true });
    sizes.observe(w);
  }
  sizes.observe(view);
  window.addEventListener('resize', schedule);
  schedule();
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
