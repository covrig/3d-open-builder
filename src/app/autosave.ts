import * as THREE from 'three';
import type { Measurement, ObjectState, SceneDocument, SceneState } from '../scene/document';
import { idbDelete, idbGet, idbKeys, idbPut } from './idb';

/** The old single slot, from before each tab got its own. */
const LEGACY_KEY = 'scene';
const SLOT_PREFIX = 'scene:';
const TAB_KEY = '3d-open-builder.tab';
const LOCK_PREFIX = '3d-open-builder.tab.';
const LOCAL_KEY = '3d-open-builder.autosave';
const INTERVAL_MS = 60_000;
const MAX_SLOTS = 5;
const MAX_AGE_MS = 30 * 24 * 3600 * 1000;

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

const DAMAGED = 'The saved drawing is damaged and cannot be opened.';

function numbers(v: unknown, n: number): v is number[] {
  return Array.isArray(v) && v.length === n && v.every((x) => typeof x === 'number' && Number.isFinite(x));
}

/** Check a stored record before anything uses it; throws when it is not a usable scene. */
export function validateSaved(value: unknown): SavedScene {
  const bad = () => new Error(DAMAGED);
  if (!value || typeof value !== 'object') throw bad();
  const v = value as Record<string, unknown>;
  if (v.version !== 1 || !Array.isArray(v.objects)) throw bad();
  for (const o of v.objects as Record<string, unknown>[]) {
    if (!o || typeof o !== 'object') throw bad();
    if (typeof o.id !== 'number' || typeof o.name !== 'string' || typeof o.color !== 'string') throw bad();
    const d = o.data as { positions?: unknown; indices?: unknown } | undefined;
    if (!d || !(d.positions instanceof Float32Array) || d.positions.length % 3 !== 0) throw bad();
    if (!(d.indices instanceof Uint32Array) || d.indices.length % 3 !== 0) throw bad();
    const vertices = d.positions.length / 3;
    for (let i = 0; i < d.indices.length; i++) if (d.indices[i] >= vertices) throw bad();
    if (!numbers(o.position, 3) || !numbers(o.scale, 3) || !numbers(o.quaternion, 4)) throw bad();
  }
  const measurements = v.measurements ?? [];
  if (!Array.isArray(measurements)) throw bad();
  for (const m of measurements as Record<string, unknown>[]) {
    if (!m || typeof m !== 'object' || typeof m.kind !== 'string' || !Array.isArray(m.points)) throw bad();
    for (const p of m.points as Record<string, unknown>[]) {
      if (!p || typeof p !== 'object' || !numbers(p.local, 3)) throw bad();
      if (p.objectId !== undefined && typeof p.objectId !== 'number') throw bad();
    }
  }
  return {
    ...(v as unknown as SavedScene),
    name: typeof v.name === 'string' ? v.name : 'scene',
    savedAt: typeof v.savedAt === 'number' ? v.savedAt : 0,
    measurements: measurements as SavedScene['measurements'],
  };
}

/**
 * What the start-up Restore dialog's result means. Only the explicit
 * "Start empty" button throws the saved scene away; anything else (Esc, a
 * closed dialog) keeps it and restores it.
 */
export function restoreChoice(returnValue: string): 'restore' | 'discard' {
  return returnValue === 'discard' ? 'discard' : 'restore';
}

// --- One slot per tab -------------------------------------------------------

const newTabId = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36);

