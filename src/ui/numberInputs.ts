/**
 * Number fields accept only numbers. Browsers differ: some let any letter into
 * <input type="number">, others allow "e" (scientific notation). Digits, the
 * decimal point and a minus sign are let through; everything else is
 * stopped as it is typed or pasted. Works for fields created later too.
 */
const ALLOWED = /^[0-9.-]*$/;

const isNumberField = (t: EventTarget | null): t is HTMLInputElement =>
  t instanceof HTMLInputElement && t.type === 'number';

export function restrictNumberInputs(): void {
  document.addEventListener('keydown', (e) => {
    if (!isNumberField(e.target) || e.ctrlKey || e.metaKey || e.altKey) return;
    // Single characters only; Enter, arrows, Backspace, Tab... are longer key names.
    if (e.key.length === 1 && !ALLOWED.test(e.key)) e.preventDefault();
  }, true);
  document.addEventListener('beforeinput', (e) => {
    if (!isNumberField(e.target)) return;
    const text = e.data ?? e.dataTransfer?.getData('text/plain') ?? '';
    if (!ALLOWED.test(text)) e.preventDefault();
  }, true);
  document.addEventListener('paste', (e) => {
    if (!isNumberField(e.target)) return;
    const text = (e.clipboardData?.getData('text/plain') ?? '').trim();
    if (!ALLOWED.test(text)) e.preventDefault();
  }, true);
}
