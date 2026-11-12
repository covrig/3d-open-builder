import { readFileSync } from 'node:fs';
import Module, { type ManifoldToplevel, type Mat4 } from 'manifold-3d';
import { parse } from 'opentype.js';
import { beforeAll, describe, expect, it } from 'vitest';
import { textOnFace } from '../src/geometry/features';
import { createPrimitive } from '../src/geometry/primitives';
import { missingCharacters, textOutlines } from '../src/geometry/text';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

const raw = readFileSync('public/fonts/Roboto-Bold.ttf');
const font = parse(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength) as ArrayBuffer);

describe('text the font cannot draw', () => {
  it('leaves out characters the font lacks instead of drawing a box', () => {
    expect(textOutlines(font, '日本', 8)).toHaveLength(0);
    // Letters around a missing one still come out, and without a box in between.
    expect(textOutlines(font, 'I日I', 8).length).toBe(textOutlines(font, 'II', 8).length);
  });

  it('names the missing characters once each, not spaces', () => {
    expect(missingCharacters(font, 'a 日 本 日b')).toEqual(['日', '本']);
    expect(missingCharacters(font, 'Hello world')).toEqual([]);
  });
});

describe('long text', () => {
  it('500 characters on a long bar no longer overflow the stack', () => {
    const polygons = textOutlines(font, '@'.repeat(500), 2);
    expect(polygons.flat().length).toBeGreaterThan(125_000);
    const bar = createPrimitive(wasm, 'cube', { width: 4000, depth: 100, height: 10 });
    const onTop: Mat4 = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 5, 1];
    const identity = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1];
    let error: unknown;
    try {
      textOnFace(wasm, { mesh: bar, matrix: identity }, { polygons, depth: 1, mode: 'emboss', frame: onTop });
    } catch (e) {
      error = e;
    }
    expect(error instanceof RangeError).toBe(false);
  }, 60_000);
});
