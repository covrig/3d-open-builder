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
    await page.waitForFunction(() => window.app.doc.objects.length === 1, { timeout: 15000 });
    const b = await boxOf(a);
    if (!near(b.max[1] - b.min[1], 10) || !near(b.max[0] - b.min[0], 40)) throw new Error(`unexpected size ${JSON.stringify(b)}`);
    return 'kept both ends of the cube inside the two shapes';
  });

  await check('Extrude down to the plate', async () => {
    await reset();
    const top = await addCube(30, 0, 100, [1, 1, 0.25]); // 40 × 40 × 10, floating
    await select([top]);
    await page.evaluate(() => (window.meshBefore = window.app.doc.objects.at(-1).data));
    await page.click('[data-action="extrude-down"]');
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
    await clickSel(page, '[data-menu="modify-menu"]');
    await clickSel(page, '[data-modify="shell"]');
    if (await visible(page, '#split-bar')) throw new Error('split stayed open under shell');
    if (!(await visible(page, '#feature-bar'))) throw new Error('shell did not open');
    await page.keyboard.press('Escape');
    if (await visible(page, '#feature-bar')) throw new Error('Esc did not close shell');
    return 'split closed when shell opened';
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

  await check('Deleting the object cancels its tool', async () => {
    await clickSel(page, '[data-menu="modify-menu"]');
    await clickSel(page, '[data-modify="shell"]');
    await page.evaluate(() => document.activeElement?.blur());
    await page.keyboard.press('Delete');
    await sleep(100);
    if (await visible(page, '#feature-bar')) throw new Error('shell stayed open');
    const msg = await page.$eval('#toast', (e) => e.textContent);
    return msg;
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

  await check('Reference picture: undo, and removing closes Calibrate', async () => {
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
    await page.click('[data-action="ref-remove"]');
    if (await visible(page, '#feature-bar')) throw new Error('calibrate stayed open after removing the picture');
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
    const widths = await page.evaluate(() => [
      document.querySelector('#split-bar').getBoundingClientRect().width,
      document.querySelector('#messages').getBoundingClientRect().width,
    ]);
    await page.keyboard.press('Escape');
    if (Math.abs(widths[0] - widths[1]) > 2) throw new Error(`tool bar ${widths[0]} px vs hint ${widths[1]} px`);
    return `bars ${widths[0].toFixed(0)} px wide`;
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
