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
type Heavy = <T>(objs: SceneObject[], compute: () => Promise<T>, apply: (r: T) => void) => Promise<void>;

/** The Intersect tool's words; `joiner` sits between the two buttons, so the bar reads as a sentence. */
const WORDS = {
    title: 'Intersect',
    targets: '1 · Objects A',
    tools: '2 · Objects B',
    joiner: 'with',
    steps: {
      target: 'Intersect, step 1: click Objects A (green). Each keeps only its part that lies inside Objects B, in its own colour. Then press "2 · Objects B".',
      tool: 'Intersect, step 2: click Objects B (red), the shapes Objects A are trimmed to. Click again to unmark. Apply when the preview looks right.',
    },
    tips: {
      target: 'Then click Objects A: each keeps only its part inside Objects B, in its own colour (separate pieces become separate objects).',
      tool: 'Then click Objects B: together they form the shape Objects A are trimmed to. They are removed on Apply.',
    },
};

const targetLook = new THREE.MeshBasicMaterial({ color: 0x30a46c, wireframe: true, transparent: true, opacity: 0.45, depthWrite: false });
const toolFill = new THREE.MeshBasicMaterial({
  color: 0xe5484d, transparent: true, opacity: 0.22, depthWrite: false, side: THREE.DoubleSide,
});
const toolWire = new THREE.MeshBasicMaterial({ color: 0xe5484d, wireframe: true, transparent: true, opacity: 0.5, depthWrite: false });

/**
 * Subtract in one step: the selected objects are cut out of every other
 * object they go into, then removed.
 *
 * Intersect in steps: mark the objects to keep a part of (green), then the
 * shapes they are trimmed to (red). Each green object is trimmed by all the
 * red ones at once. A live preview shows the result before Apply.
 */
export class CombineTool {
  private readonly overlay = new THREE.Group();

  constructor(
    private readonly viewport: Viewport,
    private readonly doc: SceneDocument,
    private readonly bar: FeatureBar,
    private readonly toast: (msg: string) => void,
    private readonly heavy: Heavy,
  ) {
    this.overlay.raycast = () => {};
    viewport.scene.add(this.overlay);
  }

  /**
   * Cut the selected objects out of every other object (or group part) they
   * go into, then remove them. No tool bar: one step, and Undo brings it all back.
   */
  subtract(): void {
    const tools = [...this.doc.selection];
    if (tools.length === 0) return this.toast('Select the objects to cut away');
    const boxes = tools.map((t) => this.doc.worldBox([t]));
    const targets = this.doc.objects.filter((o) => !o.hidden && !tools.includes(o)
      && boxes.some((b) => b.intersectsBox(this.doc.worldBox([o]))));
    if (targets.length === 0) return this.toast("The selected objects don't go into any other object");
    const placed = (objs: SceneObject[]) => objs.map((o) => this.doc.placed(o));
    void this.heavy([...targets, ...tools], () => runOp('combine', { op: 'subtract', targets: placed(targets), tools: placed(tools) }),
      (pieces) => this.finish('subtract', targets, tools, pieces));
  }

  intersect(): void {
    const op = 'intersect';
    const words = WORDS;
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
        o.mesh.visible = !marked && !o.hidden;
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

    this.bar.open<(Piece[] | null)[]>({
      title: words.title,
      hint: words.steps[role],
      fields: [
        { key: 'targets', label: words.targets, type: 'button', value: '', onClick: () => setRole('target'),
          tip: words.tips.target },

        { key: 'tools', label: words.tools, type: 'button', value: '', onClick: () => setRole('tool'),
          tip: words.tips.tool },

        { key: 'swap', label: 'Swap', type: 'button', value: '', tip: 'Swap the two groups.',
          onClick: () => {
            [targets, tools] = [tools, targets];
            changed();
          } },
      ],
      compute: async (_v, signal) => {
        if (targets.length === 0 || tools.length === 0) return null;
        return runOp('combine', {
          op, targets: targets.map((o) => this.doc.placed(o)), tools: tools.map((o) => this.doc.placed(o)),
        }, { signal });
      },
      show: (pieces) => pieces.flatMap((p) => p ?? []).map((p) => previewMesh(p.mesh, p.center)),
      apply: (pieces) => this.finish(op, targets, tools, pieces),
      onClose: () => {
        this.doc.removeEventListener('change', onDocChange);
        viewClicks.onClick = null;
        for (const o of hidden) o.mesh.visible = !o.hidden;
        for (const c of [...this.overlay.children]) this.overlay.remove(c);
        hideHint('feature');
        this.viewport.invalidate();
      },
    });
    if (words.joiner) {
      const joiner = document.createElement('span');
      joiner.className = 'muted';
      joiner.textContent = words.joiner;
      document.querySelector('#feature-bar [data-key="tools"]')!.before(joiner);
    }

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

  /**
   * Each target becomes what is left of it (targets the tools didn't touch,
   * null, stay as they are). Where that is several separate
   * pieces (a cut through the middle), the largest stays the target and each
   * other piece becomes its own object, so every object is one solid.
   */
  private finish(op: RoleOp, targets: SceneObject[], tools: SceneObject[], pieces: (Piece[] | null)[]): void {
    const all = [...targets, ...tools];
    if (!all.every((o) => this.doc.objects.includes(o))) return;
    if (pieces.every((p) => p === null)) return this.toast("The selected objects don't go into any other object");
    if (pieces.every((p) => p !== null && p.length === 0)) {
      return this.toast(op === 'subtract' ? 'Nothing would be left: the cutters cover the whole object' : 'Nothing is left: the objects do not overlap');
    }
    const { emptied, split } = this.doc.transact(() => this.replaceTargets(targets, tools, pieces));
    const notes: string[] = [];
    if (split) notes.push(`${split} more separate piece${split > 1 ? 's' : ''} became ${split > 1 ? 'their own objects' : 'its own object'}`);
    if (emptied.length) notes.push(`${emptied.map((o) => o.name).join(', ')}: nothing was left, so ${emptied.length > 1 ? 'they were' : 'it was'} removed`);
    if (notes.length) this.toast(notes.join('. '));
  }

  /** The changes of finish, as one step: returns the emptied targets and how many extra pieces became objects. */
  private replaceTargets(targets: SceneObject[], tools: SceneObject[], pieces: (Piece[] | null)[]): { emptied: SceneObject[]; split: number } {
    const kept: SceneObject[] = [];
    const emptied: SceneObject[] = [];
    let split = 0;
    targets.forEach((t, i) => {
      const result = pieces[i];
      if (result === null) return; // not touched: stays exactly as it was
      const [first, ...rest] = result;
      if (!first) return emptied.push(t);
      this.doc.replaceWithPiece(t, first);
      // A new shape gets a new name: half a sphere shouldn't stay called "Cube 1".
      t.name = this.doc.uniqueName('Object');
      kept.push(t);
      for (const p of rest) {
        const extra = this.doc.add('Object', p.mesh, t.color);
        extra.mesh.position.set(...p.center);
        kept.push(extra);
        split++;
      }
    });
    this.doc.remove([...tools, ...emptied]);
    this.doc.setSelection(kept);
    this.doc.emit('transform');
    return { emptied, split };
  }
}
