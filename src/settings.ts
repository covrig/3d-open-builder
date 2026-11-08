/** User preferences and UI choices, remembered in this browser (localStorage). */

export type Unit = 'mm' | 'cm' | 'in';
export type ThemeChoice = 'system' | 'light' | 'dark';

export interface UiState {
  view: { xray: boolean; wireframe: boolean; edges: boolean; grid: boolean; shadows: boolean };
  measure: { snap: boolean; dotted: boolean; deltas: boolean };
  keepProportions: boolean;
  shortcuts: boolean;
  /** Thinnest wall (mm) the print check accepts */
  minWall: number;
}

export interface Settings {
  unit: Unit;
  theme: ThemeChoice;
  snapping: boolean;
  collision: boolean;
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
  ui: {
    view: { xray: false, wireframe: false, edges: false, grid: true, shadows: true },
    measure: { snap: true, dotted: true, deltas: false },
    keepProportions: true,
    shortcuts: false,
    minWall: 0.8,
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
        },
      });
    }
  } catch {
    // Storage blocked (private window etc.) or unreadable: use the defaults.
  }
  if (!UNITS.includes(s.unit)) s.unit = 'mm'; // older versions offered µm, ft and m
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
