// @vitest-environment happy-dom
// Autosave: one slot per tab, validation of stored scenes, and honest success/failure.
import Module, { type ManifoldToplevel } from 'manifold-3d';
import * as THREE from 'three';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

// A small in-memory stand-in for IndexedDB (happy-dom has none).
const store = new Map<string, unknown>();
const fail = { put: false, local: false };
vi.mock('../src/app/idb', () => ({
  idbGet: async (_s: string, key: string) => store.get(key),
  idbPut: async (_s: string, key: string, value: unknown) => {
    if (fail.put) throw new Error('quota');
    store.set(key, value);
  },
  idbDelete: async (_s: string, key: string) => void store.delete(key),
  idbKeys: async () => [...store.keys()],
}));

import {
  Autosave, clearAutosave, claimTab, loadAutosave, pickSlot, restoreChoice, toSaved, validateSaved,
} from '../src/app/autosave';
import { createPrimitive } from '../src/geometry/primitives';
import { SceneDocument } from '../src/scene/document';

// Make localStorage refuse writes on demand. (Spied once: happy-dom does not take a second spy after a restore.)
const realSetItem = Storage.prototype.setItem;
vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, k: string, v: string) {
  if (fail.local) throw new Error('blocked');
  return realSetItem.call(this, k, v);
});

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const DAY = 24 * 3600 * 1000;
const NOW = 100 * DAY;

function sampleDoc(): SceneDocument {
  const doc = new SceneDocument(new THREE.Group());
  doc.add('Cube', createPrimitive(wasm, 'cube'));
  return doc;
}
const sampleSaved = (savedAt = NOW) => ({ ...toSaved(sampleDoc().exportState(), 'x', {}), savedAt });

describe('restoreChoice (start-up Restore dialog)', () => {
  it('only the Start empty button discards; Esc (empty value) and anything else restores', () => {
    expect(restoreChoice('discard')).toBe('discard');
    expect(restoreChoice('restore')).toBe('restore');
    expect(restoreChoice('')).toBe('restore');
    expect(restoreChoice('cancel')).toBe('restore');
  });
});

describe('pickSlot', () => {
  const slot = (key: string, ageDays: number) => ({ key, savedAt: NOW - ageDays * DAY });

  it('uses this tab\'s own slot even when others are newer', () => {
    const r = pickSlot([slot('scene:a', 5), slot('scene:b', 1)], 'scene:a', [], NOW);
    expect(r.use).toBe('scene:a');
  });
  it('else takes the newest slot whose tab is closed', () => {
    const r = pickSlot([slot('scene:a', 5), slot('scene:b', 2), slot('scene:c', 1)], 'scene:me', [], NOW);
    expect(r.use).toBe('scene:c');
  });
  it('skips slots whose tab is still open, and never deletes them', () => {
    const r = pickSlot([slot('scene:b', 2), slot('scene:c', 1)], 'scene:me', ['scene:c'], NOW);
    expect(r.use).toBe('scene:b');
    expect(r.prune).not.toContain('scene:c');
  });
  it('offers nothing when every other slot is open elsewhere', () => {
    expect(pickSlot([slot('scene:c', 1)], 'scene:me', ['scene:c'], NOW).use).toBeUndefined();
  });
  it('prunes slots older than 30 days and never offers them', () => {
    const r = pickSlot([slot('scene:old', 31), slot('scene:new', 3)], 'scene:me', [], NOW);
    expect(r.use).toBe('scene:new');
    expect(r.prune).toEqual(['scene:old']);
    expect(pickSlot([slot('scene:old', 31)], 'scene:me', [], NOW).use).toBeUndefined();
  });
  it('keeps at most the 5 newest, but never this tab\'s slot or an open tab\'s', () => {
    const slots = [1, 2, 3, 4, 5, 6, 7, 8].map((d) => slot(`scene:s${d}`, d));
    const r = pickSlot(slots, 'scene:s8', ['scene:s7'], NOW);
    expect(r.use).toBe('scene:s8');
    expect(r.prune.sort()).toEqual(['scene:s6']);
    expect(r.prune).not.toContain('scene:s8');
    expect(r.prune).not.toContain('scene:s7');
  });
});

