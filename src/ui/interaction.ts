/**
 * Lets a tool take over clicks and pointer movement in the 3D view (for
 * picking edges, faces or points). While set, clicks don't select objects.
 */
export const viewClicks: {
  onClick: ((e: PointerEvent) => void) | null;
  onMove: ((e: PointerEvent) => void) | null;
  /** Arrow keys while a tool is active; return true if the tool used the key. */
  onKey: ((e: KeyboardEvent) => boolean) | null;
} = { onClick: null, onMove: null, onKey: null };