function readTabId(): string | undefined {
  try {
    return sessionStorage.getItem(TAB_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

function writeTabId(id: string): void {
  try {
    sessionStorage.setItem(TAB_KEY, id);
  } catch {
    // The id then lives in memory for this visit only.
  }
}

let claimed: Promise<string> | undefined;

/**
 * This tab's id (kept in sessionStorage, so a reload keeps it). The tab holds a
 * Web Lock under that id for as long as it is open, so other tabs can tell its
 * slot is in use. A duplicated tab copies sessionStorage; if the id's lock is
 * already held, it takes a new id.
 */
export function claimTab(): Promise<string> {
  claimed ??= (async () => {
    let id = readTabId() ?? newTabId();
    if (navigator.locks) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const got = await new Promise<boolean>((resolve) => {
          navigator.locks
            .request(LOCK_PREFIX + id, { ifAvailable: true }, (lock) => {
              if (!lock) {
                resolve(false);
                return undefined;
              }
              resolve(true);
              return new Promise<never>(() => {}); // held until the tab closes
            })
            .catch(() => resolve(true));
        });
        if (got) break;
        id = newTabId();
      }
    }
    writeTabId(id);
    return id;
  })();
  return claimed;
}

/** Slot keys whose tab is open right now (empty when the Locks API is missing). */
async function heldSlotKeys(): Promise<string[]> {
  if (!navigator.locks) return [];
  try {
    const { held } = await navigator.locks.query();
    return (held ?? []).flatMap((l) => (l.name?.startsWith(LOCK_PREFIX) ? [SLOT_PREFIX + l.name.slice(LOCK_PREFIX.length)] : []));
  } catch {
    return [];
  }
}

/**
 * Decide which stored slot to open, and which to delete. This tab's own slot
 * wins; else the newest slot of a tab that is closed (not in `held`) and not
 * older than 30 days. Slots of open tabs and this tab's own are never deleted;
 * of the rest, only the 5 newest are kept, and none older than 30 days.
 */
export function pickSlot(
  slots: { key: string; savedAt: number }[],
  ownKey: string,
  held: Iterable<string>,
  now: number,
): { use: string | undefined; prune: string[] } {
  const heldSet = new Set(held);
  const sorted = [...slots].sort((a, b) => b.savedAt - a.savedAt);
  const old = (s: { savedAt: number }) => now - s.savedAt > MAX_AGE_MS;
  const own = sorted.find((s) => s.key === ownKey);
  const free = sorted.find((s) => s.key !== ownKey && !heldSet.has(s.key) && !old(s));
  const use = own ? own.key : free?.key;
  const prune = sorted
    .filter((s, rank) => s.key !== ownKey && !heldSet.has(s.key) && s.key !== use && (rank >= MAX_SLOTS || old(s)))
    .map((s) => s.key);
  return { use, prune };
}

/** The saved scene to offer on start, or undefined when there is none or it is damaged. */
export async function loadAutosave(): Promise<SavedScene | undefined> {
  let found = false;
  try {
    const own = SLOT_PREFIX + (await claimTab());
    const keys = (await idbKeys('autosave')).filter((k): k is string => typeof k === 'string' && k.startsWith(SLOT_PREFIX));
    const slots: { key: string; savedAt: number }[] = [];
    for (const key of keys) {
      const v = await idbGet<{ savedAt?: unknown }>('autosave', key);
      if (v && typeof v.savedAt === 'number') slots.push({ key, savedAt: v.savedAt });
    }
    const { use, prune } = pickSlot(slots, own, await heldSlotKeys(), Date.now());
    for (const key of prune) await idbDelete('autosave', key);
    const from = use ?? LEGACY_KEY;
    const raw = await idbGet('autosave', from);
    if (raw) {
      found = true;
      const saved = validateSaved(raw);
      // A slot of another (closed) tab, or the old single slot, now belongs to this tab.
      if (from !== own) {
        await idbPut('autosave', own, raw);
        await idbDelete('autosave', from);
      }
      return saved;
    }
  } catch (err) {
    if (found && err instanceof Error && err.message === DAMAGED) return undefined; // leave the record alone
    // Otherwise IndexedDB is unavailable: fall through to localStorage.
  }
  try {
    const text = localStorage.getItem(LOCAL_KEY);
    return text ? validateSaved(fromJson(text)) : undefined;
  } catch {
    return undefined;
  }
}

export async function clearAutosave(): Promise<void> {
  try {
    await idbDelete('autosave', SLOT_PREFIX + (await claimTab()));
    await idbDelete('autosave', LEGACY_KEY);
  } catch {
    // ignore
  }
  try {
    localStorage.removeItem(LOCAL_KEY);
  } catch {
    // ignore
  }
}

/** True when the scene was kept somewhere. */
async function store(saved: SavedScene): Promise<boolean> {
  try {
    await idbPut('autosave', SLOT_PREFIX + (await claimTab()), saved);
    return true;
  } catch {
    // IndexedDB unavailable: try localStorage (may be too small for big models).
  }
  try {
    localStorage.setItem(LOCAL_KEY, toJson(saved));
    return true;
  } catch {
    return false;
  }
}

/**
 * Saves the scene to browser storage every 60 seconds, but only after
 * something changed, and once more when the page is hidden or closed.
 */
export class Autosave {
  private dirty = false;
  private suspended = false;
  /** Whether the failure callback has been called in this visit */
  private failed = false;
  /** Other features add their own data to each save. */
  readonly extras = new Map<string, () => unknown>();

  constructor(
    private readonly doc: SceneDocument,
    private readonly name: () => string,
    /** Called once when a timed or hidden-page save could not store anything. */
    private readonly onFailure?: () => void,
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

  /** Forget changes so far (e.g. the starter object), so they aren't saved on their own. */
  markClean(): void {
    this.dirty = false;
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
    if (await this.saveNow()) return;
    this.dirty = true; // nothing was stored: try again next time
    if (!this.failed) {
      this.failed = true;
      this.onFailure?.();
    }
  }

  /** Save now; false when nothing could be stored. An empty scene just clears the save. */
  async saveNow(): Promise<boolean> {
    if (this.doc.objects.length === 0 && this.doc.measurements.length === 0) {
      await clearAutosave();
      return true;
    }
    const extras: Record<string, unknown> = {};
    for (const [k, fn] of this.extras) extras[k] = fn();
    return store(toSaved(this.doc.exportState(), this.name(), extras));
  }
}
