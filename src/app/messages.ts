/**
 * Turn raw error messages (from Manifold, the file readers or the browser)
 * into plain ones. Anything not known passes through unchanged.
 */
const RULES: { match: RegExp; message: string }[] = [
  {
    match: /not a valid solid|not\s?manifold/i,
    message: 'This object is not a closed solid. Run Check and Repair on it first (Fix menu).',
  },
  {
    match: /Offset is outside the bounds of the DataView|Invalid typed array length|Cannot find relationship file|invalid zip|unexpected EOF/i,
    message: 'This file is damaged or cut short and cannot be read.',
  },
  {
    match: /Array buffer allocation failed|out of memory|memory access out of bounds|Cannot enlarge memory/i,
    message: 'Not enough memory for this. Try a smaller or simpler model.',
  },
  {
    match: /Maximum call stack size exceeded/i,
    message: 'This is too large to work out here. Try a smaller or simpler model.',
  },
];

export function friendlyError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return RULES.find((r) => r.match.test(raw))?.message ?? raw;
}
