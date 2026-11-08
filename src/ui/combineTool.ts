import * as THREE from 'three';
import type { RoleOp } from '../geometry/booleans';
import type { Piece } from '../geometry/cut';
import { runOp } from '../geometry/workerClient';
import type { SceneDocument, SceneObject } from '../scene/document';
import type { Viewport } from '../scene/viewport';
import { previewMesh, type FeatureBar } from './featureBar';
import { hideHint, showHint } from './hint';
import { viewClicks } from './interaction';

type Role = 'target' | 'tool';

const WORDS: Record<RoleOp, { title: string; targets: string; tools: string; steps: Record<Role, string> }> = {
  subtract: {
    title: 'Subtract',
    targets: '1 · Objects to cut',
    tools: '2 · Cutters',
    steps: {
      target: 'Subtract, step 1: click the objects to cut into (green). Then press "2 · Cutters".',
      tool: 'Subtract, step 2: click the objects to cut away (red). Click again to unmark. Apply when the preview looks right.',
    },
  },
  intersect: {
    title: 'Intersect',
    targets: '1 · Objects to trim',
    tools: '2 · Shapes to keep',
    steps: {
      target: 'Intersect, step 1: click the objects to trim (green). Then press "2 · Shapes to keep".',
      tool: 'Intersect, step 2: click the shapes whose inside is kept (red). Click again to unmark. Apply when the preview looks right.',
    },
  },
};

const targetLook = new THREE.MeshBasicMaterial({ color: 0x30a46c, wireframe: true, transparent: true, opacity: 0.45, depthWrite: false });
const toolFill = new THREE.MeshBasicMaterial({
  color: 0xe5484d, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide,
});
const toolWire = new THREE.MeshBasicMaterial({ color: 0xe5484d, wireframe: true, transparent: true, opacity: 0.5, depthWrite: false });

/**
 * Subtract and Intersect in steps: mark the objects to change (green), then
 * the objects that act on them (red). Each marked object is cut by all the
 * red ones at once, so one cutter can go through several objects. A live
 * preview shows the result before Apply.
 */
export class CombineTool {
  private readonly overlay = new THREE.Group();

  constructor(
    private readonly viewport: Viewport,
    private readonly doc: SceneDocument,
    private readonly bar: FeatureBar,
    private readonly toast: (msg: string) => void,
  ) {
    this.overlay.raycast = () => {};
    viewport.scene.add(this.overlay);
  }

