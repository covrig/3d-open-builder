import type { SceneDocument, SceneObject } from '../scene/document';
import { closeColorPicker, openColorPicker } from './colorPicker';
import { beginTool, endTool } from './toolLock';

// Mid-tones plus white and near-black; each stays visible on light and dark backgrounds.
const STANDARD_COLORS: [string, string][] = [
  ['#f2f2f2', 'White'], ['#2b2b2b', 'Black'], ['#8c8c8c', 'Grey'], ['#8c2f39', 'Dark red'],
  ['#e5484d', 'Red'], ['#f08c00', 'Orange'], ['#f2c230', 'Yellow'], ['#94c93d', 'Lime'],
  ['#30a46c', 'Green'], ['#2fa7d6', 'Sky blue'], ['#3e63dd', 'Blue'], ['#9c4fd6', 'Purple'],
];

/**
 * Colour picker that opens from an object's colour box in the Objects list.
 * It recolours that object, or the whole selection if the object is part of it.
 */
export class ColorPopover {
  private readonly el: HTMLElement;
  private readonly custom: HTMLButtonElement;
  private readonly customDot: HTMLElement;
  private targets: SceneObject[] = [];
  /** Objects waiting for "Copy from object": the next object clicked in the view gives its colour. */
  pickingFor: SceneObject[] | null = null;

  constructor(
    private readonly doc: SceneDocument,
    private readonly onPickStart: (active: boolean) => void,
  ) {
    this.el = document.querySelector<HTMLElement>('#color-popover')!;
    this.custom = this.el.querySelector<HTMLButtonElement>('#custom-color-open')!;
    this.customDot = this.custom.querySelector<HTMLElement>('.swatch-dot')!;
    const swatches = this.el.querySelector('.swatches')!;
    for (const [color, name] of STANDARD_COLORS) {
      const b = document.createElement('button');
      b.style.background = color;
      b.dataset.color = color;
      b.dataset.tipTitle = name;
      b.dataset.tip = 'Use this colour for the object.';
      b.setAttribute('aria-label', name);
      b.addEventListener('click', () => this.apply(color));
      swatches.append(b);
    }
    this.custom.addEventListener('click', () => this.pickCustom());
    this.el.querySelector('[data-action="eyedropper"]')!.addEventListener('click', () => {
      beginTool('eyedropper', () => this.finishPick(undefined), false);
      this.pickingFor = this.targets;
      this.close();
      this.onPickStart(true);
    });
    this.el.querySelector('[data-action="reset-color"]')!.addEventListener('click', () => {
      this.doc.transact(() => {
        for (const o of this.targets) this.doc.setColor([o], o.defaultColor);
      });
      this.close();
    });
    document.addEventListener('pointerdown', (e) => {
      // The in-app picker belongs to this popover: using it must not close it.
      const t = e.target as HTMLElement;
      if (!this.el.hidden && !this.el.contains(t) && !t.closest('#color-picker')) this.close();
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') this.close();
    });
  }

  open(anchor: HTMLElement, obj: SceneObject): void {
    this.targets = this.doc.selection.includes(obj) ? [...this.doc.selection] : [obj];
    const colors = new Set(this.targets.map((o) => o.color));
    const only = colors.size === 1 ? [...colors][0] : undefined;
    for (const b of this.el.querySelectorAll<HTMLButtonElement>('.swatches button')) {
      b.classList.toggle('active', b.dataset.color === only);
    }
    this.customDot.style.background = only ?? obj.color;
    this.el.hidden = false;
    const r = anchor.getBoundingClientRect();
    const p = this.el.getBoundingClientRect();
    // Open to the left of the sidebar so the list stays visible.
    this.el.style.left = `${Math.max(8, r.left - p.width - 10)}px`;
    this.el.style.top = `${Math.max(8, Math.min(r.top - 10, window.innerHeight - p.height - 8))}px`;
  }

  close(): void {
    closeColorPicker();
    this.el.hidden = true;
  }

  /** Custom colour: the colour changes live while the picker is dragged, as ONE undo step for the whole session. */
  private pickCustom(): void {
    const targets = this.targets;
    const colors = new Set(targets.map((o) => o.color));
    let started = false;
    openColorPicker({
      anchor: this.custom,
      value: colors.size === 1 ? [...colors][0] : targets[0].color,
      beside: true,
      onInput: (hex) => {
        // The checkpoint comes before the first change, so one undo restores the colours from before the picker opened.
        if (!started) {
          started = true;
          this.doc.checkpoint();
        }
        this.doc.setColor(targets, hex);
        this.customDot.style.background = hex;
      },
    });
  }

  private apply(color: string): void {
    this.doc.transact(() => this.doc.setColor(this.targets, color));
    this.close();
  }

  /** Called with the object clicked in the view while "Copy from object" is active. */
  finishPick(source: SceneObject | undefined): void {
    const targets = this.pickingFor;
    this.pickingFor = null;
    endTool('eyedropper');
    this.onPickStart(false);
    if (!source || !targets) return;
    this.doc.transact(() => this.doc.setColor(targets, source.color));
  }
}
