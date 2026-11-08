import { parse, type Font } from 'opentype.js';

/** Fonts shipped with the app (in public/fonts, with their licences). */
export const FONTS = {
  sans: { label: 'Sans (Roboto)', file: 'fonts/Roboto-Bold.ttf' },
  serif: { label: 'Serif (Roboto Slab)', file: 'fonts/RobotoSlab-Bold.ttf' },
  mono: { label: 'Mono (Roboto Mono)', file: 'fonts/RobotoMono-Bold.ttf' },
} as const;
export type FontName = keyof typeof FONTS;

const loaded = new Map<FontName, Promise<Font>>();

/** Load a font once (fetched from the app's own files, never another site). */
export function loadFont(name: FontName): Promise<Font> {
  let p = loaded.get(name);
  if (!p) {
    p = fetch(FONTS[name].file)
      .then((r) => {
        if (!r.ok) throw new Error(`Could not load the font (${r.status})`);
        return r.arrayBuffer();
      })
      .then((buf) => parse(buf));
    loaded.set(name, p);
  }
  return p;
}

const CURVE_STEPS = 8;

/**
 * Outlines of `text` as polygons in millimetres, `size` mm tall (capital
 * letter height), centred on the origin, Y up. Curves are flattened into
 * short straight segments.
 */
export function textOutlines(font: Font, text: string, size: number): [number, number][][] {
  // Scale so capital letters are `size` mm tall.
  const capHeight = (font.tables.os2 as { sCapHeight?: number } | undefined)?.sCapHeight || font.unitsPerEm * 0.7;
  const fontSize = (size * font.unitsPerEm) / capHeight;
  const scale = fontSize / font.unitsPerEm;
  // Lay out glyph by glyph (advance + kerning). opentype.js's own text shaping
  // stops on some lookup tables in these fonts, and plain lettering doesn't need it.
  const commands = [];
  let penX = 0;
  let previous: ReturnType<Font['charToGlyph']> | undefined;
  for (const char of text) {
    const glyph = font.charToGlyph(char);
    if (previous) penX += font.getKerningValue(previous, glyph) * scale;
    commands.push(...glyph.getPath(penX, 0, fontSize).commands);
    penX += (glyph.advanceWidth ?? 0) * scale;
    previous = glyph;
  }
  const polygons: [number, number][][] = [];
  let current: [number, number][] = [];
  let x = 0, y = 0;
  const finish = () => {
    if (current.length >= 3) polygons.push(current);
    current = [];
  };
  for (const c of commands) {
    switch (c.type) {
      case 'M':
        finish();
        current.push([c.x, -c.y]);
        x = c.x; y = c.y;
        break;
      case 'L':
        current.push([c.x, -c.y]);
        x = c.x; y = c.y;
        break;
      case 'Q':
        for (let i = 1; i <= CURVE_STEPS; i++) {
          const t = i / CURVE_STEPS, u = 1 - t;
          current.push([u * u * x + 2 * u * t * c.x1 + t * t * c.x, -(u * u * y + 2 * u * t * c.y1 + t * t * c.y)]);
        }
        x = c.x; y = c.y;
        break;
      case 'C':
        for (let i = 1; i <= CURVE_STEPS; i++) {
          const t = i / CURVE_STEPS, u = 1 - t;
          current.push([
            u * u * u * x + 3 * u * u * t * c.x1 + 3 * u * t * t * c.x2 + t * t * t * c.x,
            -(u * u * u * y + 3 * u * u * t * c.y1 + 3 * u * t * t * c.y2 + t * t * t * c.y),
          ]);
        }
        x = c.x; y = c.y;
        break;
      case 'Z':
        finish();
        break;
    }
  }
  finish();
  // Centre the text block on the origin.
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const poly of polygons) for (const [px, py] of poly) {
    minX = Math.min(minX, px); maxX = Math.max(maxX, px);
    minY = Math.min(minY, py); maxY = Math.max(maxY, py);
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  return polygons.map((poly) => poly.map(([px, py]) => [px - cx, py - cy] as [number, number]));
}
