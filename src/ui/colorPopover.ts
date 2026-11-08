import type { SceneDocument, SceneObject } from '../scene/document';
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
  private readonly custom: HTMLInputElement;
  private targets: SceneObject[] = [];
  /** Objects waiting for "Copy from object": the next object clicked in the view gives its colour. */
  pickingFor: SceneObject[] | null = null;

  constructor(
    private readonly doc: SceneDocument,
    private readonly onPickStart: (active: boolean) => void,
  ) {
    this.el = document.querySelector<HTMLElement>('#color-popover')!;
    this.custom = this.el.querySelector<HTMLInputElement>('#custom-color')!;
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
    this.custom.addEventListener('change', () => this.apply(this.custom.value));
    this.el.querySelector('[data-action="eyedropper"]')!.addEventListener('click', () => {
      beginTool('eyedropper', () => this.finishPick(undefined));
      this.pickingFor = this.targets;
      this.close();
      this.onPickStart(true);
    });
    this.el.querySelector('[data-action="reset-color"]')!.addEventListener('click', () => {
      this.doc.checkpoint();
      for (const o of this.targets) this.doc.setColor([o], o.defaultColor);
      this.close();
    });
    document.addEventListener('pointerdown', (e) => {
      if (!this.el.hidden && !this.el.contains(e.target as Node)) this.close();
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
    this.custom.value = only ?? obj.color;
    this.el.hidden = false;
    const r = anchor.getBoundingClientRect();
    const p = this.el.getBoundingClientRect();
    // Open to the left of the sidebar so the list stays visible.
    this.el.style.left = `${Math.max(8, r.left - p.width - 10)}px`;
    this.el.style.top = `${Math.max(8, Math.min(r.top - 10, window.innerHeight - p.height - 8))}px`;
  }

  close(): void {
    this.el.hidden = true;
  }

  private apply(color: string): void {
    this.doc.checkpoint();
    this.doc.setColor(this.targets, color);
    this.close();
  }

  /** Called with the object clicked in the view while "Copy from object" is active. */
  finishPick(source: SceneObject | undefined): void {
    const targets = this.pickingFor;
    this.pickingFor = null;
    endTool('eyedropper');
    this.onPickStart(false);
    if (!source || !targets) return;
    this.doc.checkpoint();
    this.doc.setColor(targets, source.color);
  }
}
