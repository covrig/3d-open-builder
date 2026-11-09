// Automated checks in real Chrome, Edge and Firefox (installed copies, driven by
// puppeteer-core; Firefox over WebDriver BiDi). Builds the app, serves dist/,
// runs each check and prints a pass/fail table. Usage: npm run check:browsers
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import puppeteer from 'puppeteer-core';

const PORT = 4173;
const URL = `http://localhost:${PORT}/`;
const SHOTS = 'test-results';
mkdirSync(SHOTS, { recursive: true });

const BROWSERS = [
  { name: 'Chrome', browser: 'chrome', path: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' },
  { name: 'Edge', browser: 'chrome', path: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe' },
  { name: 'Firefox', browser: 'firefox', path: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe' },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Optional filters: ONLY="Loads,Split" runs the checks whose names start so; BROWSERS="Chrome". */
const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const ONLY_BROWSERS = process.env.BROWSERS ? process.env.BROWSERS.split(',') : null;

function launch(b, extra = {}) {
  return puppeteer.launch({
    browser: b.browser,
    executablePath: b.path,
    headless: true,
    // Software WebGL so the 3D view renders without a GPU in headless mode.
    args: b.browser === 'chrome' ? ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : [],
    // Headless Firefox blocks WebGL 2 on some systems; allow it for the test.
    extraPrefsFirefox: { 'webgl.force-enabled': true, 'webgl.disabled': false, ...(extra.extraPrefsFirefox ?? {}) },
    ...extra,
  });
}

async function visible(page, selector) {
  return page.evaluate((s) => {
    const el = document.querySelector(s);
    if (!el || el.hidden) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).display !== 'none';
  }, selector);
}

async function clickSel(page, selector) {
  await page.waitForSelector(selector, { visible: true, timeout: 5000 });
  await page.click(selector);
}

/** In the Subtract/Intersect tool: press a group's button, then click each object (its top) in the view. */
async function markInView(page, role, ids) {
  await clickSel(page, `#feature-bar [data-key="${role}"]`);
  for (const id of ids) {
    const at = await page.evaluate((id) => {
      const { doc, viewport } = window.app;
      const o = doc.objects.find((x) => x.id === id);
      const b = doc.worldBox([o]);
      const c = b.getCenter(o.mesh.position.clone());
      c.z = b.max.z - 0.5;
      const p = viewport.project(c);
      const r = viewport.element.getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    }, id);
    await page.mouse.click(at.x, at.y);
  }
}

/** Press Apply on the feature bar once its preview is ready (Apply does nothing before that). */
async function applyFeature(page) {
  for (let i = 0; i < 40; i++) {
    await sleep(250);
    if (!(await visible(page, '#feature-bar'))) return;
    await page.click('#feature-bar [data-feature="apply"]');
  }
  throw new Error('the preview never became ready');
}

async function runChecks(b) {
  const results = [];
  const check = async (name, fn) => {
    if (ONLY && !ONLY.some((o) => name.startsWith(o))) return;
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail: detail ?? '' });
    } catch (err) {
      results.push({ name, ok: false, detail: String(err?.message ?? err).split('\n')[0] });
    }
  };

  const browser = await launch(b);
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  await page.setViewport({ width: 1400, height: 900 });

  await check('Loads without errors', async () => {
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForFunction(() => window.app !== undefined, { timeout: 30000 });
    await sleep(500);
    if (errors.length) throw new Error(errors.join(' | '));
    const webgl = await page.evaluate(() => !!window.app.viewport.renderer.getContext());
    return webgl ? 'WebGL ok' : 'no WebGL';
  });

  await check('Fresh start shows a torus', async () => {
    const r = await page.evaluate(() => {
      const objs = window.app.doc.objects;
      const box = objs.length ? window.app.doc.worldBox(objs) : null;
      return { names: objs.map((o) => o.name), minZ: box?.min.z, cx: box ? (box.min.x + box.max.x) / 2 : null };
    });
    if (r.names.length !== 1 || !r.names[0].startsWith('Torus')) throw new Error(`objects: ${JSON.stringify(r.names)}`);
    if (Math.abs(r.minZ) > 0.2 || Math.abs(r.cx) > 0.2) throw new Error(`not centred on the plate (x ${r.cx}, bottom ${r.minZ})`);
    // Single-key shortcuts start off: D does nothing.
    await page.evaluate(() => window.app.doc.setSelection(window.app.doc.objects));
    await page.mouse.click(5, 300);
    await page.evaluate(() => window.app.doc.setSelection(window.app.doc.objects));
    await page.keyboard.press('d');
    const afterD = await page.evaluate(() => window.app.doc.objects.length);
    if (afterD !== 1) throw new Error('D duplicated although single-key shortcuts start off');
    // The remaining checks start from an empty plate.
    await page.evaluate(() => window.app.doc.clear());
    return 'one torus, centred, on the plate; single-key shortcuts off';
  });

  await check('Add object from menu', async () => {
    await clickSel(page, '[data-menu="add-menu"]');
    await clickSel(page, '[data-insert="cube"]');
    const n = await page.evaluate(() => window.app.doc.objects.length);
    if (n !== 1) throw new Error(`expected 1 object, got ${n}`);
  });

  await check('Object row hover buttons', async () => {
    await page.hover('.items li');
    await sleep(100);
    const shown = await page.$$eval('.items li .row-action', (els) => els.map((e) => getComputedStyle(e).display));
    if (shown.length !== 2 || shown.some((d) => d === 'none')) throw new Error(`row buttons: ${JSON.stringify(shown)}`);
    await page.hover('.items li .row-action');
    await sleep(400);
    if (!(await visible(page, '#tooltip'))) throw new Error('row button tooltip did not appear');
    return 'Duplicate + Delete shown, tooltip ok';
  });

  await check('Tooltip on toolbar button', async () => {
    await page.hover('[data-action="undo"]');
    await sleep(400);
    const text = await page.$eval('#tooltip', (e) => (e.hidden ? '' : e.textContent));
    if (!text.includes('Undo')) throw new Error(`tooltip: "${text}"`);
  });

  await check('Persistent hint while measuring', async () => {
    await clickSel(page, '[data-measure="distance"]');
    await sleep(5000); // longer than a normal message stays
    if (!(await visible(page, '#op-hint'))) throw new Error('hint disappeared while the tool was active');
    await page.keyboard.press('Escape');
    await sleep(100);
    if (await visible(page, '#op-hint')) throw new Error('hint stayed after leaving the tool');
    return 'stayed 5 s, gone after Esc';
  });

  await check('Shortcuts overlay from File menu', async () => {
    await clickSel(page, '[data-menu="file-menu"]');
    await clickSel(page, '#file-menu [data-action="shortcuts"]');
    if (!(await visible(page, '#shortcuts-panel'))) throw new Error('panel not shown');
    await clickSel(page, '#shortcuts-panel [data-action="shortcuts"]');
    if (await visible(page, '#shortcuts-panel')) throw new Error('panel did not hide');
  });

  await check('Smooth drag far from the origin (no jitter)', async () => {
    await page.evaluate(() => window.app.doc.setSelection(window.app.doc.objects));
    await sleep(200);
    // The first handle in Move mode is the X arrow.
    const box = await page.$eval('svg.gizmo .handle', (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    const xs = [];
    await page.mouse.move(box.x, box.y);
    await page.mouse.down();
    for (let i = 1; i <= 25; i++) {
      await page.mouse.move(box.x + i * 18, box.y - i * 2);
      await sleep(30);
      xs.push(await page.evaluate(() => window.app.doc.objects[0].mesh.position.x));
    }
    await page.mouse.up();
    let reversals = 0;
    for (let i = 1; i < xs.length; i++) if (xs[i] < xs[i - 1] - 1e-6) reversals++;
    if (reversals) throw new Error(`position went backwards ${reversals} times: ${xs.map((v) => v.toFixed(0)).join(',')}`);
    if (xs[xs.length - 1] < 50) throw new Error(`moved only to x=${xs[xs.length - 1].toFixed(1)}`);
    return `moved to x=${xs[xs.length - 1].toFixed(0)} mm, steady`;
  });

  await check('Subtract in steps runs in the worker', async () => {
    await page.evaluate(() => {
      const { doc, viewport } = window.app;
      document.querySelector('[data-insert="sphere"]').click();
      const [c, s] = doc.objects;
      s.mesh.position.copy(c.mesh.position).add({ x: 30, y: 0, z: 0 });
      doc.emit('transform');
      viewport.fit(doc.worldBox(doc.objects));
      doc.setSelection([c, s]);
    });
    await page.click('[data-boolean="difference"]');
    if (!(await visible(page, '#feature-bar'))) throw new Error('subtract bar did not open');
    const selected = await page.evaluate(() => window.app.doc.selection.length);
    if (selected !== 0) throw new Error('the selection was not cleared');
    const [c, s] = await page.evaluate(() => window.app.doc.objects.map((o) => o.id));
    await markInView(page, 'targets', [c]);
    await markInView(page, 'tools', [s]);
    await applyFeature(page);
    await page.waitForFunction(() => window.app.doc.objects.length === 1, { timeout: 15000 });
    return 'started empty; cube minus sphere = 1 object';
  });
  await page.screenshot({ path: `${SHOTS}/${b.name}-landscape.png` });

  await check('Autosave and restore after reload', async () => {
    await page.evaluate(() => window.app.autosave.saveNow());
    await page.reload({ waitUntil: 'load' });
    await page.waitForSelector('#restore-dialog[open]', { timeout: 15000 });
    await page.click('#restore-dialog button[value="restore"]');
    await page.waitForFunction(() => window.app.doc.objects.length === 1, { timeout: 5000 });
    return 'restored 1 object';
  });

  await check('Error recovery dialog', async () => {
    await page.evaluate(() => setTimeout(() => { throw new Error('test failure'); }));
    await page.waitForSelector('#error-dialog[open]', { timeout: 5000 });
    await page.click('#error-dialog button[value="keep"]');
    errors.length = 0;
    return 'shown, closed with Keep working';
  });

  // --- Checks for the tools ----------------------------------------------------

  const reset = () => page.evaluate(() => {
    window.app.doc.clear();
    window.app.doc.setSelection([]);
  });
  /** Add a 40 mm cube centred at (x, y, z), scaled by s; returns its id. */
  const addCube = (x, y, z, s = [1, 1, 1]) => page.evaluate(([x, y, z, s]) => {
    document.querySelector('[data-insert="cube"]').click();
    const o = window.app.doc.objects.at(-1);
    o.mesh.position.set(x, y, z);
    o.mesh.scale.set(...s);
    window.app.doc.emit('transform');
    return o.id;
  }, [x, y, z, s]);
  const select = (ids) => page.evaluate((ids) => {
    const { doc } = window.app;
    doc.setSelection(ids.map((id) => doc.objects.find((o) => o.id === id)));
  }, ids);
  const boxOf = (id) => page.evaluate((id) => {
    const { doc } = window.app;
    const b = doc.worldBox([doc.objects.find((o) => o.id === id)]);
    return { min: b.min.toArray(), max: b.max.toArray() };
  }, id);
  const near = (a, b, tol = 0.2) => Math.abs(a - b) <= tol;
  /** Switch single-key shortcuts on or off (Settings; off by default). */
  const shortcuts = (on) => page.evaluate((on) => {
    const i = document.querySelector('input[name="shortcuts"]');
    i.checked = on;
    i.dispatchEvent(new Event('change'));
  }, on);

  await check('Subtract: one cutter through two objects', async () => {
    await reset();
    const a = await addCube(-30, 0, 20);
    const bId = await addCube(30, 0, 20);
    const bar = await addCube(0, 15, 37, [3, 0.2, 0.2]); // 120 × 8 × 8 mm bar through both, sticking out of their tops
    await page.evaluate(() => window.app.viewport.fit(window.app.doc.worldBox(window.app.doc.objects)));
    await page.click('[data-boolean="difference"]');
    await markInView(page, 'targets', [a, bId]);
    await markInView(page, 'tools', [bar]);
    const label = await page.$eval('#feature-bar [data-key="targets"]', (e) => e.textContent);
    if (!label.includes('(2)')) throw new Error(`objects not marked: "${label}"`);
    await applyFeature(page);
    await page.waitForFunction(() => window.app.doc.objects.length === 2, { timeout: 15000 });
    const tris = await page.evaluate(() => window.app.doc.objects.map((o) => o.data.indices.length / 3));
    if (tris.some((t) => t <= 12)) throw new Error(`an object was not cut (triangles ${tris})`);
    return `both cubes cut (${tris.join(' / ')} triangles), cutter removed`;
  });

  await check('Intersect with shapes that do not overlap each other', async () => {
    await reset();
    const a = await addCube(0, 0, 20);
    const s1 = await addCube(-20, 0, 40, [0.25, 0.25, 0.25]);
    const s2 = await addCube(20, 0, 40, [0.25, 0.25, 0.25]);
    await page.evaluate(() => window.app.viewport.fit(window.app.doc.worldBox(window.app.doc.objects)));
    await page.click('[data-boolean="intersection"]');
    await markInView(page, 'targets', [a]);
    await markInView(page, 'tools', [s1, s2]);
    await applyFeature(page);
    // The two ends left (5 mm of the cube inside each 10 mm shape) are separate pieces: two objects.
    await page.waitForFunction(() => window.app.doc.objects.length === 2, { timeout: 15000 });
    const sizes = await page.evaluate(() => window.app.doc.objects.map((o) => {
      const b = window.app.doc.worldBox([o]);
      return [b.max.x - b.min.x, b.max.y - b.min.y].map((v) => Math.round(v * 10) / 10);
    }));
    if (!sizes.every(([x, y]) => near(x, 5) && near(y, 10))) throw new Error(`unexpected sizes ${JSON.stringify(sizes)}`);
    const names = await page.evaluate(() => window.app.doc.objects.map((o) => o.name));
    if (!names.every((n) => /^Object \d+$/.test(n))) throw new Error(`names ${names}`);
    return `kept both ends of the cube as two objects (${names.join(', ')})`;
  });

  await check('Extrude down to the plate', async () => {
    await reset();
    const top = await addCube(30, 0, 100, [1, 1, 0.25]); // 40 × 40 × 10, floating
    await select([top]);
    await page.evaluate(() => (window.meshBefore = window.app.doc.objects.at(-1).data));
    await page.click('[data-action="extrude-down"]');
    // The plane starts just above the bottom; Apply once the preview is ready.
    await applyFeature(page);
    await page.waitForFunction(() => window.app.doc.objects.at(-1).data !== window.meshBefore, { timeout: 15000 });
    const box = await boxOf(top);
    if (!near(box.min[2], 0)) throw new Error(`bottom at ${box.min[2].toFixed(2)}`);
    return 'reaches the plate';
  });
  await check('One tool at a time; Esc closes it', async () => {
    await reset();
    const a = await addCube(0, 0, 20);
    await select([a]);
    await page.click('[data-action="split"]');
    if (!(await visible(page, '#split-bar'))) throw new Error('split did not open');
    const keepBoth = await page.$eval('[data-split-keep="both"]', (e) => e.classList.contains('active'));
    if (!keepBoth) throw new Error('split does not default to keeping both');
    // Other tools are locked while Split is open; Esc ends it, then Shell opens.
    await page.click('.toolbar [data-menu="modify-menu"]');
    if (!(await visible(page, '#split-bar'))) throw new Error('split closed when More was clicked');
    if (await visible(page, '#modify-menu')) throw new Error('More opened during Split');
    await page.keyboard.press('Escape');
    if (await visible(page, '#split-bar')) throw new Error('Esc did not close split');
    await clickSel(page, '[data-menu="modify-menu"]');
    await clickSel(page, '[data-modify="shell"]');
    if (!(await visible(page, '#feature-bar'))) throw new Error('shell did not open');
    await page.keyboard.press('Escape');
    if (await visible(page, '#feature-bar')) throw new Error('Esc did not close shell');
    return 'More refused during Split; after Esc, Shell opened and Esc closed it';
  });

  await check('Split shows the part that will go', async () => {
    const a = await page.evaluate(() => window.app.doc.objects[0].id);
    await select([a]);
    await page.click('[data-action="split"]');
    await page.click('[data-split-keep="positive"]');
    const clipped = await page.evaluate(() => window.app.doc.objects[0].mesh.material.clippingPlanes?.length ?? 0);
    if (clipped !== 1) throw new Error('object is not cut at the plane in the preview');
    await page.screenshot({ path: `${SHOTS}/${b.name}-split-preview.png` });
    await page.keyboard.press('Escape');
    const after = await page.evaluate(() => window.app.doc.objects[0].mesh.material.clippingPlanes);
    if (after) throw new Error('preview cut stayed after closing');
    return 'removed side drawn as a ghost';
  });

  await check('Cut and Delete are refused inside a tool', async () => {
    const id = await page.evaluate(() => window.app.doc.objects[0].id);
    await select([id]);
    await clickSel(page, '[data-menu="modify-menu"]');
    await clickSel(page, '[data-modify="shell"]');
    if (!(await visible(page, '#feature-bar'))) throw new Error('Shell did not open');
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.down('Control');
    await page.keyboard.press('x');
    await page.keyboard.up('Control');
    await page.keyboard.press('Delete');
    await sleep(100);
    const r = await page.evaluate(() => ({ n: window.app.doc.objects.length, msg: document.querySelector('#toast').textContent }));
    const open = await visible(page, '#feature-bar');
    await page.keyboard.press('Escape');
    if (!open) throw new Error('Shell closed');
    if (r.n !== 1) throw new Error('the object was removed');
    if (!r.msg.startsWith('Finish or cancel')) throw new Error(`message: "${r.msg}"`);
    return 'Shell stays open, object kept, message shown';
  });
  await check('Measurements go with a deleted object (and come back on undo)', async () => {
    await reset();
    const a = await addCube(0, 0, 20);
    const counts = await page.evaluate((id) => {
      const { doc } = window.app;
      const o = doc.objects.find((x) => x.id === id);
      doc.setMeasurements([{ kind: 'distance', points: [{ objectId: id, local: o.mesh.position.clone() }, { local: o.mesh.position.clone() }] }]);
      doc.checkpoint();
      doc.remove([o]);
      const afterDelete = doc.measurements.length;
      doc.undo();
      return [afterDelete, doc.measurements.length];
    }, a);
    if (counts[0] !== 0 || counts[1] !== 1) throw new Error(`measurements ${counts}`);
    return 'cleared, restored by undo';
  });

  await check('Reference picture: undo; Remove waits for Calibrate', async () => {
    await reset();
    await page.evaluate(async () => {
      const c = document.createElement('canvas');
      c.width = 64;
      c.height = 48;
      c.getContext('2d').fillRect(0, 0, 20, 20);
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const dt = new DataTransfer();
      dt.items.add(new File([blob], 'ref.png', { type: 'image/png' }));
      const input = document.querySelector('#reference-input');
      input.files = dt.files;
      input.dispatchEvent(new Event('change'));
    });
    await page.waitForSelector('#reference-panel:not([hidden])', { timeout: 5000 });
    await page.click('[data-action="ref-calibrate"]');
    if (!(await visible(page, '#feature-bar'))) throw new Error('calibrate did not open');
    // Removing the picture is refused while Calibrate is open; after Esc it works.
    await page.click('[data-action="ref-remove"]');
    if (!(await visible(page, '#reference-panel'))) throw new Error('picture removed during Calibrate');
    await page.keyboard.press('Escape');
    if (await visible(page, '#feature-bar')) throw new Error('Esc did not close Calibrate');
    await page.click('[data-action="ref-remove"]');
    if (await visible(page, '#reference-panel')) throw new Error('picture panel still shown');
    await page.click('[data-action="undo"]');
    await page.waitForSelector('#reference-panel:not([hidden])', { timeout: 5000 });
    await page.click('[data-action="redo"]');
    if (await visible(page, '#reference-panel')) throw new Error('redo did not remove it again');
    return 'undo brings it back, redo removes it';
  });

  await check('Unsupported file gives a message', async () => {
    await page.evaluate(() => window.app.openFiles([new File(['hello'], 'notes.txt')]));
    const msg = await page.$eval('#toast', (e) => (e.hidden ? '' : e.textContent));
    if (!msg.includes('not supported')) throw new Error(`message: "${msg}"`);
    return msg;
  });

  await check('Camera cursors and far zoom depth range', async () => {
    await reset();
    await addCube(0, 0, 20);
    await page.evaluate(() => window.app.doc.setSelection([]));
    const r = await page.$eval('#viewport', (e) => e.getBoundingClientRect().toJSON());
    const x = r.left + r.width * 0.8, y = r.top + r.height * 0.75;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 40, y + 5, { steps: 4 });
    const during = await page.$eval('#viewport', (e) => e.className);
    await page.mouse.up();
    const after = await page.$eval('#viewport', (e) => e.className);
    if (!during.includes('orbiting')) throw new Error(`no turning cursor (class "${during}")`);
    if (after.includes('orbiting')) throw new Error('cursor stayed after release');
    const nearPlane = await page.evaluate(async () => {
      const { viewport } = window.app;
      viewport.camera.position.sub(viewport.orbit.target).multiplyScalar(30).add(viewport.orbit.target);
      viewport.orbit.update();
      viewport.invalidate();
      await new Promise((r) => setTimeout(r, 200));
      const n = viewport.camera.near;
      viewport.fit();
      return n;
    });
    if (nearPlane <= 1) throw new Error(`near plane stays at ${nearPlane}`);
    return `orbit cursor ok; near plane ${nearPlane.toFixed(1)} mm when zoomed out`;
  });

  await check('Rotate drag', async () => {
    const id = await page.evaluate(() => window.app.doc.objects[0].id);
    await select([id]);
    await page.click('[data-mode="rotate"]');
    await sleep(200);
    const h = await page.$eval('svg.gizmo .handle', (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    const q0 = await page.evaluate(() => window.app.doc.objects[0].mesh.quaternion.toArray());
    await page.mouse.move(h.x, h.y);
    await page.mouse.down();
    const t0 = Date.now();
    for (let i = 1; i <= 20; i++) await page.mouse.move(h.x + i * 6, h.y + i * 4);
    const ms = (Date.now() - t0) / 20;
    await page.mouse.up();
    const q1 = await page.evaluate(() => window.app.doc.objects[0].mesh.quaternion.toArray());
    await page.click('[data-mode="translate"]');
    if (q0.every((v, i) => Math.abs(v - q1[i]) < 1e-6)) throw new Error('object did not turn');
    // The same drag with the Move arrow, for comparison (includes drawing the view).
    await sleep(200);
    const m = await page.$eval('svg.gizmo .handle', (e) => {
      const r = e.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    });
    await page.mouse.move(m.x, m.y);
    await page.mouse.down();
    const t1 = Date.now();
    for (let i = 1; i <= 20; i++) await page.mouse.move(m.x + i * 6, m.y);
    const moveMs = (Date.now() - t1) / 20;
    await page.mouse.up();
    return `turned; ${ms.toFixed(1)} ms per mouse move (moving: ${moveMs.toFixed(1)} ms)`;
  });

  await check('Panel closes and opens from the view corner', async () => {
    await clickSel(page, '#view-corner [data-action="close-panel"]');
    await sleep(300);
    if (await visible(page, '#sidebar')) throw new Error('panel still shown after >');
    if (!(await visible(page, '#view-corner [data-action="open-panel"]'))) throw new Error('Panel button not shown');
    await clickSel(page, '#view-corner [data-action="open-panel"]');
    await sleep(300);
    if (!(await visible(page, '#sidebar'))) throw new Error('panel did not come back');
    if (await visible(page, '#view-corner [data-action="open-panel"]')) throw new Error('Panel button still shown while open');
    return 'closed with >, reopened with Panel';
  });

  await check('Home view (H) returns to the start angle', async () => {
    await page.evaluate(() => {
      const i = document.querySelector('input[name="shortcuts"]');
      i.checked = true;
      i.dispatchEvent(new Event('change'));
    });
    const dir = () => page.evaluate(() => {
      const { camera, orbit } = window.app.viewport;
      const d = camera.position.clone().sub(orbit.target).normalize();
      return d.toArray();
    });
    await page.evaluate(() => {
      const { camera, orbit } = window.app.viewport;
      camera.position.set(300, 50, 40);
      orbit.update();
    });
    await page.mouse.click(300, 400); // focus the page, not a field
    await page.keyboard.press('Escape');
    await page.keyboard.press('h');
    await sleep(200);
    const d = await dir();
    const want = [-170, -260, 190];
    const len = Math.hypot(...want);
    const dot = d.reduce((s, v, i) => s + v * (want[i] / len), 0);
    if (dot < 0.999) throw new Error(`camera direction ${d.map((v) => v.toFixed(2))}`);
    return 'start angle restored';
  });

  await check('Number fields refuse letters', async () => {
    await reset();
    const id = await addCube(0, 0, 20);
    await select([id]);
    await page.click('[data-mode="translate"]');
    const input = '#transform-bar .field.x input';
    // Start from an empty field (triple-click doesn't select text in number fields everywhere).
    await page.$eval(input, (e) => { e.value = ''; e.focus(); });
    await page.keyboard.type('1a2e.5b');
    const v = await page.$eval(input, (e) => e.value);
    await page.keyboard.press('Escape');
    if (v !== '12.5') throw new Error(`field shows "${v}"`);
    return 'typed 1a2e.5b, got 12.5';
  });

  await check('Check and Repair box with log and undo', async () => {
    await reset();
    const id = await addCube(0, 0, 20);
    await select([id]);
    await clickSel(page, '[data-menu="check-menu"]');
    await clickSel(page, '#check-menu [data-action="check"]');
    await page.waitForFunction(() => document.querySelectorAll('#check-results .check-list li').length > 0, { timeout: 15000 });
    await page.click('#check-repair');
    await page.waitForFunction(() => document.querySelectorAll('#repair-log li').length > 0 && !document.querySelector('#check-repair').disabled, { timeout: 15000 });
    const log = await page.$$eval('#repair-log li', (els) => els.map((e) => e.textContent));
    await page.click('#check-dialog button[value="close"]');
    if (await visible(page, '#check-dialog')) throw new Error('box did not close');
    return `log: ${log.join(' | ')}`;
  });

  await check('Privacy opens as a box', async () => {
    await clickSel(page, '[data-menu="file-menu"]');
    await clickSel(page, '#file-menu [data-action="privacy"]');
    if (!(await visible(page, '#privacy-dialog'))) throw new Error('privacy box not shown');
    await page.click('#privacy-dialog button[type="submit"]');
    if (await visible(page, '#privacy-dialog')) throw new Error('privacy box did not close');
  });

  await check('Side panel order from Settings', async () => {
    const order = () => page.$$eval('#sidebar > [data-panel]', (els) => els.map((e) => e.dataset.panel));
    const before = await order();
    await clickSel(page, '[data-menu="file-menu"]');
    await clickSel(page, '#file-menu [data-action="settings"]');
    // Move the second section up, check, then move it back down.
    await clickSel(page, '#panel-order li:nth-child(2) .up');
    const moved = await order();
    await clickSel(page, '#panel-order li:nth-child(1) .down');
    await page.click('[data-action="close-settings"]');
    if (moved[0] !== before[1] || moved[1] !== before[0]) throw new Error(`order ${moved.join(',')} from ${before.join(',')}`);
    const back = await order();
    if (back.join() !== before.join()) throw new Error(`not restored: ${back.join(',')}`);
    return `${before[1]} moved above ${before[0]} and back`;
  });

  await check('Combined objects get a new name', async () => {
    await reset();
    const a = await addCube(0, 0, 20);
    const bId = await addCube(20, 0, 20);
    await select([a, bId]);
    await page.click('[data-boolean="union"]');
    await page.waitForFunction(() => window.app.doc.objects.length === 1, { timeout: 15000 });
    const name = await page.evaluate(() => window.app.doc.objects[0].name);
    if (!/^Object \d+$/.test(name)) throw new Error(`merged object is called "${name}"`);
    return name;
  });

  await check('Measuring shows what a point snapped to', async () => {
    await reset();
    await addCube(0, 0, 20);
    await page.evaluate(() => window.app.viewport.fit(window.app.doc.worldBox(window.app.doc.objects)));
    await clickSel(page, '[data-measure="distance"]');
    // Screen spot of a world point (aimed 1 mm inside the top face, so snapping has to pull it in).
    const spot = (p) => page.evaluate((p) => {
      const { viewport } = window.app;
      const s = viewport.project(new viewport.camera.position.constructor(...p));
      const r = viewport.element.getBoundingClientRect();
      return { x: r.left + s.x, y: r.top + s.y };
    }, p);
    const tagAt = async (p) => {
      const at = await spot(p);
      await page.mouse.move(at.x, at.y);
      await sleep(150);
      return page.evaluate(() => document.querySelector('.m-snap')?.textContent ?? null);
    };
    const corner = await tagAt([19, -19, 40]);
    const middle = await tagAt([0.6, -19, 40]);
    const plain = await tagAt([-6, 6, 40]); // middle of the top face: nothing to snap to
    await page.keyboard.press('Escape');
    if (corner !== 'Corner') throw new Error(`at a corner: ${corner}`);
    if (middle !== 'Middle of edge') throw new Error(`at an edge middle: ${middle}`);
    if (plain !== null) throw new Error(`on a plain face: ${plain}`);
    // Curved shapes: a cylinder's rim is only "on edge"; a sphere has nothing to snap to.
    const curved = {};
    for (const kind of ['cylinder', 'sphere']) {
      await reset();
      const box = await page.evaluate((kind) => {
        document.querySelector(`[data-insert="${kind}"]`).click();
        const { doc, viewport } = window.app;
        viewport.fit(doc.worldBox(doc.objects));
        const b = doc.worldBox(doc.objects);
        return { min: b.min.toArray(), max: b.max.toArray() };
      }, kind);
      const cx = (box.min[0] + box.max[0]) / 2, cy = (box.min[1] + box.max[1]) / 2, r = (box.max[0] - box.min[0]) / 2;
      await clickSel(page, '[data-measure="distance"]');
      curved[kind] = kind === 'cylinder'
        ? await tagAt([cx + (r - 1) * Math.SQRT1_2, cy - (r - 1) * Math.SQRT1_2, box.max[2]])
        : await tagAt([cx, cy - r * 0.3, box.max[2] - 2]);
      await page.keyboard.press('Escape');
    }
    // A torus cut through its middle (where a ring of mesh points lies): its rim is only "on edge".
    await reset();
    const rim = await page.evaluate(async () => {
      document.querySelector('[data-insert="torus"]').click();
      const { doc, viewport } = window.app;
      viewport.home(doc.worldBox(doc.objects));
      document.querySelector('[data-action="cross-section"]').click();
      document.querySelector('[data-section-axis="2"]').click();
      const b = doc.worldBox(doc.objects);
      const mid = (b.min.z + b.max.z) / 2;
      const v = document.querySelector('#section-value');
      v.value = String(mid);
      v.dispatchEvent(new Event('change'));
      await new Promise((r) => setTimeout(r, 100));
      return { x: b.max.x - 0.3, z: mid };
    });
    await clickSel(page, '[data-measure="distance"]');
    const torusRim = await tagAt([rim.x, 0, rim.z]);
    await page.keyboard.press('Escape');
    await page.click('#section-bar [data-section="close"]');
    // A threaded rod: its crests zigzag across the triangles; no corners or middles there.
    await reset();
    const crest = await page.evaluate(async () => {
      const { doc, viewport } = window.app;
      document.querySelector('[data-thread="rod"]').click();
      await new Promise((r) => setTimeout(r, 1500));
      document.querySelector('#feature-bar [data-feature="apply"]').click();
      await new Promise((r) => setTimeout(r, 300));
      viewport.fit(doc.worldBox(doc.objects));
      const b = doc.worldBox(doc.objects);
      return { x: b.min.x + 0.2, y: (b.min.y + b.max.y) / 2, z: (b.min.z + b.max.z) / 2 };
    });
    await clickSel(page, '[data-measure="distance"]');
    const threadTags = [];
    for (const dz of [0, 0.3, 0.6, 0.9]) threadTags.push(await tagAt([crest.x, crest.y, crest.z + dz]));
    await page.keyboard.press('Escape');
    if (torusRim !== 'On edge') throw new Error(`torus cut through its middle, rim: ${torusRim}`);
    if (threadTags.some((t) => t === 'Corner' || t === 'Middle of edge')) throw new Error(`thread crest: ${threadTags.join(', ')}`);
    if (!threadTags.includes('On edge')) throw new Error(`thread crest not reached: ${threadTags.join(', ')}`);
    if (curved.cylinder !== 'On edge') throw new Error(`cylinder rim: ${curved.cylinder}`);
    if (curved.sphere !== null) throw new Error(`sphere: ${curved.sphere}`);
    return 'cube: Corner, Middle of edge; cylinder rim and cut torus: On edge; sphere: none; thread crest: no corners';
  });

  await check('R repeats the last tool, only once it is finished', async () => {
    await shortcuts(true);
    await reset();
    const id = await addCube(0, 0, 20);
    await select([id]);
    await page.click('.toolbar [data-modify="pattern"]');
    if (!(await visible(page, '#feature-bar'))) throw new Error('Pattern did not open');
    await page.mouse.click(5, 300); // focus the page (empty strip at the left of the view)
    await page.keyboard.press('r');
    const refused = await page.$eval('#toast', (e) => (e.hidden ? '' : e.textContent));
    if (!refused.startsWith('Finish')) throw new Error(`no refusal while open: "${refused}"`);
    await page.keyboard.press('Escape');
    if (await visible(page, '#feature-bar')) throw new Error('Esc did not close Pattern');
    await select([id]);
    await page.keyboard.press('r');
    await sleep(200);
    const title = await page.$eval('#feature-bar .bar-title', (e) => e.textContent);
    const open = await visible(page, '#feature-bar');
    await page.keyboard.press('Escape');
    if (!open || title !== 'Pattern') throw new Error(`R opened "${open ? title : 'nothing'}"`);
    return 'refused while open; reopened Pattern after Esc';
  });

  await check('Export asks for a file name', async () => {
    await reset();
    const nameShown = async () => {
      await clickSel(page, '[data-menu="file-menu"]');
      await clickSel(page, '#file-menu [data-action="export-3mf"]');
      await page.waitForSelector('#export-dialog[open]', { timeout: 5000 });
      const v = await page.$eval('#export-name', (e) => e.value);
      await page.click('#export-dialog button[value="cancel"]');
      return v;
    };
    await addCube(0, 0, 20);
    const fresh = await nameShown();
    // Import a small STL called bracket.stl: the proposal becomes bracket_open_builder.
    await page.evaluate(async () => {
      const stl = 'solid t\nfacet normal 0 0 -1\nouter loop\nvertex 0 0 0\nvertex 0 10 0\nvertex 10 0 0\nendloop\nendfacet\n'
        + 'facet normal 0 -1 0\nouter loop\nvertex 0 0 0\nvertex 10 0 0\nvertex 0 0 10\nendloop\nendfacet\n'
        + 'facet normal -1 0 0\nouter loop\nvertex 0 0 0\nvertex 0 0 10\nvertex 0 10 0\nendloop\nendfacet\n'
        + 'facet normal 1 1 1\nouter loop\nvertex 10 0 0\nvertex 0 10 0\nvertex 0 0 10\nendloop\nendfacet\nendsolid t\n';
      await window.app.openFiles([new File([stl], 'bracket.stl')]);
    });
    const imported = await nameShown();
    if (fresh !== 'open_builder') throw new Error(`fresh drawing proposes "${fresh}"`);
    if (imported !== 'bracket_open_builder') throw new Error(`after importing bracket.stl: "${imported}"`);
    return `${fresh}; after import: ${imported}`;
  });

  await check('Single-key tool shortcuts', async () => {
    await shortcuts(true);
    await reset();
    await page.mouse.click(5, 300);
    const count = () => page.evaluate(() => window.app.doc.objects.length);
    await page.keyboard.press('1');
    await page.keyboard.press('2');
    await page.keyboard.press('3');
    const names = await page.evaluate(() => window.app.doc.objects.map((o) => o.name.replace(/ \d+$/, '')));
    if (names.join() !== 'Cube,Cylinder,Sphere') throw new Error(`1, 2, 3 added: ${names.join(', ')}`);
    await page.keyboard.press('d');
    if ((await count()) !== 4) throw new Error('D did not duplicate');
    const titles = {};
    for (const [key, want] of [['b', 'Edge bevel'], ['o', 'Edge rounding'], ['p', 'Pattern'], ['e', 'Extrude down']]) {
      await page.evaluate(() => window.app.doc.setSelection([window.app.doc.objects[0]]));
      await page.keyboard.press(key);
      await sleep(150);
      titles[key] = await page.$eval('#feature-bar', (e) => (e.hidden ? '' : e.querySelector('.bar-title').textContent));
      await page.keyboard.press('Escape');
      if (titles[key] !== want) throw new Error(`${key.toUpperCase()} opened "${titles[key]}"`);
    }
    await page.keyboard.press('s');
    const split = await visible(page, '#split-bar');
    await page.keyboard.press('Escape');
    if (!split) throw new Error('S did not open Split');
    return '1 2 3 D B O P E S all work';
  });

  await check('Tool keys and Delete are ignored while a tool is open', async () => {
    await shortcuts(true);
    await reset();
    const a = await addCube(0, 0, 20);
    const b2 = await addCube(30, 0, 20);
    await select([a, b2]);
    await page.mouse.click(5, 300);
    await select([a]);
    await page.click('.toolbar [data-action="extrude-down"]');
    for (const key of ['d', 'm', 's', '1', 'Delete']) await page.keyboard.press(key);
    const r = await page.evaluate(() => ({ n: window.app.doc.objects.length, bar: !document.querySelector('#feature-bar').hidden, title: document.querySelector('#feature-bar .bar-title').textContent }));
    // Copy still works inside a tool.
    await page.keyboard.down('Control');
    await page.keyboard.press('c');
    await page.keyboard.up('Control');
    const copied = await page.$eval('#toast', (e) => (e.hidden ? '' : e.textContent));
    await page.keyboard.press('Escape');
    if (r.n !== 2) throw new Error(`objects changed to ${r.n} while Extrude was open`);
    if (!r.bar || r.title !== 'Extrude down') throw new Error(`Extrude bar replaced by "${r.title}"`);
    if (!copied.startsWith('Copied')) throw new Error(`Ctrl+C inside a tool: "${copied}"`);
    return 'D M S 1 Delete ignored in Extrude; Ctrl+C works';
  });

  await check('View cube turns the view', async () => {
    const dir = async (name) => {
      await page.evaluate((name) => [...document.querySelectorAll('#view-cube .vc-face')].find((f) => f.textContent === name).click(), name);
      await sleep(700);
      return page.evaluate(() => {
        const { camera, orbit } = window.app.viewport;
        return camera.position.clone().sub(orbit.target).normalize().toArray().map((v) => Math.round(v * 100) / 100);
      });
    };
    const top = await dir('TOP');
    const right = await dir('RIGHT');
    if (top[2] < 0.99) throw new Error(`Top view looks from ${top}`);
    if (right[0] < 0.99) throw new Error(`Right view looks from ${right}`);
    await page.keyboard.press('h');
    return `Top from ${top}, Right from ${right}`;
  });

  await check('Overhangs, reflection and plate settings apply', async () => {
    await reset();
    await page.evaluate(() => {
      document.querySelector('[data-insert="sphere"]').click();
      const { doc } = window.app;
      doc.objects[0].mesh.position.z += 15;
      doc.emit('transform');
    });
    const before = errors.length;
    const r = await page.evaluate(async () => {
      const item = document.querySelector('[data-action="overhangs"]');
      item.click();
      const on = item.getAttribute('aria-checked');
      const panel = !document.querySelector('#overhang-bar').hidden;
      const angleField = document.querySelector('#overhang-angle').value;
      const refl = document.querySelector('input[name="reflection"]');
      refl.checked = true;
      refl.dispatchEvent(new Event('change'));
      const plate = document.querySelector('input[name="plateOpacity"]');
      plate.value = '0.1';
      plate.dispatchEvent(new Event('input'));
      window.app.viewport.invalidate();
      await new Promise((res) => setTimeout(res, 300));
      const shown = window.app.viewport.reflection.group.visible;
      // The toolbar is locked while a view tool is open: close with the panel's own button.
      document.querySelector('#overhang-bar [data-overhang="close"]').click();
      refl.checked = false;
      refl.dispatchEvent(new Event('change'));
      plate.value = '0.35';
      plate.dispatchEvent(new Event('input'));
      return { on, panel, angleField, shown, seeThrough: plate.parentElement.querySelector('output').textContent };
    });
    await page.screenshot({ path: `${SHOTS}/${b.name}-overhangs.png` });
    if (errors.length > before) throw new Error(errors.slice(before).join(' | '));
    if (r.on !== 'true') throw new Error('Show overhangs did not switch on');
    if (!r.panel || r.angleField !== '45') throw new Error(`overhang panel shown: ${r.panel}, angle field "${r.angleField}"`);
    if (!r.shown) throw new Error('reflection not shown');
    return `overhangs on, reflection shown, plate see-through ${r.seeThrough}, no errors`;
  });

  await check('Cross section: cut filled, measuring snaps on it', async () => {
    await reset();
    await addCube(0, 0, 20);
    const before = errors.length;
    await page.evaluate(() => {
      const { doc, viewport } = window.app;
      viewport.home(doc.worldBox(doc.objects));
      document.querySelector('[data-action="cross-section"]').click();
      document.querySelector('[data-section-axis="1"]').click();
    });
    await sleep(200);
    const clipped = await page.evaluate(() => window.app.doc.objects[0].mesh.material.clippingPlanes?.length ?? 0);
    await clickSel(page, '[data-measure="distance"]');
    // The middle of the cut's top edge: world (0, 0, 40) for a 40 mm cube centred at z = 20.
    const at = await page.evaluate(() => {
      const { viewport } = window.app;
      const p = viewport.project(new viewport.camera.position.constructor(0, 0, 39.6));
      const r = viewport.element.getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    });
    await page.mouse.move(at.x, at.y);
    await sleep(150);
    const tag = await page.evaluate(() => document.querySelector('.m-snap')?.textContent ?? null);
    await page.screenshot({ path: `${SHOTS}/${b.name}-section.png` });
    await page.keyboard.press('Escape');
    await page.click('#section-bar [data-section="close"]');
    const after = await page.evaluate(() => window.app.doc.objects[0].mesh.material.clippingPlanes?.length ?? 0);
    if (errors.length > before) throw new Error(errors.slice(before).join(' | '));
    if (clipped !== 1) throw new Error('objects not cut');
    if (tag !== 'Middle of edge') throw new Error(`snap on the cut: ${tag}`);
    if (after !== 0) throw new Error('still cut after Close');
    return 'cut, snapped to the middle of the cut edge, closed';
  });

  await check('Esc closes every tool, even from its own field', async () => {
    await shortcuts(false);
    await reset();
    const id = await addCube(0, 0, 20);
    // [name, how to open, what shows while open]
    const tools = [
      ['Split', () => document.querySelector('[data-action="split"]').click(), '#split-bar'],
      ['Extrude', () => document.querySelector('[data-action="extrude-down"]').click(), '#feature-bar'],
      ['Pattern', () => document.querySelector('[data-modify="pattern"]').click(), '#feature-bar'],
      ['Text', () => document.querySelector('[data-modify="text"]').click(), '#feature-bar'],
      ['Edge bevel', () => document.querySelector('[data-modify="chamfer"]').click(), '#feature-bar'],
      ['Edge rounding', () => document.querySelector('[data-modify="fillet"]').click(), '#feature-bar'],
      ['Shell', () => document.querySelector('[data-modify="shell"]').click(), '#feature-bar'],
      ['Subtract', () => document.querySelector('[data-boolean="difference"]').click(), '#feature-bar'],
      ['Intersect', () => document.querySelector('[data-boolean="intersection"]').click(), '#feature-bar'],
      ['Bolt', () => document.querySelector('[data-thread="bolt"]').click(), '#feature-bar'],
      ['Threaded hole', () => document.querySelector('[data-thread="tap"]').click(), '#feature-bar'],
      ['Measuring', () => document.querySelector('[data-measure="distance"]').click(), '#op-hint'],
      ['Cross section', () => document.querySelector('[data-action="cross-section"]').click(), '#section-bar'],
      ['Overhangs', () => document.querySelector('[data-action="overhangs"]').click(), '#overhang-bar'],
    ];
    const results = [];
    for (const [name, open, shows] of tools) {
      await select([id]);
      await page.evaluate(open);
      await sleep(150);
      if (!(await visible(page, shows))) throw new Error(`${name} did not open`);
      // Put the keyboard focus in the tool's own field when it has one.
      await page.evaluate((shows) => {
        const field = document.querySelector(`${shows} input`);
        if (field) field.focus();
        else document.activeElement?.blur();
      }, shows);
      await page.keyboard.press('Escape');
      await sleep(100);
      if (await visible(page, shows)) throw new Error(`Esc did not close ${name}`);
      results.push(name);
    }
    return `closed: ${results.join(', ')}`;
  });

  await check('Clicks in the view do not end a tool', async () => {
    await reset();
    const a = await addCube(-30, 0, 20);
    const other = await addCube(30, 0, 20);
    await page.evaluate(() => window.app.viewport.fit(window.app.doc.worldBox(window.app.doc.objects)));
    const spot = (id) => page.evaluate((id) => {
      const { doc, viewport } = window.app;
      const o = doc.objects.find((x) => x.id === id);
      const b = doc.worldBox([o]);
      const p = viewport.project(b.getCenter(o.mesh.position.clone()).setZ(b.max.z - 1));
      const r = viewport.element.getBoundingClientRect();
      return { x: r.left + p.x, y: r.top + p.y };
    }, id);
    const tools = [
      ['Split', '[data-action="split"]', '#split-bar'],
      ['Extrude', '[data-action="extrude-down"]', '#feature-bar'],
      ['Pattern', '[data-modify="pattern"]', '#feature-bar'],
      ['Shell', '[data-modify="shell"]', '#feature-bar'],
    ];
    for (const [name, button, shows] of tools) {
      await select([a]);
      await page.evaluate((b) => document.querySelector(b).click(), button);
      await sleep(150);
      const empty = await page.evaluate(() => {
        const r = window.app.viewport.element.getBoundingClientRect();
        return { x: r.left + 40, y: r.bottom - 120 };
      });
      await page.mouse.click(empty.x, empty.y);
      const o = await spot(other);
      await page.mouse.click(o.x, o.y);
      await sleep(100);
      const state = await page.evaluate((shows) => ({ open: !document.querySelector(shows).hidden, sel: window.app.doc.selection.map((x) => x.id) }), shows);
      await page.keyboard.press('Escape');
      if (!state.open) throw new Error(`${name} closed after clicks in the view`);
      if (state.sel.length !== 1 || state.sel[0] !== a) throw new Error(`${name}: the selection changed to ${state.sel}`);
    }
    return 'Split, Extrude, Pattern, Shell stay open; selection kept';
  });

  await check('Other controls are locked while a tool is open', async () => {
    await reset();
    const id = await addCube(0, 0, 20);
    await select([id]);
    await page.click('.toolbar [data-action="extrude-down"]');
    await sleep(150);
    await page.click('.toolbar [data-boolean="union"]');
    const msg = await page.$eval('#toast', (e) => e.textContent);
    const r = await page.evaluate(() => ({
      locked: document.body.classList.contains('tool-locked'),
      title: document.querySelector('#feature-bar .bar-title').textContent,
      addDim: Number(getComputedStyle(document.querySelector('.toolbar [data-menu="add-menu"]')).opacity),
      current: document.querySelector('.tool-current')?.dataset.action ?? null,
    }));
    await page.mouse.click(5, 300);
    await page.keyboard.down('Control');
    await page.keyboard.press('z');
    await page.keyboard.up('Control');
    const undoMsg = await page.$eval('#toast', (e) => e.textContent);
    // The view still works: X-ray on and off.
    await page.click('[data-view="xray"]');
    const xray = await page.$eval('[data-view="xray"]', (e) => e.classList.contains('active'));
    await page.click('[data-view="xray"]');
    await page.keyboard.press('Escape');
    const after = await page.evaluate(() => document.body.classList.contains('tool-locked'));
    if (!r.locked || r.title !== 'Extrude down') throw new Error(`locked ${r.locked}, bar "${r.title}"`);
    if (!msg.startsWith('Finish or cancel')) throw new Error(`Merge click: "${msg}"`);
    if (!(r.addDim < 0.5)) throw new Error(`Add object not dimmed (${r.addDim})`);
    if (r.current !== 'extrude-down') throw new Error(`highlighted: ${r.current}`);
    if (!undoMsg.startsWith('Finish or cancel')) throw new Error(`Ctrl+Z inside the tool: "${undoMsg}"`);
    if (!xray) throw new Error('X-ray did not switch on during the tool');
    if (after) throw new Error('still locked after Esc');
    return 'Merge refused, Add object dimmed, Extrude lit, Ctrl+Z refused, X-ray works, unlocked after Esc';
  });

  await check('One Cancel stops a slow preview', async () => {
    await reset();
    await page.evaluate(() => {
      document.querySelector('[data-insert="sphere"]').click();
      const { doc } = window.app;
      doc.setSelection(doc.objects);
    });
    const before = await page.evaluate(() => window.app.doc.objects[0].data);
    await page.evaluate(() => (window.dataBefore = window.app.doc.objects[0].data));
    await page.evaluate(() => document.querySelector('[data-modify="shell"]').click());
    await sleep(900); // the sphere's hollowing takes a few seconds
    const during = await page.evaluate(() => ({
      info: document.querySelector('#feature-bar .feature-info').textContent,
      busyShown: !document.querySelector('#busy').hidden,
    }));
    await page.click('#feature-bar [data-feature="cancel"]');
    await sleep(3500);
    const after = await page.evaluate(() => ({ same: window.app.doc.objects[0].data === window.dataBefore, bar: !document.querySelector('#feature-bar').hidden }));
    void before;
    if (during.info !== 'Working…') throw new Error(`bar info "${during.info}"`);
    if (during.busyShown) throw new Error('a second "Working…" box was shown');
    if (after.bar) throw new Error('bar still open');
    if (!after.same) throw new Error('the shell was applied after Cancel');
    return 'one Working…, Cancel closed the bar and stopped the calculation';
  });

  await check('Corner buttons: bottom right by the transform bar, labelled, Home and Delete on touch only', async () => {
    await reset();
    const id = await addCube(0, 0, 20);
    await select([id]);
    // Without a touch screen, Delete and Select several are hidden.
    const touchOnly = await page.evaluate(() => [...document.querySelectorAll('#view-corner .touch-only')].map((e) => getComputedStyle(e).display));
    if (touchOnly.some((d) => d !== 'none')) throw new Error(`touch-only buttons shown with a mouse: ${touchOnly}`);
    const out = [];
    for (const [w, h] of [[1400, 900], [820, 1180], [600, 800], [390, 844]]) {
      await page.setViewport({ width: w, height: h });
      await page.evaluate(() => { for (const e of document.querySelectorAll('#view-corner .touch-only')) e.style.display = 'flex'; });
      await sleep(400);
      const r = await page.evaluate(async () => {
        const corner = () => [...document.querySelectorAll('#view-corner button')]
          .filter((b) => b.offsetParent)
          .map((b) => ({ action: b.dataset.action, rect: b.getBoundingClientRect().toJSON() }));
        const hit = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
        const labels = [...document.querySelectorAll('#view-corner .corner-label')].filter((l) => l.offsetParent).length;
        const closedPanel = document.body.classList.contains('panel-closed');
        const bar = document.querySelector('#transform-bar').getBoundingClientRect();
        const box = document.querySelector('#view-corner').getBoundingClientRect();
        const buttons = corner();
        // Open a tool bar and see whether any corner button overlaps it.
        document.querySelector('[data-modify="pattern"]').click();
        await new Promise((res) => setTimeout(res, 200));
        const toolBar = document.querySelector('#feature-bar').getBoundingClientRect();
        const overTool = corner().some(({ rect }) => hit(rect, toolBar));
        document.querySelector('#feature-bar [data-feature="cancel"]').click();
        const tops = buttons.map((c) => c.rect.top);
        return {
          closedPanel, labels, overTool,
          overBar: hit(box, bar),
          level: Math.abs(buttons.at(-1).rect.bottom - bar.bottom) <= 2,
          above: box.bottom <= bar.top,
          order: buttons.map((c) => c.action),
          stacked: tops.every((t, i) => i === 0 || t > tops[i - 1]),
        };
      });
      if (r.overTool) throw new Error(`${w}px: a corner button covers the tool bar`);
      if (r.overBar) throw new Error(`${w}px: the corner buttons cover the transform bar`);
      if (!r.level && !r.above) throw new Error(`${w}px: neither level with the transform bar nor above it`);
      if (!r.stacked) throw new Error(`${w}px: buttons not one under the other`);
      if (r.order.join() !== `home,${r.closedPanel ? 'open-panel' : 'close-panel'},delete-selection,multi-select`) throw new Error(`${w}px: order ${r.order}`);
      if (r.closedPanel && r.labels !== 4) throw new Error(`${w}px: ${r.labels} labels with the panel closed`);
      if (!r.closedPanel && r.labels !== 0) throw new Error(`${w}px: labels shown with the panel open`);
      out.push(`${w}px ${r.level ? 'level' : 'above'}${r.closedPanel ? ', labelled' : ''}`);
    }
    await page.setViewport({ width: 1400, height: 900 });
    await sleep(300);
    await select([id]);
    await page.click('#view-corner [data-action="delete-selection"]');
    const n = await page.evaluate(() => window.app.doc.objects.length);
    if (n !== 0) throw new Error('Delete did not remove the selected object');
    await page.click('[data-action="undo"]');
    const back = await page.evaluate(() => window.app.doc.objects.length);
    await page.evaluate(() => { for (const e of document.querySelectorAll('#view-corner .touch-only')) e.style.display = ''; });
    if (back !== 1) throw new Error('Undo did not bring the object back');
    return `${out.join('; ')}; Delete removed the object, Undo brought it back`;
  });
  await check('Groups: mirror, on plate, split, extrude; one-object tools say why', async () => {
    await reset();
    // Two cubes side by side, one higher than the other, grouped.
    await addCube(-30, 0, 30);
    await addCube(30, 0, 50);
    await page.evaluate(() => {
      const { doc } = window.app;
      doc.group(doc.objects);
      doc.setSelection(doc.objects);
    });
    const xs = () => page.evaluate(() => window.app.doc.objects.map((o) => Math.round(o.mesh.position.x)));
    const zs = () => page.evaluate(() => window.app.doc.objects.map((o) => Math.round(window.app.doc.worldBox([o]).min.z)));
    // Mirror X: the parts swap sides.
    await page.evaluate(() => document.querySelector('[data-mirror="0"]').click());
    const mirrored = await xs();
    if (mirrored[0] !== 30 || mirrored[1] !== -30) throw new Error(`mirror X: parts at ${mirrored}`);
    // On plate: the group's lowest point rests on the plate; the parts keep their height difference.
    await page.click('[data-action="drop"]');
    const dropped = await zs();
    if (dropped[0] !== 0 || dropped[1] !== 20) throw new Error(`on plate: bottoms at ${dropped}`);
    // A one-object tool is refused with a reason.
    await page.evaluate(() => window.app.doc.setSelection(window.app.doc.objects));
    await page.evaluate(() => document.querySelector('[data-modify="chamfer"]').click());
    const why = await page.$eval('#toast', (e) => e.textContent);
    if (await visible(page, '#feature-bar')) throw new Error('Edge bevel opened on a group');
    if (!why.startsWith('Works on one object')) throw new Error(`edge bevel on a group: "${why}"`);
    // Split the group with a level plane at z 30: it crosses both cubes (0-40 and 20-60).
    await page.evaluate(() => document.querySelector('[data-action="split"]').click());
    await page.evaluate(() => {
      document.querySelector('[data-split-axis="2"]').click();
      const v = document.querySelector('#split-value');
      v.value = '30';
      v.dispatchEvent(new Event('change'));
    });
    await page.click('[data-split="apply"]');
    await page.waitForFunction(() => window.app.doc.objects.length === 4, { timeout: 15000 });
    const groups = await page.evaluate(() => {
      const byGroup = {};
      for (const o of window.app.doc.objects) {
        const top = window.app.doc.worldBox([o]).min.z >= 29.9 ? 'top' : 'bottom';
        (byGroup[o.groupId] ??= new Set()).add(top);
      }
      return Object.values(byGroup).map((s) => [...s].join());
    });
    if (groups.length !== 2 || !groups.includes('top') || !groups.includes('bottom')) throw new Error(`split groups: ${JSON.stringify(groups)}`);
    // Extrude the upper group down: the plane crosses both of its parts.
    await page.evaluate(() => {
      const { doc } = window.app;
      doc.setSelection(doc.objects.filter((o) => doc.worldBox([o]).min.z >= 29.9));
    });
    await page.evaluate(() => document.querySelector('[data-action="extrude-down"]').click());
    await applyFeature(page);
    await sleep(500);
    const bottoms = await page.evaluate(() => window.app.doc.selection.map((o) => Math.round(window.app.doc.worldBox([o]).min.z)));
    if (!bottoms.every((z) => z === 0)) throw new Error(`extruded group bottoms at ${bottoms}`);
    return 'mirror swapped sides, on plate kept heights, bevel refused, split into two groups, extrude reached the plate';
  });

  await check('Edge rounding and bevel on the same object', async () => {
    await reset();
    const id = await addCube(0, 0, 20);
    await select([id]);
    const tris = () => page.evaluate(() => window.app.doc.objects[0].data.indices.length / 3);
    /** Click the middle of one of the cube's top edges on screen (front: y min, back: y max). */
    const pickTopEdge = async (side) => {
      const at = await page.evaluate(([id, side]) => {
        const { doc, viewport } = window.app;
        const o = doc.objects.find((x) => x.id === id);
        const b = doc.worldBox([o]);
        const p = viewport.project(b.getCenter(o.mesh.position.clone()).setY(side === 'front' ? b.min.y : b.max.y).setZ(b.max.z));
        const r = viewport.element.getBoundingClientRect();
        return { x: r.left + p.x, y: r.top + p.y };
      }, [id, side]);
      await page.mouse.click(at.x, at.y);
    };
    const before = await tris();
    await page.evaluate(() => document.querySelector('[data-modify="fillet"]').click());
    if (await page.$('#feature-bar [data-key="scope"]')) throw new Error('"All sharp edges" choice still there');
    await pickTopEdge('front');
    await applyFeature(page);
    await page.waitForFunction((n) => window.app.doc.objects[0].data.indices.length / 3 > n, { timeout: 15000 }, before);
    const rounded = await tris();
    // Then bevel a different edge of the same object.
    await page.evaluate(() => document.querySelector('[data-modify="chamfer"]').click());
    if (!(await visible(page, '#feature-bar'))) throw new Error('Edge bevel did not open on a rounded object');
    await pickTopEdge('back');
    await applyFeature(page);
    await page.waitForFunction((n) => window.app.doc.objects[0].data.indices.length / 3 !== n, { timeout: 15000 }, rounded);
    return `no "All sharp edges"; cube ${before} → rounded ${rounded} → also bevelled ${await tris()} triangles`;
  });

  await check('Trackpad: two-finger swipe pans, mouse wheel still zooms', async () => {
    const cam = () => page.evaluate(() => {
      const { camera, orbit } = window.app.viewport;
      return { target: orbit.target.toArray(), distance: camera.position.distanceTo(orbit.target) };
    });
    const wheel = (init) => page.evaluate((init) => {
      const canvas = window.app.viewport.element.querySelector('canvas');
      canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaMode: 0, ...init }));
    }, init);
    const a = await cam();
    await wheel({ deltaX: 40, deltaY: 10 }); // a swipe has a sideways part
    await wheel({ deltaY: 30 }); // the same gesture going on straight down keeps panning
    const b = await cam();
    const moved = Math.hypot(...b.target.map((v, i) => v - a.target[i]));
    if (moved < 1) throw new Error('the swipe did not pan');
    if (Math.abs(b.distance - a.distance) > 0.01) throw new Error('the swipe zoomed');
    await sleep(400); // gesture over
    await wheel({ deltaY: 100 }); // a mouse wheel notch
    const c = await cam();
    if (Math.abs(c.distance - b.distance) < 0.5) throw new Error('the mouse wheel no longer zooms');
    if (Math.hypot(...c.target.map((v, i) => v - b.target[i])) > 0.01) throw new Error('the mouse wheel panned');
    await page.evaluate(() => window.app.viewport.home());
    return `swipe panned ${moved.toFixed(1)} mm at the same distance; wheel zoomed ${(c.distance - b.distance).toFixed(1)} mm`;
  });

  await check('Reflection follows a move in the same frame', async () => {
    await reset();
    const id = await addCube(0, 0, 20);
    const r = await page.evaluate(async (id) => {
      const { doc, viewport } = window.app;
      const o = doc.objects.find((x) => x.id === id);
      viewport.reflection.set(true, 0.3, 60);
      viewport.invalidate();
      await new Promise((res) => requestAnimationFrame(() => requestAnimationFrame(res)));
      // A frame first syncs the mirror copies, then draws (which refreshes the objects' matrices).
      // Moving and then syncing, as in one frame of a drag, must already put the copy in place.
      o.mesh.position.x = 37;
      viewport.reflection.sync();
      const copyX = viewport.reflection.copies.get(o.mesh).matrix.elements[12];
      viewport.reflection.set(false, 0.3, 60);
      viewport.invalidate();
      return copyX;
    }, id);
    if (Math.abs(r - 37) > 1e-6) throw new Error(`the reflection is at x ${r}, the object at 37`);
    return 'mirror copy in place in the same frame as the move';
  });

  await check('Overhangs stay solid in X-ray', async () => {
    await reset();
    await addCube(0, 0, 40); // floating: its whole bottom is an overhang
    const px = await page.evaluate(async () => {
      const { doc, viewport: v, overhangs } = window.app;
      doc.setSelection([]);
      overhangs.open();
      v.setGridVisible(false); // the plate would sit between the camera and the cube's underside
      v.viewFrom(new v.camera.position.constructor(0, -0.05, -1)); // from below
      await new Promise((res) => setTimeout(res, 500));
      const gl = v.renderer.getContext();
      const centre = () => {
        v.composer.render();
        const p = new Uint8Array(4);
        gl.readPixels(gl.drawingBufferWidth >> 1, gl.drawingBufferHeight >> 1, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, p);
        return [...p.slice(0, 3)];
      };
      doc.setView({ xray: false });
      const solid = centre();
      doc.setView({ xray: true });
      const xray = centre();
      doc.setView({ xray: false });
      overhangs.close();
      v.setGridVisible(true);
      v.home();
      return { solid, xray };
    });
    const diff = Math.max(...px.solid.map((c, i) => Math.abs(c - px.xray[i])));
    if (diff > 12) throw new Error(`overhang colour changes in X-ray: ${px.solid} → ${px.xray}`);
    return `overhang pixel ${px.solid} without X-ray, ${px.xray} with`;
  });

  await check('Tooltips in tool bars cover no other box', async () => {
    await reset();
    const a = await addCube(0, 0, 20);
    await addCube(20, 10, 20);
    const hits = [];
    for (const [tool, selectAll, controls] of [
      ['[data-action="split"]', false, ['[data-split-axis="0"]', '[data-split="apply"]']],
      ['[data-modify="pattern"]', false, ['[data-key="count"]', '[data-feature="cancel"]']],
      ['[data-boolean="intersection"]', true, ['[data-key="targets"]', '[data-feature="cancel"]']],
    ]) {
      await page.evaluate((all, id) => {
        const { doc } = window.app;
        doc.setSelection(all ? doc.objects : doc.objects.filter((o) => o.id === id));
      }, selectAll, a);
      await page.evaluate((s) => document.querySelector(s).click(), tool);
      await sleep(400);
      for (const c of controls) {
        await page.mouse.move(0, 0);
        await page.hover(c);
        await sleep(300);
        const r = await page.evaluate(() => {
          const tip = document.querySelector('#tooltip');
          if (tip.hidden) return 'no tooltip';
          const t = tip.getBoundingClientRect();
          return [...document.querySelectorAll('.top-bar:not([hidden]), #messages > :not([hidden])')]
            .filter((b) => { const r = b.getBoundingClientRect(); return r.width && t.left < r.right && t.right > r.left && t.top < r.bottom && t.bottom > r.top; })
            .map((b) => b.id).join() || null;
        });
        if (r) hits.push(`${c}: ${r}`);
      }
      await page.keyboard.press('Escape');
    }
    if (hits.length) throw new Error(hits.join('; '));
    return 'Split, Pattern and Intersect tooltips open below the bars and the hint';
  });
  await check('Top bar, brand and toolbar layout', async () => {
    const info = await page.evaluate(() => {
      const css = (s) => getComputedStyle(document.querySelector(s));
      return {
        brand: !!document.querySelector('#brand-overlay')?.getBoundingClientRect().width,
        addDir: css('[data-menu="add-menu"]').flexDirection,
        itemDir: css('[data-insert="cube"]').flexDirection,
        menuCaret: !!document.querySelector('[data-menu="file-menu"] .caret'),
      };
    });
    if (!info.brand) throw new Error('name not shown in the view');
    if (info.addDir !== 'column') throw new Error(`dropdown buttons are ${info.addDir}`);
    if (info.itemDir !== 'row') throw new Error(`menu items are ${info.itemDir}`);
    if (info.menuCaret) throw new Error('Menu button still has an arrow');
    const id = await page.evaluate(() => window.app.doc.objects[0].id);
    await select([id]);
    await page.click('[data-action="split"]');
    // The bar and the hint are each as wide as their content (at most 760 px), centred on the same line.
    const boxes = await page.evaluate(() => ['#split-bar', '#op-hint'].map((s) => {
      const r = document.querySelector(s).getBoundingClientRect();
      return { width: r.width, centre: r.left + r.width / 2 };
    }));
    await page.keyboard.press('Escape');
    if (Math.abs(boxes[0].centre - boxes[1].centre) > 2) throw new Error(`tool bar centred at ${boxes[0].centre} px, hint at ${boxes[1].centre} px`);
    if (boxes.some((b) => b.width > 761)) throw new Error(`wider than 760 px: ${boxes.map((b) => b.width)}`);
    return `bar ${boxes[0].width.toFixed(0)} px and hint ${boxes[1].width.toFixed(0)} px wide, centred together`;
  });
  await check('Portrait layout keeps sidebar beside the view', async () => {
    await page.setViewport({ width: 820, height: 1180 });
    await sleep(1000); // the side panel slides into its drawer place
    const r = await page.evaluate(() => {
      const v = document.querySelector('#viewport').getBoundingClientRect();
      const s = document.querySelector('#sidebar').getBoundingClientRect();
      const t = document.querySelector('.toolbar').getBoundingClientRect();
      return { vRight: v.right, vTop: v.top, sLeft: s.left, sTop: s.top, tBottom: t.bottom, scroll: document.documentElement.scrollWidth > innerWidth };
    });
    if (r.sLeft < r.vRight - 1) throw new Error('sidebar moved under the view');
    if (r.tBottom > r.vTop + 1) throw new Error('toolbar is not above the view');
    if (r.scroll) throw new Error('page scrolls sideways');
    await page.screenshot({ path: `${SHOTS}/${b.name}-portrait.png` });
    return 'sidebar right of view, toolbar above';
  });

  await check('Phone toolbar: first row fixed, no gaps', async () => {
    const out = [];
    for (const width of [360, 412]) {
      await page.setViewport({ width, height: 800 });
      await sleep(300);
      const r = await page.evaluate(() => {
        const top = (s) => Math.round(document.querySelector(`.toolbar ${s}`).getBoundingClientRect().top);
        const first = ['[data-menu="file-menu"]', '[data-menu="add-menu"]', '[data-action="undo"]', '[data-action="redo"]',
          '[data-action="copy"]', '[data-action="cut"]', '[data-action="paste"]'].map(top);
        const merge = top('[data-boolean="union"]');
        const toolbarSplit = getComputedStyle(document.querySelector('.toolbar > .group [data-action="split"]')).display;
        const rows = new Set([...document.querySelectorAll('.toolbar button:not(.menu > *)')]
          .filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().top))).size;
        return { first, merge, toolbarSplit, rows, scroll: document.documentElement.scrollWidth > innerWidth };
      });
      if (new Set(r.first).size !== 1) throw new Error(`${width}px: first-row buttons at ${r.first.join(', ')}`);
      if (r.merge <= r.first[0]) throw new Error(`${width}px: Merge is on the first row`);
      if (r.toolbarSplit !== 'none') throw new Error(`${width}px: Split still on the toolbar`);
      if (r.scroll) throw new Error(`${width}px: page scrolls sideways`);
      out.push(`${width}px ${r.rows} rows`);
    }
    await page.screenshot({ path: `${SHOTS}/${b.name}-phone.png` });
    return out.join('; ');
  });

  await check('Phone panel: view fills the screen, › reachable', async () => {
    await page.setViewport({ width: 390, height: 844 });
    await sleep(400);
    const closed = await page.evaluate(() => ({
      view: document.querySelector('#viewport').getBoundingClientRect().width,
      win: innerWidth,
    }));
    if (closed.view < closed.win - 1) throw new Error(`view is ${closed.view} px of ${closed.win} px (empty strip beside it)`);
    // The corner buttons (Delete and Select several show on touch screens; force them here) stay clear of the transform bar.
    const overlap = await page.evaluate(async () => {
      const touch = document.querySelectorAll('#view-corner .touch-only');
      for (const e of touch) e.style.display = 'flex';
      await new Promise((res) => setTimeout(res, 100));
      const bar = document.querySelector('#transform-bar').getBoundingClientRect();
      const corner = document.querySelector('#view-corner').getBoundingClientRect();
      for (const e of touch) e.style.display = '';
      return corner.left < bar.right && corner.right > bar.left && corner.top < bar.bottom && corner.bottom > bar.top;
    });
    if (overlap) throw new Error('corner buttons cover the transform bar');
    await clickSel(page, '#view-corner [data-action="open-panel"]');
    await sleep(400);
    const open = await page.evaluate(() => {
      const r = document.querySelector('#view-corner [data-action="close-panel"]').getBoundingClientRect();
      const s = document.querySelector('#sidebar').getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      return { left: r.left, right: r.right, sidebarLeft: s.left, onTop: !!hit?.closest('[data-action="close-panel"]') };
    });
    await page.screenshot({ path: `${SHOTS}/${b.name}-phone-panel.png` });
    if (open.left < 0 || !open.onTop) throw new Error(`› not reachable (x ${open.left.toFixed(0)}, on top: ${open.onTop})`);
    if (open.right > open.sidebarLeft + 1) throw new Error('› is under the panel');
    await page.click('#view-corner [data-action="close-panel"]');
    await sleep(400);
    if (!(await visible(page, '#view-corner [data-action="open-panel"]'))) throw new Error('Panel button did not come back');
    return 'full-width view; › left of the open panel, closes it';
  });

  await browser.close();

  await check('No-JavaScript message', async () => {
    const noJs = b.browser === 'firefox'
      ? await launch(b, { extraPrefsFirefox: { 'javascript.enabled': false } })
      : await launch(b);
    try {
      const p = await noJs.newPage();
      if (b.browser !== 'firefox') await p.setJavaScriptEnabled(false);
      await p.goto(URL, { waitUntil: 'load' });
      const text = await p.evaluate(() => document.body.innerText);
      if (!text.includes('needs JavaScript')) throw new Error('message not shown');
    } finally {
      await noJs.close();
    }
  });

  return results;
}

