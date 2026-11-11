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
 *
 * View tools (cross-section, overhangs) have a slot of their own: one at a
 * time, they lock editing like an exclusive tool, but measuring (a light tool)
 * still works beside them.
 */
let current: { name: string; stop: () => void; exclusive: boolean } | null = null;
let view: { name: string; stop: () => void } | null = null;
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
  // An exclusive tool doesn't share the app with a view tool either.
  if (exclusive && view) {
    const previous = view;
    view = null;
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

/** Call when a view tool opens; `stop` closes it (and must call endViewTool). */
export function beginViewTool(name: string, stop: () => void): void {
  if (view && view.name !== name) {
    const previous = view;
    view = null;
    previous.stop();
  }
  view = { name, stop };
  notify();
}

/** Call when a view tool closes. */
export function endViewTool(name: string): void {
  if (view?.name !== name) return;
  view = null;
  notify();
}

/** Close whatever tool is open (not a view tool: Esc closes those after). Returns false if none was. */
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

/** Is a tool open that locks the rest of the app (an exclusive tool or a view tool)? */
export function isLocked(): boolean {
  return current?.exclusive === true || view !== null;
}

/** Is the app locked only by a view tool, so measuring may still be used? */
export function onlyViewLocked(): boolean {
  return view !== null && current?.exclusive !== true;
}

/** Called whenever a tool opens or closes. */
export function onToolChange(listener: () => void): void {
  listeners.add(listener);
}

let busy = false;

/** A heavy job (background calculation) is running: treated like a locked app. */
export function setBusy(value: boolean): void {
  if (busy === value) return;
  busy = value;
  notify();
}

export function isBusy(): boolean {
  return busy;
}
