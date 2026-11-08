/**
 * Only one interactive tool (split, a feature bar, measuring, colour picking…)
 * is open at a time. Starting a tool closes the one that was open, so two
 * tools never fight over clicks in the view or over the same object.
 */
let current: { name: string; stop: () => void } | null = null;

/** Call when a tool opens; `stop` closes it (and must call endTool). */
export function beginTool(name: string, stop: () => void): void {
  if (current && current.name !== name) {
    const previous = current;
    current = null;
    previous.stop();
  }
  current = { name, stop };
}

/** Call when a tool closes. */
export function endTool(name: string): void {
  if (current?.name === name) current = null;
}

/** Close whatever tool is open. Returns false if none was. */
export function stopActiveTool(): boolean {
  if (!current) return false;
  const c = current;
  current = null;
  c.stop();
  return true;
}

export function activeTool(): string | null {
  return current?.name ?? null;
}