  start(op: RoleOp): void {
    const words = WORDS[op];
    // Always start from nothing: the selection is cleared and both groups are empty.
    this.doc.setSelection([]);
    let targets: SceneObject[] = [];
    let tools: SceneObject[] = [];
    let role: Role = 'target';
    const hidden = new Set<SceneObject>();

    const redraw = () => {
      for (const c of [...this.overlay.children]) this.overlay.remove(c);
      // Marked objects are drawn by their overlay instead (unmarked ones stay normal).
      for (const o of this.doc.objects) {
        const marked = targets.includes(o) || tools.includes(o);
        o.mesh.visible = !marked;
        if (marked) hidden.add(o);
      }
      const ghost = (o: SceneObject, material: THREE.Material) => {
        const m = new THREE.Mesh(o.mesh.geometry, material);
        o.mesh.updateMatrixWorld();
        m.matrixAutoUpdate = false;
        m.matrix.copy(o.mesh.matrixWorld);
        m.renderOrder = 2;
        this.overlay.add(m);
      };
      for (const o of targets) ghost(o, targetLook);
      for (const o of tools) {
        ghost(o, toolFill);
        ghost(o, toolWire);
      }
      for (const b of document.querySelectorAll<HTMLElement>('#feature-bar [data-key="targets"], #feature-bar [data-key="tools"]')) {
        b.classList.toggle('active', b.dataset.key === (role === 'target' ? 'targets' : 'tools'));
        b.textContent = b.dataset.key === 'targets'
          ? `${words.targets} (${targets.length})`
          : `${words.tools} (${tools.length})`;
      }
      showHint('feature', words.steps[role]);
      this.viewport.invalidate();
    };
    const setRole = (r: Role) => {
      role = r;
      redraw();
    };
    const changed = () => {
      redraw();
      this.bar.refresh(0);
    };

    const onDocChange = () => {
      // An object being worked on was deleted (or replaced by undo): stop.
      if ([...targets, ...tools].some((o) => !this.doc.objects.includes(o))) {
        this.bar.close();
        this.toast(`${words.title} was cancelled: an object it used was deleted or changed`);
      }
    };
    this.doc.addEventListener('change', onDocChange);

    this.bar.open<(Piece | null)[]>({
      title: words.title,
      hint: words.steps[role],
      fields: [
        { key: 'targets', label: words.targets, type: 'button', value: '', onClick: () => setRole('target'),
          tip: op === 'subtract' ? 'Then click the objects that should get holes or cuts.' : 'Then click the objects that should be trimmed.' },
        { key: 'tools', label: words.tools, type: 'button', value: '', onClick: () => setRole('tool'),
          tip: op === 'subtract' ? 'Then click the objects to cut away. They disappear on Apply.' : 'Then click the shapes; only what lies inside them is kept. They disappear on Apply.' },
        { key: 'swap', label: 'Swap', type: 'button', value: '', tip: 'Swap the two groups.',
          onClick: () => {
            [targets, tools] = [tools, targets];
            changed();
          } },
      ],
      compute: async () => {
        if (targets.length === 0 || tools.length === 0) return null;
        return runOp('combine', {
          op, targets: targets.map((o) => this.doc.placed(o)), tools: tools.map((o) => this.doc.placed(o)),
        });
      },
      show: (pieces) => pieces.filter((p) => p !== null).map((p) => previewMesh(p.mesh, p.center)),
      apply: (pieces) => this.finish(op, targets, tools, pieces),
      onClose: () => {
        this.doc.removeEventListener('change', onDocChange);
        viewClicks.onClick = null;
        for (const o of hidden) o.mesh.visible = true;
        for (const c of [...this.overlay.children]) this.overlay.remove(c);
        hideHint('feature');
        this.viewport.invalidate();
      },
    });

    viewClicks.onClick = (e) => {
      const hit = this.viewport.pick(e.clientX, e.clientY);
      const obj = hit ? this.doc.byMesh(hit) : undefined;
      if (!obj) return;
      // Clicking an object puts it in the current group, or takes it out again.
      const mine = role === 'target' ? targets : tools;
      const other = role === 'target' ? tools : targets;
      const members = this.doc.withGroups([obj]);
      const inMine = mine.includes(obj);
      for (const m of members) {
        const i = other.indexOf(m);
        if (i >= 0) other.splice(i, 1);
        const j = mine.indexOf(m);
        if (inMine && j >= 0) mine.splice(j, 1);
        else if (!inMine && j < 0) mine.push(m);
      }
      changed();
    };
    redraw();
  }

  private finish(op: RoleOp, targets: SceneObject[], tools: SceneObject[], pieces: (Piece | null)[]): void {
    const all = [...targets, ...tools];
    if (!all.every((o) => this.doc.objects.includes(o))) return;
    if (pieces.every((p) => p === null)) {
      return this.toast(op === 'subtract' ? 'Nothing would be left: the cutters cover the whole object' : 'Nothing is left: the objects do not overlap');
    }
    {
      this.doc.checkpoint();
      const kept: SceneObject[] = [];
      const emptied: SceneObject[] = [];
      targets.forEach((t, i) => {
        const p = pieces[i];
        if (!p) return emptied.push(t);
        this.doc.setData(t, p.mesh);
        // A new shape gets a new name: half a sphere shouldn't stay called "Cube 1".
        t.name = this.doc.uniqueName('Object');
        t.mesh.position.set(...p.center);
        t.mesh.quaternion.identity();
        t.mesh.scale.set(1, 1, 1);
        kept.push(t);
      });
      this.doc.remove([...tools, ...emptied]);
      this.doc.setSelection(kept);
      this.doc.emit('transform');
      if (emptied.length) this.toast(`${emptied.map((o) => o.name).join(', ')}: nothing was left, so ${emptied.length > 1 ? 'they were' : 'it was'} removed`);
    }
  }
}
