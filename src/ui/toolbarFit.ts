/**
 * The More menu's tools (Bevel, Round, Brace, Shell, Section) also have
 * toolbar buttons, with tooltips like the other tools. They are shown one by
 * one, in order, as long as the toolbar keeps the same number of rows and no
 * button gets squeezed, so the toolbar never grows (at most two rows, as on
 * phones). A tool shown in the toolbar leaves the menu; when nothing is left
 * in the menu, the More button goes too. After them come extra shortcuts (`.fit-extra`, the Settings
 * button) under the same rule.
 */
export function fitToolbar(): void {
  const bar = document.querySelector<HTMLElement>('.toolbar')!;
  const menu = bar.querySelector<HTMLElement>('#modify-menu')!;
  const more = bar.querySelector<HTMLElement>('[data-menu="modify-menu"]')!;
  const outs = [...bar.querySelectorAll<HTMLElement>('button.more-out')];
  const twin = (b: HTMLElement) =>
    menu.querySelector<HTMLElement>(b.dataset.modify ? `[data-modify="${b.dataset.modify}"]` : `[data-action="${b.dataset.action}"]`)!;
  const show = (b: HTMLElement, on: boolean) => {
    b.classList.toggle('out-hidden', !on);
    twin(b).classList.toggle('in-toolbar', on);
  };
  const buttons = () => [...bar.querySelectorAll<HTMLElement>('button')].filter((b) => !b.closest('.menu') && b.offsetParent !== null);
  /** Rows of buttons: tops more than half a button apart start a new row (buttons in a row differ a little in height). */
  const rows = () => {
    const tops = buttons().map((b) => b.getBoundingClientRect().top).sort((x, y) => x - y);
    return tops.filter((t, i) => i === 0 || t - tops[i - 1] > 16).length;
  };
  const squeezed = () => buttons().some((b) => b.scrollWidth > b.clientWidth + 1);

  more.classList.remove('out-hidden');
  for (const b of outs) show(b, false);
  const extras = [...bar.querySelectorAll<HTMLElement>('.fit-extra')];
  for (const b of extras) b.classList.add('out-hidden');
  const base = rows();
  let allFit = true;
  for (const b of outs) {
    show(b, true);
    if (rows() > base || squeezed()) {
      show(b, false);
      allFit = false;
      break;
    }
  }
  // On phones the menu also holds Split, Extrude, Pattern and Text, so More stays there.
  const left = [...menu.children].some((c) => getComputedStyle(c).display !== 'none');
  more.classList.toggle('out-hidden', !left);
  // Extra shortcuts (Settings) come last: only once every tool fit (and More is gone, which frees its room), and only while the rows stay the same.
  if (allFit) {
    for (const b of extras) {
      b.classList.remove('out-hidden');
      if (rows() > base || squeezed()) {
        b.classList.add('out-hidden');
        break;
      }
    }
  }
}

/** Fit now, and again whenever the window changes size or the fonts arrive. */
export function setupToolbarFit(): void {
  let frame = 0;
  const later = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(fitToolbar);
  };
  window.addEventListener('resize', later);
  void document.fonts.ready.then(later);
  fitToolbar();
}
