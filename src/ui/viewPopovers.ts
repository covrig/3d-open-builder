import { setEdgeStrength } from '../scene/document';
import type { Viewport } from '../scene/viewport';
import { settings, updateUi } from '../settings';

interface Slider {
  label: string;
  tip: string;
  min: number;
  max: number;
  step: number;
  /** The slider reads right-to-left (the plate's "see-through" grows to the right, the stored value shrinks) */
  reversed?: boolean;
  get(): number;
  set(value: number): void;
  show(value: number): string;
}

/** A switch row in a popover */
interface Toggle {
  label: string;
  tip: string;
  get(): boolean;
  set(on: boolean): void;
}

interface Tile {
  title: string;
  isOn(): boolean;
  setOn(on: boolean): void;
  /** Another handler (chrome.ts) already switches the feature on a click; this only opens or closes the popover to match. */
  switchedElsewhere?: boolean;
  sliders: Slider[];
  toggles?: Toggle[];
}

const pct = (v: number) => `${Math.round(v * 100)}%`;

/**
 * The Reflection, Plate, Edges and Rulers tiles of the View section. A click switches the
 * feature on or off; switching it on opens a small popover under the tile
 * with its sliders, and the ▾ inside a tile that is on reopens it. The popover
 * closes on a click elsewhere or Esc. The values are remembered (settings.ui)
 * and applied on start-up too.
 */
