// Headless browser driver: loads the app, lets it collapse, then drives the concrete cutter
// to open a square hole, screenshotting before/after. Verifies the on-screen equipment works.
// Requires the vite dev server on http://localhost:5173. Run: node shoot.mjs
import { chromium } from 'playwright';
import { homedir } from 'node:os';

const OUT = homedir();
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('console', (m) => { const t = m.text(); if (/error|Error|undefined/.test(t)) console.log('PAGE:', t); });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

await page.goto('http://localhost:5173/?test=1', { waitUntil: 'load' });

// wait until the app exposes the hook and the pile has frozen
await page.waitForFunction(() => window.__app, null, { timeout: 20000 });
await page.waitForFunction(() => window.__app.phase() === 'frozen', null, { timeout: 30000 });
const status1 = await page.evaluate(() => document.getElementById('status')?.textContent);
await page.screenshot({ path: `${OUT}/cut_1_collapsed.png` });
console.log('collapsed:', status1);

// select the concrete cutter, then move the mouse over the pile so the blade cursor engages
await page.evaluate(() => { window.__app.params.equipment = 'Concrete cutter'; window.__app.setEquipment('Concrete cutter'); });
await page.mouse.move(620, 470);
await page.mouse.move(640, 500);   // a second move so pointermove fires with a delta
await page.waitForTimeout(300);
await page.screenshot({ path: `${OUT}/cut_2_tool.png` });

// TWO aimed right-clicks at two DIFFERENT intact slabs — each hole must land where aimed
// (regression for the "second cut goes to a random spot" bug).
//
// Aim by projecting a real target's world position to a pixel rather than hard-coding screen
// coordinates: the settled pile's composition changes whenever the collapse model is retuned, and
// stale pixels land on a beam or an already-holed tile. The cut is then correctly REJECTED, which
// looks identical to "both cuts went to the same place" if you only compare lastCut().
const targets = await page.evaluate(() => {
  const sim = window.__app.sim();
  const slabs = sim.parts
    .filter((p) => !p.dead && p.kind === 'slab' && !p.frame)
    .map((p) => { const t = p.body.translation(); return { x: t.x, y: t.y, z: t.z }; })
    .sort((a, b) => b.y - a.y);                        // topmost are least likely to be occluded
  if (slabs.length < 2) return slabs;
  // two that are far apart, so a shared hole footprint can't explain a small separation
  const first = slabs[0];
  const far = slabs.find((s) => Math.hypot(s.x - first.x, s.z - first.z) > 1.2) || slabs[1];
  return [first, far];
});
console.log(`aiming at ${targets.length} intact slabs:`, targets.map((t) => `(${t.x.toFixed(1)}, ${t.y.toFixed(1)}, ${t.z.toFixed(1)})`).join(' and '));

const cutAt = async (world) => {
  const s = await page.evaluate((w) => window.__app.project(w), world);
  await page.mouse.move(s.x, s.y); await page.mouse.move(s.x + 3, s.y + 2);
  await page.mouse.click(s.x, s.y, { button: 'right' });
  await page.waitForTimeout(1600); await page.evaluate(() => window.__app.doFreeze());
  await page.waitForTimeout(200);
  return page.evaluate(() => {
    const c = window.__app.lastCut();
    return { x: +c.x.toFixed(2), y: +c.y.toFixed(2), z: +c.z.toFixed(2),
             cuts: window.__app.sim().stats.cuts,
             status: document.getElementById('status')?.textContent };
  });
};
const a = await cutAt(targets[0]);
const b = await cutAt(targets[1]);
if (b.cuts < 2) console.log('NOTE: the second cut was rejected —', b.status);
const dist = Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);
const stats = await page.evaluate(() => ({ parts: window.__app.sim().parts.length }));
await page.screenshot({ path: `${OUT}/cut_3_hole.png` });
console.log('cut#1 @', a, '  cut#2 @', b);
console.log(`cuts=${b.cuts}  parts=${stats.parts}  distance between the two holes=${dist.toFixed(2)} m`);
console.log(dist > 0.4 ? 'OK: the two aimed cuts landed at different spots (not a fixed random fallback).'
                       : 'WARN: the two cuts landed at ~the same spot — check aiming.');

// hide void markers + the tool blade, then look down INTO the hole (frayed rebar at the rim)
await page.keyboard.press('v');
await page.evaluate(() => { window.__app.params.equipment = 'None'; window.__app.setEquipment('None'); });
await page.evaluate(() => {
  const { camera, controls, lastCut } = window.__app;
  const p = lastCut();
  camera.position.set(p.x + 0.9, p.y + 1.7, p.z + 0.9);
  controls.target.set(p.x, p.y - 0.2, p.z);
  controls.update();
});
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/cut_4_closeup.png` });

// --- rebar cutter: aim the pliers at an exposed rebar (cracked tie) and screenshot ---
await page.keyboard.press('v');   // show void markers again off
await page.evaluate(() => { window.__app.params.equipment = 'Rebar cutter'; window.__app.setEquipment('Rebar cutter'); });
const rb = await page.evaluate(() => window.__app.firstRebar());
if (rb) {
  await page.evaluate((w) => { const { camera, controls } = window.__app; camera.position.set(w.x + 1.6, w.y + 1.3, w.z + 1.6); controls.target.set(w.x, w.y, w.z); controls.update(); }, rb);
  await page.waitForTimeout(200);
  const s = await page.evaluate((w) => window.__app.project(w), rb);   // reproject after camera move
  await page.mouse.move(s.x, s.y); await page.mouse.move(s.x + 2, s.y + 1);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/cut_5_rebar.png` });
  const eng = await page.evaluate(() => document.getElementById('status')?.textContent);
  console.log('rebar cutter aimed at exposed rebar @', rb, '| status:', eng);
} else console.log('no exposed rebar found for the rebar-cutter screenshot');

await browser.close();
console.log('screenshots written to', OUT);
