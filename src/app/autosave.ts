import * as THREE from 'three';
import type { Measurement, ObjectState, SceneDocument, SceneState } from '../scene/document';
import { idbDelete, idbGet, idbPut } from './idb';

const KEY = 'scene';
const LOCAL_KEY = '3d-open-builder.autosave';
const INTERVAL_MS = 60_000;

/** What is stored: plain data only (typed arrays and numbers), no class instances. */
export interface SavedScene {
  version: 1;
  savedAt: number;
  name: string;
  objects: ObjectState[];
  measurements: { kind: Measurement['kind']; points: { objectId?: number; local: number[] }[] }[];
  /** Extra data owned by other features (e.g. the reference picture). */
  extras?: Record<string, unknown>;
}

export function toSaved(state: SceneState, name: string, extras: Record<string, unknown>): SavedScene {
  return {
    version: 1,
    savedAt: Date.now(),
    name,
    objects: state.objects,
    measurements: state.measurements.map((m) => ({
      kind: m.kind,
      points: m.points.map((p) => ({ objectId: p.objectId, local: p.local.toArray() })),
    })),
    extras,
  };
}

export function fromSaved(saved: SavedScene): SceneState {
  return {
    objects: saved.objects,
    measurements: saved.measurements.map((m) => ({
      kind: m.kind,
      points: m.points.map((p) => ({ objectId: p.objectId, local: new THREE.Vector3().fromArray(p.local) })),
    })),
  };
}

/** localStorage only holds strings, so typed arrays become plain arrays there. */
export function toJson(saved: SavedScene): string {
  return JSON.stringify(saved, (_, v) =>
    v instanceof Float32Array ? { f32: Array.from(v) } : v instanceof Uint32Array ? { u32: Array.from(v) } : v,
  );
}

export function fromJson(text: string): SavedScene {
  return JSON.parse(text, (_, v) =>
    v && typeof v === 'object' && 'f32' in v ? new Float32Array(v.f32) : v && typeof v === 'object' && 'u32' in v ? new Uint32Array(v.u32) : v,
  ) as SavedScene;
}

export async function loadAutosave(): Promise<SavedScene | undefined> {
  try {
    const saved = await idbGet<SavedScene>('autosave', KEY);
    if (saved) return saved;
  } catch {
    // Fall through to localStorage.
  }
  try {
    const text = localStorage.getItem(LOCAL_KEY);
    return text ? fromJson(text) : undefined;
  } catch {
    return undefined;
  }
}

export async function clearAutosave(): Promise<void> {
  try {
    await idbDelete('autosave', KEY);
  } catch {
    // ignore
  }
  try {
    localStorage.removeItem(LOCAL_KEY);
  } catch {
    // ignore
  }
}

async function store(saved: SavedScene): Promise<void> {
  try {
    await idbPut('autosave', KEY, saved);
    return;
  } catch {
    // IndexedDB unavailable: try localStorage (may be too small for big models).
  }
  try {
    localStorage.setItem(LOCAL_KEY, toJson(saved));
  } catch {
    // Neither store works; nothing more we can do.
  }
}

/**
 * Saves the scene to browser storage every 60 seconds, but only after
 * something changed, and once more when the page is hidden or closed.
 */
export class Autosave {
  private dirty = false;
  private suspended = false;
  /** Other features add their own data to each save. */
  readonly extras = new Map<string, () => unknown>();

  constructor(
    private readonly doc: SceneDocument,
    private readonly name: () => string,
  ) {
    for (const type of ['change', 'transform', 'history'] as const) {
      doc.addEventListener(type, () => (this.dirty = true));
    }
    window.setInterval(() => void this.saveIfDirty(), INTERVAL_MS);
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'hidden') void this.saveIfDirty();
    });
  }

  markDirty(): void {
    this.dirty = true;
  }

  /** Pause saving (e.g. while the restore question is open). */
  suspend(value: boolean): void {
    this.suspended = value;
  }

  get hasUnsavedChanges(): boolean {
    return this.dirty;
  }

  async saveIfDirty(): Promise<void> {
    if (!this.dirty || this.suspended) return;
    this.dirty = false;
    await this.saveNow();
  }

  async saveNow(): Promise<void> {
    if (this.doc.objects.length === 0 && this.doc.measurements.length === 0) {
      await clearAutosave();
      return;
    }
    const extras: Record<string, unknown> = {};
    for (const [k, fn] of this.extras) extras[k] = fn();
    await store(toSaved(this.doc.exportState(), this.name(), extras));
  }
}
