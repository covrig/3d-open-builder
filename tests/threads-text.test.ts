import { readFileSync } from 'node:fs';
import Module, { type ManifoldToplevel, type Mat4 } from 'manifold-3d';
import { parse } from 'opentype.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { textOnFace } from '../src/geometry/features';
import { meshDataToManifold, type MeshData } from '../src/geometry/meshData';
import { countPieces } from '../src/geometry/meshCheck';
import { bounds } from '../src/geometry/meshOps';
import { createPrimitive } from '../src/geometry/primitives';
import { textOutlines } from '../src/geometry/text';
import { ISO_THREADS, makeThreaded } from '../src/geometry/threads';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
const volume = (mesh: MeshData) => {
  const m = meshDataToManifold(wasm, mesh);
  const v = m.volume();
  m.delete();
  return v;
};

describe('threads', () => {
  it('builds an M6 rod between its minor and major cylinders', () => {
    const { d, P } = ISO_THREADS.M6;
    const rod = makeThreaded(wasm, { kind: 'rod', size: 'M6', length: 10, clearance: 0 });
    const minorR = d / 2 - 0.625 * 0.866 * P;
    const v = volume(rod.mesh);
    expect(v).toBeGreaterThan(Math.PI * minorR ** 2 * 10);
    expect(v).toBeLessThan(Math.PI * (d / 2) ** 2 * 10);
    const b = bounds(rod.mesh);
    expect(b.max[0] - b.min[0]).toBeCloseTo(d, 1);
    expect(b.max[2] - b.min[2]).toBeCloseTo(10, 3);
  });

  it('makes a nut with a threaded hole and a bolt with a head', () => {
    const nut = makeThreaded(wasm, { kind: 'nut', size: 'M8', length: 0, clearance: 0.2 });
    const t = ISO_THREADS.M8;
    const hexArea = (Math.sqrt(3) / 2) * t.af ** 2;
    expect(volume(nut.mesh)).toBeLessThan(hexArea * t.m);
    const bolt = makeThreaded(wasm, { kind: 'bolt', size: 'M8', length: 20, clearance: 0 });
    const b = bounds(bolt.mesh);
    expect(b.max[2] - b.min[2]).toBeCloseTo(t.k + 20, 1);
  });

  it('gives internal threads clearance so a bolt fits', () => {
    const rod = volume(makeThreaded(wasm, { kind: 'rod', size: 'M5', length: 10, clearance: 0 }).mesh);
    const tap = volume(makeThreaded(wasm, { kind: 'tap', size: 'M5', length: 10, clearance: 0.2 }).mesh);
    expect(tap).toBeGreaterThan(rod);
  });
});

describe('text on a face', () => {
  const font = parse(readFileSync('public/fonts/Roboto-Bold.ttf').buffer as ArrayBuffer);

  it('turns letters into outlines at the requested height, keeping holes', () => {
    const polys = textOutlines(font, 'O', 10);
    const ys = polys.flat().map((p) => p[1]);
    expect(Math.max(...ys) - Math.min(...ys)).toBeGreaterThan(9.5);
    // The O's hole must stay open: filled area is less than the outer outline's area.
    const filled = new wasm.CrossSection(polys, 'NonZero');
    const outer = new wasm.CrossSection([polys[0]], 'NonZero');
    expect(filled.area()).toBeLessThan(outer.area() * 0.8);
    filled.delete();
    outer.delete();
  });

  it('embosses and debosses text on the top of a cube', () => {
    const polys = textOutlines(font, 'Hi', 8);
    const onTop: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 20, 1];
    const cube = createPrimitive(wasm, 'cube');
    const up = volume(textOnFace(wasm, { mesh: cube, matrix: IDENTITY }, { polygons: polys, depth: 1, mode: 'emboss', frame: onTop }).mesh);
    const down = volume(textOnFace(wasm, { mesh: cube, matrix: IDENTITY }, { polygons: polys, depth: 1, mode: 'deboss', frame: onTop }).mesh);
    expect(up).toBeGreaterThan(64000);
    expect(down).toBeLessThan(64000);
    // The same letters are added and removed: the differences match.
    expect(up - 64000).toBeCloseTo(64000 - down, 0);
  });

  it('also returns the letters as a solid in world space', () => {
    const polys = textOutlines(font, 'Hi', 8);
    const onTop: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 20, 1];
    const cube = createPrimitive(wasm, 'cube');
    for (const mode of ['emboss', 'deboss'] as const) {
      const { letters } = textOnFace(wasm, { mesh: cube, matrix: IDENTITY }, { polygons: polys, depth: 1, mode, frame: onTop });
      expect(letters.indices.length).toBeGreaterThan(0);
      // The raised letters stand on the top face (z = 20); the cut-away ones sit just under it.
      const b = bounds(letters);
      expect(mode === 'emboss' ? b.max[2] : b.min[2]).toBeCloseTo(mode === 'emboss' ? 21 : 19, 3);
    }
  });

  it('follows a round surface: letters on a sphere touch it all along', () => {
    const polys = textOutlines(font, 'Text', 8);
    const sphere = createPrimitive(wasm, 'sphere');
    const top = bounds(sphere).max[2];
    const frame: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, top, 1];
    const area = new wasm.CrossSection(polys, 'NonZero');
    const letterArea = area.area();
    area.delete();
    const base = volume(sphere);
    for (const mode of ['emboss', 'deboss'] as const) {
      const r = textOnFace(wasm, { mesh: sphere, matrix: IDENTITY }, { polygons: polys, depth: 1, mode, frame }).mesh;
      // One solid: no letter floats free of the ball.
      expect(countPieces(r)).toBe(1);
      // A layer 1 mm thick under every letter, measured along the face direction.
      expect(Math.abs(volume(r) - base)).toBeGreaterThan(letterArea * 0.9);
      expect(Math.abs(volume(r) - base)).toBeLessThan(letterArea * 1.1);
    }
  });

  it('allows text on the side of a default cylinder', () => {
    const polys = textOutlines(font, 'Hello', 8);
    const cyl = createPrimitive(wasm, 'cylinder');
    const b = bounds(cyl);
    const r = (b.max[0] - b.min[0]) / 2;
    // Face normal +X at the middle of the side.
    const frame: Mat4 = [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, r, 0, (b.min[2] + b.max[2]) / 2, 1];
    const out = textOnFace(wasm, { mesh: cyl, matrix: IDENTITY }, { polygons: polys, depth: 1, mode: 'emboss', frame }).mesh;
    expect(volume(out)).toBeGreaterThan(volume(cyl));
  });

  it('refuses text on a thread', () => {
    const polys = textOutlines(font, 'Hi', 8);
    const rod = makeThreaded(wasm, { kind: 'rod', size: 'M6', length: 20, clearance: 0 }).mesh;
    const b = bounds(rod);
    const frame: Mat4 = [0, 1, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, b.max[0], 0, (b.min[2] + b.max[2]) / 2, 1];
    for (const mode of ['emboss', 'deboss'] as const) {
      expect(() => textOnFace(wasm, { mesh: rod, matrix: IDENTITY }, { polygons: polys, depth: 0.5, mode, frame })).toThrow(/too complex for text/);
    }
  });
});
