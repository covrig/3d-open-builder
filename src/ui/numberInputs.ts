/**
 * Number fields are plain text fields marked with data-number (browsers refuse
 * a decimal comma in <input type="number">, and phone keypads in some
 * countries offer only a comma). They accept digits, one decimal point or
 * comma and a leading minus sign; everything else is stopped as it is typed
 * or pasted. Arrow Up and Down step the value. Works for fields created later too.
 */

/** What may stand in a number field while it is typed: nothing, "-", "-1,", "2.50"... */
const TYPING = /^-?[0-9]*[.,]?[0-9]*$/;
/** A finished number: "12", "-0,25", ".5", "3." */
const NUMBER = /^-?([0-9]+[.,]?[0-9]*|[.,][0-9]+)$/;

/**
 * The number in a field's text. A single comma counts as the decimal point.
 * Empty or non-numeric text gives NaN.
 */
export function parseNumber(text: string): number {
  const t = text.trim();
  if (!NUMBER.test(t)) return NaN;
  return Number(t.replace(',', '.'));
}

const isNumberField = (t: EventTarget | null): t is HTMLInputElement =>
  t instanceof HTMLInputElement && t.hasAttribute('data-number');

/** The field's text if `typed` replaced the selection. */
function after(input: HTMLInputElement, typed: string): string {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  return input.value.slice(0, start) + typed + input.value.slice(end);
}

export function restrictNumberInputs(): void {
  document.addEventListener('keydown', (e) => {
    if (!isNumberField(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const input = e.target;
      const step = parseNumber(input.dataset.step ?? '') || 1;
      const now = parseNumber(input.value);
      const next = (Number.isFinite(now) ? now : 0) + (e.key === 'ArrowUp' ? step : -step);
      input.value = String(Math.round(next * 1e9) / 1e9);
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return;
    }
    // Single characters only; Enter, arrows, Backspace, Tab... are longer key names.
    if (e.key.length === 1 && !TYPING.test(after(e.target, e.key))) e.preventDefault();
  }, true);
  document.addEventListener('beforeinput', (e) => {
    if (!isNumberField(e.target) || !(e.inputType ?? 'insertText').startsWith('insert')) return;
    const text = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
    if (!TYPING.test(after(e.target, text))) e.preventDefault();
  }, true);
  document.addEventListener('paste', (e) => {
    if (!isNumberField(e.target)) return;
    const text = (e.clipboardData?.getData('text/plain') ?? '').trim();
    if (!TYPING.test(after(e.target, text))) e.preventDefault();
  }, true);
}
