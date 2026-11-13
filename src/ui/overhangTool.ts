import type { Gizmo } from '../scene/gizmo';
import { setOverhangs } from '../scene/overhang';
import type { Viewport } from '../scene/viewport';
import { settings, updateUi } from '../settings';
import { openColorPicker } from './colorPicker';
import { parseNumber } from './numberInputs';
import { beginViewTool, endViewTool } from './toolLock';

/**
 * Show overhangs (Check menu): a panel at the top with the colour and the
 * angle, marking every surface that tilts down more than that from vertical,
 * on every object. A view tool like the cross-section: while it is open,
 * objects can't be edited or moved, measuring still works (docs/tool-rules.md);
 * Close or Esc ends it. Colour and angle are remembered.
 */
export class OverhangTool {
  private on = false;
  private readonly bar = document.querySelector<HTMLElement>('#overhang-bar')!;
  private readonly color = this.bar.querySelector<HTMLButtonElement>('#overhang-color')!;
  private readonly angle = this.bar.querySelector<HTMLInputElement>('#overhang-angle')!;
  private readonly menuItem = document.querySelector<HTMLElement>('[data-action="overhangs"]')!;

  constructor(
    private readonly viewport: Viewport,
    private readonly gizmo: Gizmo,
  ) {
    this.menuItem.addEventListener('click', () => (this.on ? this.close() : this.open()));
    this.bar.querySelector('[data-overhang="close"]')!.addEventListener('click', () => this.close());
    this.color.addEventListener('click', () =>
      openColorPicker({
        anchor: this.color,
        value: settings.ui.overhang.color,
        onInput: (hex) => {
          updateUi((ui) => (ui.overhang.color = hex));
          this.apply();
        },
      }),
    );
    this.angle.addEventListener('change', () => {
      const v = Math.min(80, Math.max(10, parseNumber(this.angle.value) || settings.ui.overhang.angle));
      updateUi((ui) => (ui.overhang.angle = v));
      this.apply();
    });
    this.apply();
  }

  get active(): boolean {
    return this.on;
  }

  open(): void {
    beginViewTool('overhangs', () => this.close());
    this.gizmo.enabled = false;
    this.on = true;
    this.apply();
  }

  /** Close the panel; false if it wasn't open. */
  close(): boolean {
    if (!this.on) return false;
    this.on = false;
    endViewTool('overhangs');
    this.gizmo.enabled = true;
    this.apply();
    return true;
  }

  private apply(): void {
    const o = settings.ui.overhang;
    this.color.style.setProperty('--swatch', o.color);
    this.angle.value = String(o.angle);
    this.bar.hidden = !this.on;
    this.menuItem.setAttribute('aria-checked', String(this.on));
    this.menuItem.classList.toggle('checked', this.on);
    setOverhangs(this.on, o.angle, o.color);
    this.viewport.invalidate();
  }
}
