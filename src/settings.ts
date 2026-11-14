/** User preferences and UI choices, remembered in this browser (localStorage). */

export type Unit = 'mm' | 'cm' | 'in';
/** What an imported STL or OBJ file's numbers mean: one of the page's own units (the page switches to it) */
export type ImportUnit = Unit;
export const IMPORT_UNITS: Record<ImportUnit, number> = { mm: 1, cm: 10, in: 25.4 };
export type ThemeChoice = 'system' | 'light' | 'dark';
/** Accent colour presets (teal is the stylesheet's own look); colours live in style.css */
export const ACCENTS = ['teal', 'blue', 'purple', 'pink', 'orange', 'custom'] as const;
export type AccentId = (typeof ACCENTS)[number];

export interface UiState {
  view: { xray: boolean; wireframe: boolean; edges: boolean; grid: boolean; shadows: boolean; rulers: boolean };
  measure: { snap: boolean; dotted: boolean; deltas: boolean };
  keepProportions: boolean;
  shortcuts: boolean;
  /** Accent colour preset id */
  accent: AccentId;
  /** The colour picked for the Custom accent (#rrggbb) */
  accentCustom: string;
  /** Copy, Cut and Paste left out of the toolbar (mouse and keyboard screens only) */
  hideClipboard: boolean;
  /** Thinnest wall (mm) the print check accepts */
  minWall: number;
  /** Order of the side panel sections (ids from PANELS) */
  panelOrder: PanelId[];
  /** Side panel sections switched off */
  hiddenPanels: PanelId[];
  /** How much of the plate's fill shows (0 = clear, 1 = solid) */
  plateOpacity: number;
  /** How strongly the plate's minor and major grid lines show (1 = as designed) */
  gridLineOpacity: number;
  /** Numbers along the plate's X and Y axis lines */
  gridValues: boolean;
  /** Size of those numbers relative to the normal size (1 = as designed) */
  plateTextScale: number;
  /** Size of the ruler numbers relative to the normal size (1 = as designed) */
  rulerTextScale: number;
  /** Opacity of the edge lines in the Edges view (1 = solid) */
  edgeStrength: number;
  /** Light and shadow options (the Shadows tile's sliders); defaults: a little shine and contrast, shadows at 75% */
  shine: number; // 0..1, 0 = matt
  lightAngle: number; // degrees the light is turned from its usual place, -180..180
  shadowStrength: number; // 0..1, 1 = full
  surfaceContrast: number; // 0..1, 0 = none
  /** Dashed lines where objects overlap, in the Edges view */
  internalIntersections: boolean;
  /** With those: also the edges of an object where they run inside another object */
  internalEdges: boolean;
  /** Mirror image of the objects in the plate: how strong, and how deep (mm) before it fades out */
  reflection: { on: boolean; strength: number; depth: number };
  /** Overhang view: surfaces steeper than ngle degrees from vertical get color */
  overhang: { angle: number; color: string };
  /** The unit picked last time files were imported */
  importUnit: ImportUnit;
  /** Importing: each separate piece of a file becomes an object of its own */
  importSeparate: boolean;
  /** Export: hidden objects are written too */
  exportHidden: boolean;
}

export const PANELS = [
  ['view', 'View'],
  ['arrange', 'Arrange'],
  ['measure', 'Measure'],
  ['objects', 'Objects'],
  ['details', 'Details'],
] as const;
export type PanelId = (typeof PANELS)[number][0];

export interface Settings {
  unit: Unit;
  theme: ThemeChoice;
  snapping: boolean;
  /** With snapping on: moves and sizes jump in steps of this many mm (a value from snapDistanceChoices) */
  snapDistance: number;
  /** With snapping on: turns jump in steps of this many degrees (one of SNAP_ANGLES) */
  snapAngle: number;
  collision: boolean;
  /** Single-key shortcuts (1, D, M, F…); Ctrl+Z, Ctrl+C and the like always work */
  shortcuts: boolean;
  ui: UiState;
}

export const UNITS: Unit[] = ['mm', 'cm', 'in'];

/** Millimetres per unit. Geometry is always stored in mm. */
export const MM_PER_UNIT: Record<Unit, number> = { mm: 1, cm: 10, in: 25.4 };

const DEFAULTS: Settings = {
  unit: 'mm',
  theme: 'system',
  snapping: true,
  snapDistance: 1,
  snapAngle: 5,
  collision: false,
  shortcuts: true,
  ui: {
    view: { xray: false, wireframe: false, edges: true, grid: true, shadows: true, rulers: true },
    measure: { snap: true, dotted: true, deltas: false },
    keepProportions: true,
    shortcuts: true,
    accent: 'teal',
    accentCustom: '#2fb3a1',
    hideClipboard: false,
    minWall: 0.8,
    panelOrder: PANELS.map(([id]) => id),
    hiddenPanels: [],
    plateOpacity: 0.35,
    gridLineOpacity: 1,
    gridValues: true,
    plateTextScale: 1,
    rulerTextScale: 1,
    edgeStrength: 1,
    shine: 0.1,
    lightAngle: 0,
    shadowStrength: 0.75,
    surfaceContrast: 0.2,
    internalIntersections: true,
    internalEdges: true,
    reflection: { on: false, strength: 0.3, depth: 60 },
    overhang: { angle: 45, color: '#e5484d' },
    importUnit: 'mm',
    importSeparate: false,
    exportHidden: false,
  },
};