export function setupViewPopovers(viewport: Viewport): void {
  const applyReflection = () => {
    const r = settings.ui.reflection;
    viewport.reflection.set(r.on, r.strength, r.depth);
    viewport.invalidate();
  };
  const applyPlate = () => {
    viewport.setGridVisible(settings.ui.view.grid);
    viewport.setPlateOpacity(settings.ui.plateOpacity);
    viewport.setGridLineOpacity(settings.ui.gridLineOpacity);
    viewport.setGridValues(settings.ui.gridValues);
    viewport.setGridTextScale(settings.ui.plateTextScale);
    viewport.invalidate();
  };
  const applyRulers = () => viewport.setRulerTextScale();

  const applyEdges = () => {
    setEdgeStrength(settings.ui.edgeStrength);
    viewport.invalidate();
  };

  const tiles: Record<string, Tile> = {
    rulers: {
      title: 'Rulers',
      isOn: () => settings.ui.view.rulers,
      setOn: () => {},
      switchedElsewhere: true,
      sliders: [{
        label: 'Number size', tip: 'Make the ruler numbers smaller or bigger. 100% is the normal size.', min: 0.5, max: 2, step: 0.05,
        get: () => settings.ui.rulerTextScale,
        set: (v) => {
          updateUi((ui) => (ui.rulerTextScale = v));
          applyRulers();
        },
        show: pct,
      }],
    },
    edges: {
      title: 'Edges',
      isOn: () => settings.ui.view.edges,
      setOn: () => {},
      switchedElsewhere: true,
      sliders: [{
        label: 'Strength', tip: 'How solid the edge lines are.', min: 0.1, max: 1, step: 0.05,
        get: () => settings.ui.edgeStrength,
        set: (v) => {
          updateUi((ui) => (ui.edgeStrength = v));
          applyEdges();
        },
        show: pct,
      }],
    },
    reflection: {
      title: 'Reflection',
      isOn: () => settings.ui.reflection.on,
      setOn: (on) => {
        updateUi((ui) => (ui.reflection.on = on));
        applyReflection();
      },
      sliders: [
        {
          label: 'Strength', tip: 'How clearly the objects show in the plate.', min: 0.05, max: 0.8, step: 0.05,
          get: () => settings.ui.reflection.strength,
          set: (v) => {
            updateUi((ui) => (ui.reflection.strength = v));
            applyReflection();
          },
          show: pct,
        },
        {
          label: 'Depth', tip: 'How far down the reflection reaches before it fades out.', min: 5, max: 200, step: 5,
          get: () => settings.ui.reflection.depth,
          set: (v) => {
            updateUi((ui) => (ui.reflection.depth = v));
            applyReflection();
          },
          show: (v) => `${v} mm`,
        },
      ],
    },
    plate: {
      title: 'Plate',
      isOn: () => settings.ui.view.grid,
      setOn: (on) => {
        updateUi((ui) => (ui.view.grid = on));
        applyPlate();
      },
      sliders: [{
        label: 'See-through', tip: 'How much of the plate you can see through. At 100% only its lines show.', min: 0, max: 1, step: 0.05, reversed: true,
        get: () => settings.ui.plateOpacity,
        set: (v) => {
          updateUi((ui) => (ui.plateOpacity = v));
          applyPlate();
        },
        show: (v) => pct(1 - v),
      }, {
        label: 'Grid lines', tip: 'How strongly the grid lines show. The red and green axis lines always stay.', min: 0, max: 1, step: 0.05,
        get: () => settings.ui.gridLineOpacity,
        set: (v) => {
          updateUi((ui) => (ui.gridLineOpacity = v));
          applyPlate();
        },
        show: pct,
      }, {
        label: 'Number size', tip: "Make the numbers along the plate's axis lines smaller or bigger. 100% is the normal size.", min: 0.5, max: 2, step: 0.05,
        get: () => settings.ui.plateTextScale,
        set: (v) => {
          updateUi((ui) => (ui.plateTextScale = v));
          applyPlate();
        },
        show: pct,
      }],
      toggles: [{
        label: 'Grid values', tip: 'Write distances (in the unit set for the scene) along the X and Y axis lines of the plate.',
        get: () => settings.ui.gridValues,
        set: (on) => {
          updateUi((ui) => (ui.gridValues = on));
          applyPlate();
        },
      }],
    },
  };

  const pop = document.createElement('div');
  pop.id = 'view-popover';
  pop.className = 'view-popover';
  pop.hidden = true;
  document.body.append(pop);
  let openFor: HTMLElement | null = null;

  const close = () => {
    pop.hidden = true;
    openFor = null;
  };

  const open = (btn: HTMLElement, tile: Tile) => {
    const heading = document.createElement('strong');
    heading.textContent = tile.title;
    const rows = tile.sliders.map((s) => {
      const row = document.createElement('label');
      row.className = 'pop-row';
      row.dataset.tipTitle = s.label;
      row.dataset.tip = s.tip;
      const name = document.createElement('span');
      name.className = 'muted';
      name.textContent = s.label;
      const input = document.createElement('input');
      input.type = 'range';
      input.min = String(s.min);
      input.max = String(s.max);
      input.step = String(s.step);
      input.value = String(s.get());
      if (s.reversed) input.style.direction = 'rtl';
      input.setAttribute('aria-label', s.label);
      const out = document.createElement('output');
      out.textContent = s.show(s.get());
      input.addEventListener('input', () => {
        s.set(Number(input.value));
        out.textContent = s.show(s.get());
      });
      row.append(name, input, out);
      return row;
    });
    const switches = (tile.toggles ?? []).map((t) => {
      const row = document.createElement('label');
      row.className = 'pop-row pop-toggle';
      row.dataset.tipTitle = t.label;
      row.dataset.tip = t.tip;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = t.get();
      input.addEventListener('change', () => t.set(input.checked));
      const name = document.createElement('span');
      name.textContent = t.label;
      row.append(input, name);
      return row;
    });
    pop.replaceChildren(heading, ...rows, ...switches);
    pop.hidden = false;
    openFor = btn;
    // Under the tile, kept inside the window (above the tile when there is no room below).
    const r = btn.getBoundingClientRect();
    const p = pop.getBoundingClientRect();
    const gap = 6;
    pop.style.left = `${Math.max(gap, Math.min(r.left, window.innerWidth - p.width - gap))}px`;
    const below = r.bottom + 4;
    pop.style.top = `${below + p.height > window.innerHeight - gap ? Math.max(gap, r.top - p.height - 4) : below}px`;
  };

  for (const btn of document.querySelectorAll<HTMLButtonElement>('[data-pop]')) {
    const tile = tiles[btn.dataset.pop!];
    btn.classList.toggle('active', tile.isOn());
    btn.addEventListener('click', (e) => {
      // The ▾ only opens (or closes) the settings; the rest of the tile switches the feature.
      if ((e.target as Element).closest('.tile-more')) {
        if (openFor === btn) close();
        else open(btn, tile);
        return;
      }
      if (tile.switchedElsewhere) {
        // Let the other handler switch it first, then follow its state.
        setTimeout(() => {
          const on = tile.isOn();
          btn.classList.toggle('active', on);
          if (on) open(btn, tile);
          else close();
        }, 0);
        return;
      }
      const on = !tile.isOn();
      tile.setOn(on);
      btn.classList.toggle('active', on);
      if (on) open(btn, tile);
      else close();
    });
  }
  // The plate and reflection as last left.
  applyReflection();
  applyPlate();
  applyEdges();
  applyRulers();

  document.addEventListener('pointerdown', (e) => {
    if (pop.hidden) return;
    const t = e.target as Node;
    if (!pop.contains(t) && !openFor?.contains(t)) close();
  });
  // (Bubbling on purpose: main.ts's Esc handler runs first and leaves the selection alone while this is open.)
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close();
  });
  window.addEventListener('resize', close);
  document.querySelector('#sidebar')?.addEventListener('scroll', close);
}