// --- Build, serve, run ---------------------------------------------------------

const run = (cmd, args) => new Promise((resolve, reject) => {
  const p = spawn(cmd, args, { stdio: 'inherit', shell: true });
  p.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${cmd} ${args.join(' ')} failed`))));
});

await run('npm', ['run', 'build']);
const server = spawn('npx', ['vite', 'preview', '--port', String(PORT), '--strictPort'], { shell: true, stdio: 'ignore' });
await sleep(2500);

let failed = 0;
try {
  for (const b of BROWSERS.filter((x) => !ONLY_BROWSERS || ONLY_BROWSERS.includes(x.name))) {
    console.log(`\n=== ${b.name} ===`);
    let results;
    try {
      results = await runChecks(b);
    } catch (err) {
      results = [{ name: 'Launch', ok: false, detail: String(err?.message ?? err).split('\n')[0] }];
    }
    for (const r of results) {
      if (!r.ok) failed++;
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? ` — ${r.detail}` : ''}`);
    }
  }
} finally {
  server.kill();
  if (process.platform === 'win32') spawn('taskkill', ['/pid', String(server.pid), '/T', '/F'], { shell: true });
}
console.log(`\n${failed === 0 ? 'All checks passed' : `${failed} check(s) failed`}. Screenshots in ${SHOTS}/`);
process.exit(failed ? 1 : 0);
