import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { describe, expect, it } from 'vitest';
import { toSaved } from '../src/app/autosave';
import type { SavedScene } from '../src/app/autosave';
import type { ObjectState, SceneState } from '../src/scene/document';
import { readProject, writeProject } from '../src/io/project';

const NOT_PROJECT = 'This is not a 3D Open Builder project file, or it was made by a newer version.';
const DAMAGED = 'This project file is damaged and cannot be opened.';

const tri = () => ({
  positions: new Float32Array([0, 0, 0, 1.5, 0, 0, 0, 2.25, 0.1]),
  indices: new Uint32Array([0, 1, 2]),
});

function object(id: number, data: ReturnType<typeof tri>, extra: Partial<ObjectState> = {}): ObjectState {
  return {
    id,
    name: `Object ${id}`,
    data,
    color: '#4c9be8',
    defaultColor: '#4c9be8',
    position: [1, 2, 3],
    quaternion: [0, 0, 0, 1],
    scale: [1, 1, 1],
    ...extra,
  };
}

function scene(objects: ObjectState[], extras: Record<string, unknown> = {}): SavedScene {
  const point = (v: number[]) => ({ toArray: () => v }) as never;
  const state: SceneState = {
    objects,
    measurements: [{ kind: 'distance', points: [{ objectId: 1, local: point([1, 2, 3]) }, { local: point([4, 5, 6]) }] }],
  };
  return toSaved(state, 'My drawing', extras);
}

/** Rewrite scene.json inside a project zip. */
function withJson(bytes: Uint8Array, change: (json: Record<string, any>) => void): Uint8Array {
  const files = unzipSync(bytes);
  const json = JSON.parse(strFromU8(files['scene.json']));
  change(json);
  files['scene.json'] = strToU8(JSON.stringify(json));
  return zipSync(files);
}

describe('project file', () => {
  it('keeps every field and the mesh bytes through a round trip', () => {
    const a = tri();
    const saved = scene(
      [object(1, a, { groupId: 7, hidden: true, thread: { kind: 'bolt' } as never })],
      { reference: { dataUrl: 'data:x', scale: 2 } },
    );
    const back = readProject(writeProject(saved));
    expect(back.version).toBe(1);
    expect(back.name).toBe('My drawing');
    expect(back.savedAt).toBe(saved.savedAt);
    expect(back.objects).toHaveLength(1);
    const o = back.objects[0];
    expect(o).toMatchObject({ id: 1, name: 'Object 1', color: '#4c9be8', defaultColor: '#4c9be8', position: [1, 2, 3], quaternion: [0, 0, 0, 1], scale: [1, 1, 1] });
    expect(o.groupId).toBe(7);
    expect(o.hidden).toBe(true);
    expect(o.thread).toEqual({ kind: 'bolt' });
    expect(o.data.positions).toBeInstanceOf(Float32Array);
    expect(o.data.indices).toBeInstanceOf(Uint32Array);
    expect(Array.from(new Uint8Array(o.data.positions.buffer))).toEqual(Array.from(new Uint8Array(a.positions.buffer)));
    expect(Array.from(o.data.indices)).toEqual([0, 1, 2]);
    expect(back.measurements).toEqual(saved.measurements);
    expect(back.extras).toEqual({ reference: { dataUrl: 'data:x', scale: 2 } });
  });

  it('writes one mesh entry for objects that share a mesh, and shares it again when read', () => {
    const shared = tri();
    const bytes = writeProject(scene([object(1, shared), object(2, shared), object(3, tri())]));
    expect(Object.keys(unzipSync(bytes)).sort()).toEqual(['meshes/0.idx', 'meshes/0.pos', 'meshes/1.idx', 'meshes/1.pos', 'scene.json']);
    const back = readProject(bytes);
    expect(back.objects[0].data).toBe(back.objects[1].data);
    expect(back.objects[2].data).not.toBe(back.objects[0].data);
  });

  it('keeps bit-identical numbers for awkward floats', () => {
    const data = { positions: new Float32Array([Math.PI, -0, 1e-30, 3e38, 0.1, 5, 6, 7, 8]), indices: new Uint32Array([2, 1, 0]) };
    const back = readProject(writeProject(scene([object(1, data)]))).objects[0].data;
    expect(Array.from(new Uint32Array(back.positions.buffer))).toEqual(Array.from(new Uint32Array(data.positions.buffer)));
    expect(Array.from(back.indices)).toEqual([2, 1, 0]);
  });

  it('refuses damaged or foreign files with the right message', () => {
    const good = writeProject(scene([object(1, tri())]));
    expect(() => readProject(good.slice(0, good.length - 40))).toThrow(DAMAGED);
    expect(() => readProject(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]))).toThrow(DAMAGED);
    expect(() => readProject(zipSync({ 'other.txt': strToU8('hi') }))).toThrow(DAMAGED);
    expect(() => readProject(withJson(good, (j) => (j.format = 'something-else')))).toThrow(NOT_PROJECT);
    expect(() => readProject(withJson(good, (j) => (j.version = 2)))).toThrow(NOT_PROJECT);
  });

  it('refuses an index that points past the vertices, and a missing mesh', () => {
    const bad = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 5]) };
    expect(() => readProject(writeProject(scene([object(1, bad)])))).toThrow(DAMAGED);
    const good = writeProject(scene([object(1, tri())]));
    expect(() => readProject(withJson(good, (j) => (j.objects[0].mesh = 9)))).toThrow(DAMAGED);
  });

  it('refuses a mesh whose byte length is not a multiple of four', () => {
    const files = unzipSync(writeProject(scene([object(1, tri())])));
    files['meshes/0.pos'] = files['meshes/0.pos'].slice(0, 35);
    expect(() => readProject(zipSync(files))).toThrow(DAMAGED);
  });
});
