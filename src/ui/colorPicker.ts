/**
 * In-app colour picker, one for the whole page: a saturation/brightness
 * square, a hue slider and a hex field. It replaces <input type="color">,
 * whose look and behaviour depend on the browser and the system.
 * Values are #rrggbb. Dragging and typing call onInput live; onChange fires
 * once when the picker closes with a different colour than it opened with.
 */

export interface ColorPickerOptions {
  anchor: HTMLElement;
  value: string;
  onInput: (hex: string) => void;
  onChange?: (hex: string) => void;
  onClose?: () => void;
  /** Open beside the anchor (right, else left) instead of below it: for anchors inside a side popover. */
  beside?: boolean;
}

/** h 0-360, s and v 0-1 */
export function hexToHsv(hex: string): [number, number, number] {
  const n = parseInt(hex.replace('#', '').slice(0, 6), 16) || 0;
  const r = ((n >> 16) & 255) / 255;
  const g = ((n >> 8) & 255) / 255;
  const b = (n & 255) / 255;
  const max = Math.max(r, g, b);
  const d = max - Math.min(r, g, b);
  let h = 0;
  if (d > 0) {
    if (max === r) h = ((g - b) / d) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, max === 0 ? 0 : d / max, max];
}

export function hsvToHex(h: number, s: number, v: number): string {
  const f = (n: number) => {
    const k = (n + h / 60) % 6;
    return v - v * s * Math.max(0, Math.min(k, 4 - k, 1));
  };
  const part = (x: number) => Math.round(x * 255).toString(16).padStart(2, '0');
  return `#${part(f(5))}${part(f(3))}${part(f(1))}`;
}

/** "#abc", "abc", "#aabbcc" or "aabbcc" to "#aabbcc"; null if it is not a colour. */
function parseHex(text: string): string | null {
  let t = text.trim().replace(/^#/, '').toLowerCase();
  if (/^[0-9a-f]{3}$/.test(t)) t = t.replace(/./g, (c) => c + c);
  return /^[0-9a-f]{6}$/.test(t) ? `#${t}` : null;
}

const WIDTH = 232;

interface State {
  opts: ColorPickerOptions;
  startHex: string;
  h: number;
  s: number;
  v: number;
}

let el: HTMLElement | null = null;
let state: State | null = null;

function build(): HTMLElement {
  const d = document.createElement('div');
  d.id = 'color-picker';
  d.setAttribute('role', 'dialog');
  d.setAttribute('aria-label', 'Colour picker');
  d.hidden = true;
  d.innerHTML = `
    <div class="cp-sv" role="slider" tabindex="0" aria-label="Saturation and brightness"><div class="cp-knob"></div></div>
    <div class="cp-hue" role="slider" tabindex="0" aria-label="Hue" aria-valuemin="0" aria-valuemax="360"><div class="cp-knob"></div></div>
    <div class="cp-row"><span class="cp-preview"></span><input class="cp-hex" type="text" spellcheck="false" autocomplete="off" maxlength="7" aria-label="Hex colour" /></div>`;
  return d;
}

const q = <T extends HTMLElement>(sel: string) => el!.querySelector<T>(sel)!;
const current = () => hsvToHex(state!.h, state!.s, state!.v);

/** Redraw every part from the state; `typing` leaves the hex field alone while the user types in it. */
function paint(typing = false): void {
  const { h, s, v } = state!;
  const hex = current();
  const sv = q('.cp-sv');
  sv.style.setProperty('--cp-hue', hsvToHex(h, 1, 1));
  const k = q('.cp-sv .cp-knob');
  k.style.left = `${s * 100}%`;
  k.style.top = `${(1 - v) * 100}%`;
  k.style.background = hex;
  sv.setAttribute('aria-valuetext', `Saturation ${Math.round(s * 100)}%, brightness ${Math.round(v * 100)}%`);
  sv.setAttribute('aria-valuenow', String(Math.round(s * 100)));
  const hue = q('.cp-hue');
  const hk = q('.cp-hue .cp-knob');
  hk.style.left = `${(h / 360) * 100}%`;
  hk.style.background = hsvToHex(h, 1, 1);
  hue.setAttribute('aria-valuenow', String(Math.round(h)));
  hue.setAttribute('aria-valuetext', `${Math.round(h)} degrees`);
  q('.cp-preview').style.background = hex;
  if (!typing) q<HTMLInputElement>('.cp-hex').value = hex;
}

function emit(typing = false): void {
  paint(typing);
  state!.opts.onInput(current());
}

/** Drag on an element: reports the pointer as 0-1 fractions of it. Pointer capture keeps it going outside the element (mouse, touch, pen). */
function drag(target: HTMLElement, move: (fx: number, fy: number) => void): void {
  const at = (e: PointerEvent) => {
    const r = target.getBoundingClientRect();
    move(Math.min(1, Math.max(0, (e.clientX - r.left) / r.width)), Math.min(1, Math.max(0, (e.clientY - r.top) / r.height)));
  };
  target.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    e.preventDefault();
    target.focus();
    target.setPointerCapture(e.pointerId);
    at(e);
  });
  target.addEventListener('pointermove', (e) => {
    if (target.hasPointerCapture(e.pointerId)) at(e);
  });
}