/** Snapping steps for moving and sizing: millimetres (also for cm) or fractions of an inch. Stored in mm. */
const SNAP_DISTANCES_MM = [0.1, 0.25, 0.5, 1, 2, 5];
const SNAP_FRACTIONS_IN = [1 / 64, 1 / 32, 1 / 16, 1 / 8, 1 / 4, 1 / 2];
export const SNAP_ANGLES = [1, 5, 10];

/** The distance steps offered for a unit, in mm. */
export function snapDistanceChoices(unit: Unit): number[] {
  return unit === 'in' ? SNAP_FRACTIONS_IN.map((f) => f * MM_PER_UNIT.in) : SNAP_DISTANCES_MM;
}

/** The choice closest to a value (steps are told apart by far more than any rounding). */
export function nearestChoice(choices: number[], value: number): number {
  return choices.reduce((best, c) => (Math.abs(c - value) < Math.abs(best - value) ? c : best), choices[0]);
}

/** A distance step as shown in the Settings list: "0.25 mm", "1.0 mm", "1/32 in". */
export function snapDistanceLabel(mm: number, unit: Unit): string {
  if (unit === 'in') {
    const sixtyFourths = Math.round((mm / MM_PER_UNIT.in) * 64);
    let n = sixtyFourths, d = 64;
    while (n % 2 === 0 && d > 1) { n /= 2; d /= 2; }
    return `${n}/${d} in`;
  }
  return `${Number.isInteger(mm) ? mm.toFixed(1) : mm} mm`;
}

const KEY = '3d-open-builder.settings';

function load(): Settings {
  const s: Settings = structuredClone(DEFAULTS);
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) {
      const saved = JSON.parse(raw) as Partial<Settings>;
      Object.assign(s, saved, {
        ui: {
          ...s.ui,
          ...saved.ui,
          view: { ...s.ui.view, ...saved.ui?.view },
          measure: { ...s.ui.measure, ...saved.ui?.measure },
          reflection: { ...s.ui.reflection, ...saved.ui?.reflection },
          overhang: { ...s.ui.overhang, ...saved.ui?.overhang },
        },
      });
    }
  } catch {
    // Storage blocked (private window etc.) or unreadable: use the defaults.
  }
  if (!UNITS.includes(s.unit)) s.unit = 'mm'; // older versions offered µm, ft and m
  s.snapDistance = nearestChoice(snapDistanceChoices(s.unit), typeof s.snapDistance === 'number' && s.snapDistance > 0 ? s.snapDistance : DEFAULTS.snapDistance);
  if (!SNAP_ANGLES.includes(s.snapAngle)) s.snapAngle = DEFAULTS.snapAngle;
  // Keep a saved panel order only for sections that still exist, and add new ones at the end.
  const known = PANELS.map(([id]) => id) as PanelId[];
  const saved = Array.isArray(s.ui.panelOrder) ? s.ui.panelOrder.filter((id) => known.includes(id)) : [];
  s.ui.panelOrder = [...new Set([...saved, ...known])];
  s.ui.hiddenPanels = Array.isArray(s.ui.hiddenPanels) ? s.ui.hiddenPanels.filter((id) => known.includes(id)) : [];
  if (typeof s.ui.importUnit !== 'string' || !Object.hasOwn(IMPORT_UNITS, s.ui.importUnit)) s.ui.importUnit = 'mm';
  if (!(ACCENTS as readonly string[]).includes(s.ui.accent)) s.ui.accent = 'teal';
  if (typeof s.ui.accentCustom !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(s.ui.accentCustom)) s.ui.accentCustom = DEFAULTS.ui.accentCustom;
  const clamp01 =(v: unknown, fallback: number) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : fallback);
  const inRange = (v: unknown, lo: number, hi: number, fallback: number) => (typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : fallback);
  s.ui.plateOpacity = clamp01(s.ui.plateOpacity, DEFAULTS.ui.plateOpacity);
  s.ui.minWall = inRange(s.ui.minWall, 0.1, 10, DEFAULTS.ui.minWall);
  s.ui.reflection.on = s.ui.reflection.on === true;
  s.ui.reflection.strength = inRange(s.ui.reflection.strength, 0.05, 0.8, DEFAULTS.ui.reflection.strength);
  s.ui.reflection.depth = inRange(s.ui.reflection.depth, 5, 200, DEFAULTS.ui.reflection.depth);
  s.ui.overhang.angle = inRange(s.ui.overhang.angle, 10, 80, DEFAULTS.ui.overhang.angle);
  if (typeof s.ui.overhang.color !== 'string' || !/^#[0-9a-fA-F]{6}$/.test(s.ui.overhang.color)) s.ui.overhang.color = DEFAULTS.ui.overhang.color;
  for (const k of Object.keys(DEFAULTS.ui.view) as (keyof UiState['view'])[]) s.ui.view[k] = typeof s.ui.view[k] === 'boolean' ? s.ui.view[k] : DEFAULTS.ui.view[k];
  s.ui.measure.dotted = s.ui.measure.dotted !== false;
  s.ui.measure.deltas = s.ui.measure.deltas === true;
  s.ui.gridLineOpacity = clamp01(s.ui.gridLineOpacity, 1);
  s.ui.edgeStrength = clamp01(s.ui.edgeStrength, 1);
  s.ui.shine = clamp01(s.ui.shine, DEFAULTS.ui.shine);
  s.ui.lightAngle = inRange(s.ui.lightAngle, -180, 180, 0);
  s.ui.shadowStrength = inRange(s.ui.shadowStrength, 0.1, 1, DEFAULTS.ui.shadowStrength);
  s.ui.surfaceContrast = clamp01(s.ui.surfaceContrast, DEFAULTS.ui.surfaceContrast);
  s.ui.gridValues = typeof s.ui.gridValues === 'boolean' ? s.ui.gridValues : DEFAULTS.ui.gridValues;
  s.ui.plateTextScale = inRange(s.ui.plateTextScale, 0.5, 2, DEFAULTS.ui.plateTextScale);
  s.ui.rulerTextScale = inRange(s.ui.rulerTextScale, 0.5, 2, DEFAULTS.ui.rulerTextScale);
  s.ui.importSeparate = s.ui.importSeparate === true;
  s.ui.exportHidden = s.ui.exportHidden === true;
  s.ui.internalIntersections = s.ui.internalIntersections !== false;
  s.ui.internalEdges = s.ui.internalEdges !== false;
  // Measuring always starts with snapping on (turning it off lasts for this visit only).
  s.ui.measure.snap = true;
  return s;
}

