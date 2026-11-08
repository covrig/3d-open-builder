import { idbGet, idbPut } from '../app/idb';
import type { ObjectState } from '../scene/document';

/**
 * Keeps copied objects in IndexedDB so Copy / Cut survive a reload or closing
 * the tab. If storage is unavailable (e.g. a private window), the clipboard
 * still works for the current session.
 */
export async function saveClipboard(states: ObjectState[]): Promise<void> {
  try {
    await idbPut('clipboard', 'current', states);
  } catch {
    // Not persisted.
  }
}

export async function loadClipboard(): Promise<ObjectState[]> {
  try {
    return (await idbGet<ObjectState[]>('clipboard', 'current')) ?? [];
  } catch {
    return [];
  }
}
