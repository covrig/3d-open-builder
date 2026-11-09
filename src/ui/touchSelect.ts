import { icon } from './icons';

const coarse = matchMedia('(pointer: coarse)');

/**
 * A dropdown for tool bars that works on phones. A phone's own list for a
 * <select> can fill the whole screen (the thread sizes), leaving nowhere to
 * tap to close it. On touch screens the select is replaced by a button that
 * opens a short in-app list: it scrolls, and a tap outside (or Esc) closes
 * it. The select stays in the page, hidden, and still holds the value and
 * fires "change"; dispatch "sync" on it after setting its value in code.
 * With a mouse the ordinary select is used.
 */
export function touchFriendly(select: HTMLSelectElement): HTMLElement {
  if (!coarse.matches) return select;
  const wrap = document.createElement('span');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'touch-select';
  const text = document.createElement('span');
  button.append(text, icon('chevron-down'));
  select.hidden = true;
  wrap.append(select, button);
  const show = () => (text.textContent = select.selectedOptions[0]?.textContent ?? '');
  select.addEventListener('change', show);
  select.addEventListener('sync', show);
  show();
  button.addEventListener('click', () => openList(select, button));
  return wrap;
}

function openList(select: HTMLSelectElement, anchor: HTMLElement): void {
  const list = document.createElement('div');
  list.className = 'select-list';
  list.setAttribute('role', 'listbox');
  for (const option of select.options) {
    const b = document.createElement('button');
    b.type = 'button';
    b.setAttribute('role', 'option');
    b.textContent = option.textContent;
    b.classList.toggle('active', option.selected);
    b.addEventListener('click', () => {
      close();
      if (select.value === option.value) return;
      select.value = option.value;
      select.dispatchEvent(new Event('change'));
    });
    list.append(b);
  }
  document.body.append(list);
  // Below the button, or above it when there is more room there; never off screen.
  const r = anchor.getBoundingClientRect();
  const gap = 6;
  const below = innerHeight - r.bottom - gap * 2;
  const above = r.top - gap * 2;
  const room = Math.max(below, above);
  list.style.maxHeight = `${Math.min(room, 360)}px`;
  list.style.minWidth = `${r.width}px`;
  list.style.maxWidth = `${innerWidth - gap * 2}px`;
  const w = list.getBoundingClientRect().width;
  list.style.left = `${Math.max(gap, Math.min(r.left, innerWidth - w - gap))}px`;
  const h = list.getBoundingClientRect().height;
  list.style.top = `${below >= Math.min(h, 360) || below >= above ? r.bottom + gap : r.top - gap - h}px`;
  list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });

  const outside = (e: PointerEvent) => {
    if (list.contains(e.target as Node)) return;
    // The tap only closes the list: it doesn't also press what is under it.
    e.stopPropagation();
    const swallow = (ev: Event) => {
      ev.preventDefault();
      ev.stopPropagation();
    };
    document.addEventListener('click', swallow, { capture: true, once: true });
    setTimeout(() => document.removeEventListener('click', swallow, true), 600);
    close();
  };
  const key = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation(); // closes the list, not the tool
      close();
    }
  };
  function close() {
    list.remove();
    document.removeEventListener('pointerdown', outside, true);
    document.removeEventListener('keydown', key, true);
  }
  document.addEventListener('pointerdown', outside, true);
  document.addEventListener('keydown', key, true);
}
