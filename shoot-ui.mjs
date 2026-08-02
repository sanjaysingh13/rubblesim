// Headless browser driver for the specs.md §4 UI: tool ring, stress map, volumetric voids,
// and the lifting-bag / shoring flow. Catches the load-time-exception class of bug that a
// successful `vite build` does not (DEVLOG: "black screen = a load-time exception").
// Requires the vite dev server on http://localhost:5173. Run: node shoot-ui.mjs
import { chromium } from 'playwright';
import { homedir } from 'node:os';

const OUT = homedir();
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
const errors = [];
page.on('pageerror', (e) => { errors.push(e.message); console.log('PAGEERROR:', e.message); });
page.on('console', (m) => { if (m.type() === 'error') { errors.push(m.text()); console.log('PAGE ERROR:', m.text()); } });

await page.goto('http://localhost:5173/?test=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__app, null, { timeout: 20000 });
await page.waitForFunction(() => window.__app.phase() === 'frozen', null, { timeout: 40000 });
console.log('collapsed:', await page.evaluate(() => document.getElementById('status')?.textContent));

// --- tool ring present and selectable ---------------------------------------
const ring = await page.evaluate(() => window.__app.toolRing());
console.log(`tool ring: ${ring.length} entries — ${ring.map((r) => r.tool).join(', ')}`);

// Equipment is locked until somebody is on site to carry it (DEVLOG 2026-08-01), so nothing below
// this line can select a tool without a rescuer. shoot-tooling.mjs is the driver that tests the
// lock itself; here we just unlock and get on with the §4 UI.
const lockedRing = await page.evaluate(() => window.__app.toolRingDisabled());
console.log(`tool ring before a rescuer exists: ${lockedRing} of ${ring.length} buttons disabled`);
await page.evaluate(() => { window.__app.spawnRescuer(); window.__app.params.rescuerMode = false; });
await page.waitForTimeout(300);

// keyboard selection must drive the same global state the ring shows
await page.keyboard.press('4');
const afterKey = await page.evaluate(() => ({ tool: window.__app.activeTool(), ring: window.__app.toolRing() }));
const pressedMatches = afterKey.ring.find((r) => r.on)?.tool === afterKey.tool;
console.log(`pressed "4" -> activeTool=${afterKey.tool}, ring highlight in sync: ${pressedMatches}`);

// --- tool switching (oxy-acetylene aims at concrete/beams; cutter too) --------
const layerCheck = await page.evaluate(() => {
  const out = {};
  window.__app.setEquipment('Oxy-acetylene torch');
  out.torch = window.__app.params.equipment;
  window.__app.setEquipment('Concrete cutter');
  out.cutter = window.__app.params.equipment;
  return out;
});
console.log('tool switching ok:', JSON.stringify(layerCheck));

// --- stress map --------------------------------------------------------------
await page.evaluate(() => { window.__app.params.showStress = true; window.__app.updateStressMap(); });
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/ui_1_stress.png` });
const frame = await page.evaluate(() => window.__app.frameReport());
console.log(`frame: ${frame.standing}/${frame.columns} columns standing, worst utilization ${frame.worstUtilization.toFixed(2)}, ` +
  `dead ${frame.deadPerBay.toFixed(0)} kN + live ${frame.livePerBay.toFixed(0)} kN per bay`);
await page.evaluate(() => { window.__app.params.showStress = false; window.__app.updateStressMap(); });

// --- volumetric voids -------------------------------------------------------
const voids = await page.evaluate(() => window.__app.voids());
console.log(`voids rendered as volumes: ${voids.length}`);
await page.screenshot({ path: `${OUT}/ui_2_voids.png` });

// --- shoring then lifting, driven through the real UI ------------------------
// Place shores first, then a bag, and read the HUD load panel — the training loop end to end.
const shoreResult = await page.evaluate(() => {
  const sim = window.__app.sim();
  const spots = sim.rescue.findShoreSpots({ minClear: 1.0 }).slice(0, 3);
  const placed = spots.map((s) => sim.rescue.placeShore(s, 'tShore')).filter(Boolean);
  return { spots: spots.length, placed: placed.length };
});
console.log(`shoring: ${shoreResult.placed} shores placed at ${shoreResult.spots} viable spots`);
await page.waitForTimeout(1500);

const bagResult = await page.evaluate(() => {
  const sim = window.__app.sim();
  sim.support.rebuild();
  const ranked = sim.parts.filter((p) => !p.dead && p.kind === 'slab')
    .map((p) => ({ p, load: sim.support.supportedLoad(p) })).sort((a, b) => b.load - a.load);
  const t = ranked[0].p.body.translation();
  const bag = sim.rescue.placeBag({ x: t.x, y: t.y - ranked[0].p.shape.hy - 0.12, z: t.z }, 'bag4t');
  return bag ? { capacity: bag.capacity, load: bag.load } : null;
});
console.log('bag placed:', JSON.stringify(bagResult));
await page.waitForTimeout(2500);
const ops = await page.evaluate(() => window.__app.rescueReport());
for (const b of ops.bags) console.log(`  bag ${b.label}: ${b.load.toFixed(0)}/${b.capacity.toFixed(0)} kN, lift ${(b.lift * 100).toFixed(0)} cm, stalled=${b.stalled}`);
for (const s of ops.shores) console.log(`  shore ${s.label}: ${s.carrying.toFixed(0)}/${s.capacity.toFixed(0)} kN (${s.governing}) failed=${s.failed}`);

// frame the bag so the screenshot shows the bag + shores + load panel
await page.evaluate(() => {
  const sim = window.__app.sim();
  const bag = sim.rescue.bags[0];
  if (!bag) return;
  const { camera, controls } = window.__app;
  // pull well back and up: the bag sits INSIDE the pile, so a close camera lands inside a slab
  camera.position.set(bag.point.x + 9, bag.point.y + 7, bag.point.z + 9);
  controls.target.set(bag.point.x, bag.point.y + 0.5, bag.point.z);
  controls.update();
});
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/ui_3_rescue.png` });

const panel = await page.evaluate(() => document.getElementById('loads')?.textContent);
console.log('load panel:', panel?.replace(/\s+/g, ' ').slice(0, 160));

const compromised = await page.evaluate(() => ({ n: window.__app.compromised(), ev: window.__app.voidEvents() }));
console.log(`voids compromised during the operation: ${compromised.n}`);

await browser.close();
console.log(`\npage errors: ${errors.length}`);
console.log(errors.length ? 'FAIL: the page reported errors (see above).' : 'PASS: UI drove cleanly with no page errors.');
console.log('screenshots written to', OUT);
process.exit(errors.length ? 1 : 0);
