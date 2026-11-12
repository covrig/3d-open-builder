/** User preferences and UI choices, remembered in this browser (localStorage). */

export type Unit = 'mm' | 'cm' | 'in';
/** What an imported STL or OBJ file's numbers mean: one of the page's own units (the page switches to it) */
export type ImportUnit = Unit;
export const IMPORT_UNITS: Record<ImportUnit, number> = { mm: 1, cm: 10, in: 25.4 };
export type ThemeChoice = 'system' | 'light' | 'dark';

export interface UiState {
  view: { xray: boolean; wireframe: boolean; edges: boolean; grid: boolean; shadows: boolean; rulers: boolean };
  measure: { snap: boolean; dotted: boolean; deltas: boolean };
  keepProportions: boolean;
  shortcuts: boolean;
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
  /** Opacity of the edge lines in the Edges view (1 = solid) */
  edgeStrength: number;
  /** Dashed lines where objects overlap, in the Edges view */
  internalIntersections: boolean;
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
  collision: false,
  shortcuts: true,
  ui: {
    view: { xray: false, wireframe: false, edges: true, grid: true, shadows: true, rulers: true },
    measure: { snap: true, dotted: true, deltas: false },
    keepProportions: true,
    shortcuts: true,
    hideClipboard: false,
    minWall: 0.8,
    panelOrder: PANELS.map(([id]) => id),
    hiddenPanels: [],
    plateOpacity: 0.35,
    gridLineOpacity: 1,
    gridValues: false,
    edgeStrength: 1,
    internalIntersections: true,
    reflection: { on: false, strength: 0.3, depth: 60 },
    overhang: { angle: 45, color: '#e5484d' },
    importUnit: 'mm',
    importSeparate: false,
    exportHidden: false,
  },
};
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
  // Keep a saved panel order only for sections that still exist, and add new ones at the end.
  const known = PANELS.map(([id]) => id) as PanelId[];
  const saved = Array.isArray(s.ui.panelOrder) ? s.ui.panelOrder.filter((id) => known.includes(id)) : [];
  s.ui.panelOrder = [...new Set([...saved, ...known])];
  s.ui.hiddenPanels = Array.isArray(s.ui.hiddenPanels) ? s.ui.hiddenPanels.filter((id) => known.includes(id)) : [];
  if (typeof s.ui.importUnit !== 'string' || !Object.hasOwn(IMPORT_UNITS, s.ui.importUnit)) s.ui.importUnit = 'mm';
  const clamp01 = (v: unknown, fallback: number) => (typeof v === 'number' && v >= 0 && v <= 1 ? v : fallback);
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
  s.ui.gridValues = s.ui.gridValues === true;
  s.ui.importSeparate = s.ui.importSeparate === true;
  s.ui.exportHidden = s.ui.exportHidden === true;
  s.ui.internalIntersections = s.ui.internalIntersections !== false;
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

const systemDark = window.matchMedia('(prefers-color-scheme: dark)');

export function isDarkTheme(): boolean {
  return settings.theme === 'dark' || (settings.theme === 'system' && systemDark.matches);
}

/** Apply the theme to the page and call back whenever it changes. */
export function watchTheme(onChange: (dark: boolean) => void): void {
  const apply = () => {
    const dark = isDarkTheme();
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    onChange(dark);
  };
  systemDark.addEventListener('change', apply);
  settingsEvents.addEventListener('change', apply);
  apply();
}