function setup(): void {
  el = build();
  document.body.append(el);
  const sv = q('.cp-sv');
  const hue = q('.cp-hue');
  const hex = q<HTMLInputElement>('.cp-hex');
  drag(sv, (fx, fy) => {
    state!.s = fx;
    state!.v = 1 - fy;
    emit();
  });
  drag(hue, (fx) => {
    state!.h = fx * 360;
    emit();
  });
  sv.addEventListener('keydown', (e) => {
    const step = (e.shiftKey ? 10 : 1) / 100;
    const key = e.key;
    if (key === 'ArrowLeft') state!.s = Math.max(0, state!.s - step);
    else if (key === 'ArrowRight') state!.s = Math.min(1, state!.s + step);
    else if (key === 'ArrowUp') state!.v = Math.min(1, state!.v + step);
    else if (key === 'ArrowDown') state!.v = Math.max(0, state!.v - step);
    else return;
    e.preventDefault();
    emit();
  });
  hue.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') state!.h = Math.max(0, state!.h - step);
    else if (e.key === 'ArrowRight' || e.key === 'ArrowUp') state!.h = Math.min(360, state!.h + step);
    else return;
    e.preventDefault();
    emit();
  });
  // Valid text applies live; anything else is ignored and the field is restored on blur or Enter.
  hex.addEventListener('input', () => {
    const parsed = parseHex(hex.value);
    if (!parsed) return;
    const [h, s, v] = hexToHsv(parsed);
    // Grey and black have no hue of their own: keep the slider where it was.
    Object.assign(state!, { h: s > 0 && v > 0 ? h : state!.h, s, v });
    emit(true);
  });
  hex.addEventListener('blur', () => {
    if (state) hex.value = current();
  });
  hex.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    e.stopPropagation();
    const parsed = parseHex(hex.value);
    if (parsed) {
      const [h, s, v] = hexToHsv(parsed);
      Object.assign(state!, { h: s > 0 && v > 0 ? h : state!.h, s, v });
      emit();
    }
    closeColorPicker();
  });

  // Capture phase: the page's own handlers (Esc closing a dialog, popovers closing on outside clicks) run after this.
  document.addEventListener(
    'keydown',
    (e) => {
      if (!state || e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      closeColorPicker();
    },
    true,
  );
  document.addEventListener(
    'pointerdown',
    (e) => {
      if (!state) return;
      const t = e.target as Node;
      if (el!.contains(t) || state.opts.anchor.contains(t)) return;
      closeColorPicker();
    },
    true,
  );
  window.addEventListener('resize', () => {
    // A phone's on-screen keyboard resizes the window while the hex field has focus: stay open then.
    if (state && document.activeElement !== hex) closeColorPicker();
  });
  window.addEventListener(
    'scroll',
    (e) => {
      if (state && !el!.contains(e.target as Node)) closeColorPicker();
    },
    true,
  );
}

function place(anchor: HTMLElement, beside: boolean): void {
  const p = el!;
  const r = anchor.getBoundingClientRect();
  const w = p.offsetWidth || WIDTH;
  const h = p.offsetHeight;
  const m = 8;
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(v, hi));
  let left: number;
  let top: number;
  if (beside) {
    // Beside the anchor on the side with room (the object colour popover sits left of the sidebar).
    left = window.innerWidth - r.right - m >= w + 6 ? r.right + 6 : r.left - w - 6;
    top = r.top;
  } else {
    // Below the anchor, or above when there is no room, like the view popovers.
    left = r.left;
    top = r.bottom + 6;
    if (top + h > window.innerHeight - m && r.top - h - 6 >= m) top = r.top - h - 6;
  }
  p.style.left = `${clamp(left, m, window.innerWidth - w - m)}px`;
  p.style.top = `${clamp(top, m, window.innerHeight - h - m)}px`;
}

export function openColorPicker(opts: ColorPickerOptions): void {
  if (state && state.opts.anchor === opts.anchor) {
    // A second click on the same anchor closes it.
    closeColorPicker();
    return;
  }
  if (state) closeColorPicker();
  if (!el) setup();
  const hex = parseHex(opts.value) ?? '#000000';
  const [h, s, v] = hexToHsv(hex);
  state = { opts, startHex: hex, h, s, v };
  // A modal <dialog> sits in the top layer, above any z-index: inside one, the picker must be its child to be seen and clickable.
  const host = opts.anchor.closest('dialog[open]') ?? document.body;
  if (el!.parentElement !== host) host.append(el!);
  el!.hidden = false;
  paint();
  place(opts.anchor, !!opts.beside);
  q('.cp-sv').focus();
}

export function closeColorPicker(): void {
  if (!state || !el) return;
  const { opts, startHex } = state;
  const hex = current();
  state = null;
  el.hidden = true;
  if (hex !== startHex) opts.onChange?.(hex);
  opts.onClose?.();
  // Focus back to where it came from, unless the user clicked something else that took it.
  if (document.activeElement === document.body || el.contains(document.activeElement)) opts.anchor.focus();
}