describe('validateSaved', () => {
  it('accepts a real record and fills in missing measurements', () => {
    const saved = sampleSaved();
    expect(validateSaved(saved).objects).toHaveLength(1);
    const { measurements: _m, ...without } = saved;
    expect(validateSaved(without).measurements).toEqual([]);
  });
  it('rejects damaged records', () => {
    const msg = 'The saved drawing is damaged and cannot be opened.';
    const good = () => structuredClone(sampleSaved());
    const breakIt: ((s: any) => void)[] = [
      (s) => (s.version = 2),
      (s) => (s.objects = 'no'),
      (s) => (s.objects[0].id = 'x'),
      (s) => (s.objects[0].name = 5),
      (s) => (s.objects[0].color = undefined),
      (s) => (s.objects[0].data.positions = new Float32Array(4)),
      (s) => (s.objects[0].data.positions = [1, 2, 3]),
      (s) => (s.objects[0].data.indices = new Uint32Array([0, 1])),
      (s) => (s.objects[0].data.indices = new Uint32Array([0, 1, 999])),
      (s) => (s.objects[0].position = [0, 0]),
      (s) => (s.objects[0].scale = [1, NaN, 1]),
      (s) => (s.objects[0].quaternion = [0, 0, 1]),
      (s) => (s.measurements = [{ kind: 'distance', points: [{ local: [1, 2] }] }]),
      (s) => (s.measurements = 'x'),
    ];
    for (const [i, f] of breakIt.entries()) {
      const s = good();
      f(s);
      expect(() => validateSaved(s), `case ${i}`).toThrow(msg);
    }
    expect(() => validateSaved(null)).toThrow(msg);
    expect(() => validateSaved('x')).toThrow(msg);
  });
});

describe('slots in storage', () => {
  beforeEach(() => {
    store.clear();
    fail.put = false;
    localStorage.clear();
  });

  it('keeps this tab\'s slot under its own key and clears only that', async () => {
    const id = await claimTab();
    store.set(`scene:${id}`, sampleSaved());
    store.set('scene:other', sampleSaved(Date.now()));
    expect((await loadAutosave())?.objects).toHaveLength(1);
    await clearAutosave();
    expect(store.has(`scene:${id}`)).toBe(false);
    expect(store.has('scene:other')).toBe(true);
  });

  it('adopts the newest slot of a closed tab by moving it to this tab\'s key', async () => {
    const id = await claimTab();
    store.set('scene:old1', sampleSaved(Date.now() - 3 * DAY));
    store.set('scene:old2', { ...sampleSaved(Date.now()), name: 'newest' });
    const got = await loadAutosave();
    expect(got?.name).toBe('newest');
    expect(store.has('scene:old2')).toBe(false);
    expect((store.get(`scene:${id}`) as { name: string }).name).toBe('newest');
    expect(store.has('scene:old1')).toBe(true);
  });

  it('moves the old single slot to this tab\'s key', async () => {
    const id = await claimTab();
    store.set('scene', sampleSaved());
    expect(await loadAutosave()).toBeDefined();
    expect(store.has('scene')).toBe(false);
    expect(store.has(`scene:${id}`)).toBe(true);
  });

  it('returns undefined for a damaged record and leaves it stored', async () => {
    const id = await claimTab();
    const bad = { ...sampleSaved(), version: 9 };
    store.set(`scene:${id}`, bad);
    expect(await loadAutosave()).toBeUndefined();
    expect(store.get(`scene:${id}`)).toBe(bad);
  });
});

describe('save reports what really happened', () => {
  beforeEach(() => {
    store.clear();
    fail.put = false;
    fail.local = false;
  });

  it('saveNow is true when stored, and false when both stores fail', async () => {
    const autosave = new Autosave(sampleDoc(), () => 'x');
    expect(await autosave.saveNow()).toBe(true);
    fail.put = true;
    fail.local = true;
    expect(await autosave.saveNow()).toBe(false);
  });

  it('falls back to localStorage when IndexedDB fails', async () => {
    fail.put = true;
    const autosave = new Autosave(sampleDoc(), () => 'x');
    expect(await autosave.saveNow()).toBe(true);
  });

  it('an empty scene counts as success', async () => {
    const autosave = new Autosave(new SceneDocument(new THREE.Group()), () => 'x');
    expect(await autosave.saveNow()).toBe(true);
  });

  it('a failed timed save stays dirty and warns only once', async () => {
    const onFailure = vi.fn();
    const autosave = new Autosave(sampleDoc(), () => 'x', onFailure);
    fail.put = true;
    fail.local = true;
    autosave.markDirty();
    await autosave.saveIfDirty();
    expect(autosave.hasUnsavedChanges).toBe(true);
    await autosave.saveIfDirty();
    expect(onFailure).toHaveBeenCalledTimes(1);
    fail.put = false;
    await autosave.saveIfDirty();
    expect(autosave.hasUnsavedChanges).toBe(false);
  });
});