export const settings: Settings = load();
export const settingsEvents = new EventTarget();

function save(): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // Not persisted; still applies for this session.
  }
}

export function updateSettings(patch: Partial<Omit<Settings, 'ui'>>): void {
  Object.assign(settings, patch);
  // A new unit may not offer the current snap distance: take the closest one it does.
  if (patch.unit !== undefined && patch.snapDistance === undefined) settings.snapDistance = nearestChoice(snapDistanceChoices(settings.unit), settings.snapDistance);
  save();
  settingsEvents.dispatchEvent(new Event('change'));
}

/** Remember a UI choice (view toggles, measure options...). Doesn't trigger a settings refresh. */
export function updateUi(change: (ui: UiState) => void): void {
  change(settings.ui);
  save();
}

export const toUnit = (mm: number) => mm / MM_PER_UNIT[settings.unit];
export const fromUnit = (v: number) => v * MM_PER_UNIT[settings.unit];

const systemDark =window.matchMedia('(prefers-color-scheme: dark)');

export function isDarkTheme(): boolean {
  return settings.theme === 'dark' || (settings.theme === 'system' && systemDark.matches);
}

/** WCAG relative luminance of #rrggbb. */
function luminance(rgb: number[]): number {
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
const contrast = (a: number[], b: number[]) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};
/** Mix toward black (t < 0) or white (t > 0): keeps the hue, changes only the lightness. */
const shade = (rgb: number[], t: number) => rgb.map((v) => Math.round(t < 0 ? v * (1 + t) : v + (255 - v) * t));

/**
 * Put the accent on the page: a preset is a data-accent attribute (teal = none,
 * the stylesheet default); Custom sets the variables inline. The picked colour is
 * adjusted for the theme, or white text on primary buttons (light) or the dark
 * panels (dark) would be hard to read; the swatch keeps the colour as picked.
 */
export function applyAccent(): void {
  const root = document.documentElement;
  if (settings.ui.accent === 'teal') delete root.dataset.accent;
  else root.dataset.accent = settings.ui.accent;
  if (settings.ui.accent !== 'custom') {
    root.style.removeProperty('--accent');
    root.style.removeProperty('--accent-soft');
    return;
  }
  const hex = settings.ui.accentCustom;
  let rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
  const dark = isDarkTheme();
  // Light: darken until white text reaches 4.5:1. Dark: lighten until 3:1 against the #151b23 background.
  for (let i = 0; i < 40; i++) {
    const ok = dark ? contrast(rgb, [0x15, 0x1b, 0x23]) >= 3 : contrast(rgb, [255, 255, 255]) >= 4.5;
    if (ok) break;
    rgb = shade(rgb, dark ? 0.05 : -0.05);
  }
  root.style.setProperty('--accent', `rgb(${rgb.join(', ')})`);
  root.style.setProperty('--accent-soft', `rgba(${rgb.join(', ')}, ${dark ? 0.16 : 0.12})`);
}

/** Apply the theme to the page and call back whenever it changes. */
export function watchTheme(onChange: (dark: boolean) => void): void {
  const apply = () => {
    const dark = isDarkTheme();
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    applyAccent(); // the Custom accent is adjusted per theme
    onChange(dark);
  };
  systemDark.addEventListener('change', apply);
  settingsEvents.addEventListener('change', apply);
  apply();
}
applyAccent(); // at load, before the first paint (needs systemDark, so it sits down here)
