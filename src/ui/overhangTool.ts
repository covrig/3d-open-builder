import { setOverhangs } from '../scene/overhang';
import type { Viewport } from '../scene/viewport';
import { settings, updateUi } from '../settings';

/**
 * Show overhangs (Check menu): a panel at the top with the colour and the
 * angle, marking every surface that tilts down more than that from vertical,
 * live while objects move. A view panel like the cross-section: it locks
 * nothing (docs/tool-rules.md); Close or Esc ends it. Colour and angle are
 * remembered.
 */
export class OverhangTool {
  private on = false;
  private readonly bar = document.querySelector<HTMLElement>('#overhang-bar')!;
  private readonly color = this.bar.querySelector<HTMLInputElement>('#overhang-color')!;
  private readonly angle = this.bar.querySelector<HTMLInputElement>('#overhang-angle')!;
  private readonly menuItem = document.querySelector<HTMLElement>('[data-action="overhangs"]')!;

  constructor(private readonly viewport: Viewport) {
    this.menuItem.addEventListener('click', () => (this.on ? this.close() : this.open()));
    this.bar.querySelector('[data-overhang="close"]')!.addEventListener('click', () => this.close());
    this.color.addEventListener('input', () => {
      updateUi((ui) => (ui.overhang.color = this.color.value));
      this.apply();
    });
    this.angle.addEventListener('change', () => {
      const v = Math.min(80, Math.max(10, Number(this.angle.value) || 45));
      updateUi((ui) => (ui.overhang.angle = v));
      this.apply();
    });
    this.apply();
  }

  get active(): boolean {
    return this.on;
  }

  open(): void {
    this.on = true;
    this.apply();
  }

  /** Close the panel; false if it wasn't open. */
  close(): boolean {
    if (!this.on) return false;
    this.on = false;
    this.apply();
    return true;
  }

  private apply(): void {
    const o = settings.ui.overhang;
    this.color.value = o.color;
    this.angle.value = String(o.angle);
    this.bar.hidden = !this.on;
    this.menuItem.setAttribute('aria-checked', String(this.on));
    this.menuItem.classList.toggle('checked', this.on);
    setOverhangs(this.on, o.angle, o.color);
    this.viewport.invalidate();
  }
}
