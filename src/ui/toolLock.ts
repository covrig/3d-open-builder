import { cancelAll } from '../geometry/workerClient';

/**
 * One interactive tool is open at a time. Starting a tool closes the one that
 * was open, so two tools never fight over clicks in the view or over the same
 * object.
 *
 * Exclusive tools (anything with Apply/Cancel: Split, the tool bar's tools)
 * lock the rest of the app until they end (see docs/tool-rules.md); only
 * Apply, Cancel and Esc end them. Ending one also stops its calculation in the
 * background, so there is a single cancel path. Light tools (measuring, colour
 * picking) lock nothing.
 */
let current: { name: string; stop: () => void; exclusive: boolean } | null = null;
const listeners = new Set<() => void>();
const notify = () => {
  for (const l of listeners) l();
};

/** Call when a tool opens; `stop` closes it (and must call endTool). */
export function beginTool(name: string, stop: () => void, exclusive = true): void {
  if (current && current.name !== name) {
    const previous = current;
    current = null;
    previous.stop();
  }
  current = { name, stop, exclusive };
  notify();
}

/** Call when a tool closes (Apply, Cancel or Esc). */
export function endTool(name: string): void {
  if (current?.name !== name) return;
  const wasExclusive = current.exclusive;
  current = null;
  // Its preview or result may still be calculating: stop that too.
  if (wasExclusive) cancelAll();
  notify();
}

/** Close whatever tool is open. Returns false if none was. */
export function stopActiveTool(): boolean {
  if (!current) return false;
  const c = current;
  c.stop();
  // A tool whose stop() didn't end it (shouldn't happen) is let go anyway.
  if (current === c) endTool(c.name);
  return true;
}

/** Is any tool open (including measuring)? */
export function isToolOpen(): boolean {
  return current !== null;
}

/** Is a tool open that locks the rest of the app? */
export function isLocked(): boolean {
  return current?.exclusive === true;
}

/** Called whenever a tool opens or closes. */
export function onToolChange(listener: () => void): void {
  listeners.add(listener);
}
