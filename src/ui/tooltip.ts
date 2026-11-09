import { settings } from '../settings';
import { blockReason } from './toolGuard';

/**
 * Hover tooltips with a title line and a description, for any element with
 * data-tip (description) and optionally data-tip-title (defaults to the
 * element's text). They open beside their control, away from the 3D view's
 * centre: below the toolbar, left of the sidebar and the corner buttons,
 * above the transform bar; never over an open tool bar or message.
 */
export function setupTooltips(): void {
  const tip = document.createElement('div');
  tip.id = 'tooltip';
  tip.setAttribute('role', 'tooltip');
  tip.hidden = true;
  const title = document.createElement('div');
  title.className = 'tip-title';
  const body = document.createElement('div');
  body.className = 'tip-body';
  tip.append(title, body);
  document.body.append(tip);

  let current: HTMLElement | undefined;
  let timer: number | undefined;

  const hide = () => {
    clearTimeout(timer);
    tip.hidden = true;
    current = undefined;
  };

  const show = (el: HTMLElement) => {
    // A button's key is shown only while single-key shortcuts are switched on.
    const key = settings.shortcuts && el.dataset.shortcut ? ` (${el.dataset.shortcut})` : '';
    title.textContent = (el.dataset.tipTitle ?? el.textContent?.trim() ?? '') + key;
    // A control that can't be used right now (a tool is open, a group is selected) says why instead.
    body.textContent = blockReason(el) ?? el.dataset.tip ?? '';
    tip.hidden = false;
    const r = el.getBoundingClientRect();
    const t = tip.getBoundingClientRect();
    const gap = 8;
    let x: number;
    let y: number;
    if (el.closest('#sidebar, #view-corner')) {
      x = r.left - t.width - gap;
      y = r.top + r.height / 2 - t.height / 2;
    } else if (el.closest('#transform-bar')) {
      x = r.left;
      y = r.top - t.height - gap;
    } else {
      // Within the window first, so the boxes are checked where the tip really goes.
      x = Math.max(gap, Math.min(r.left, window.innerWidth - t.width - gap));
      y = r.bottom + gap;
      // Below the tool bars and messages at the top, not over them (nor over the rest of its own bar).
      const boxes = [...document.querySelectorAll('.top-bar:not([hidden]), #messages > :not([hidden])')]
        .map((b) => b.getBoundingClientRect())
        .filter((b) => b.width > 0);
      for (let moved = true; moved;) {
        moved = false;
        for (const b of boxes) {
          if (x < b.right && x + t.width > b.left && y < b.bottom && y + t.height > b.top) {
            y = b.bottom + gap;
            moved = true;
          }
        }
      }
    }
    x = Math.max(gap, Math.min(x, window.innerWidth - t.width - gap));
    y = Math.max(gap, Math.min(y, window.innerHeight - t.height - gap));
    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
  };

  document.addEventListener('pointerover', (e) => {
    if (e.pointerType === 'touch') return; // touch uses long-press instead
    const el = (e.target as Element).closest<HTMLElement>('[data-tip]') ?? undefined;
    if (el === current) return;
    hide();
    if (!el) return;
    current = el;
    timer = window.setTimeout(() => show(el), 180);
  });

  // Touch screens can't hover: press and hold a control to read its tooltip.
  // The tap that ends a long press doesn't trigger the control.
  let pressTimer: number | undefined;
  let suppressClick = false;
  document.addEventListener('pointerdown', (e) => {
    hide();
    clearTimeout(pressTimer);
    if (e.pointerType !== 'touch') return;
    const el = (e.target as Element).closest<HTMLElement>('[data-tip]');
    if (!el) return;
    pressTimer = window.setTimeout(() => {
      current = el;
      show(el);
      suppressClick = true;
    }, 500);
  });
  const cancelPress = () => clearTimeout(pressTimer);
  document.addEventListener('pointerup', cancelPress);
  document.addEventListener('pointercancel', cancelPress);
  document.addEventListener('click', (e) => {
    if (!suppressClick) return;
    suppressClick = false;
    e.preventDefault();
    e.stopPropagation();
    window.setTimeout(hide, 1800); // leave the tooltip up a moment to read
  }, true);
  window.addEventListener('blur', hide);
}
