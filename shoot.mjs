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

// Equipment is locked until a rescuer is on site (DEVLOG 2026-08-01), and the cutter only works
// at arm's length — so put a man on the pile first, then take manual camera control back off him.
await page.evaluate(() => {
  window.__app.spawnRescuer();
  window.__app.params.rescuerMode = false;      // free orbit; he stays wherever we park him
});
await page.waitForTimeout(300);

// Select the concrete cutter — he holds it; right-click on an eligible spot will cut.
await page.evaluate(() => { window.__app.setEquipment('Concrete cutter'); });
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
  // Park the rescuer beside this tile and face him at it — the cutter refuses anything outside his
  // working sphere, so a driver has to walk him to the work exactly as a player would.
  await page.evaluate((w) => {
    window.__app.teleportRescuer(
      { x: w.x + 0.55, y: w.y + 0.15, z: w.z + 0.55 }, Math.atan2(-0.55, -0.55), false);
  }, world);
  const s = await page.evaluate((w) => window.__app.project(w), world);
  await page.mouse.move(s.x, s.y); await page.mouse.move(s.x + 3, s.y + 2);
  await page.mouse.click(s.x, s.y, { button: 'right' });
  await page.waitForTimeout(1600); await page.evaluate(() => window.__app.doFreeze());
  await page.waitForFunction(() => window.__app.phase() === 'frozen', null, { timeout: 10000 });
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

// hide void markers, drop the tool, then look down INTO the hole (frayed rebar at the rim)
await page.keyboard.press('v');
await page.evaluate(() => { window.__app.setEquipment('None'); });
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
// Rebar cutter is now reach-gated (needsReach: true). Park the rescuer beside the seam so the
// mouth can engage — free aim no longer applies.
await page.evaluate(() => { window.__app.setEquipment('Rebar cutter'); });
const rb = await page.evaluate(() => window.__app.firstRebar());
if (rb) {
  await page.evaluate((w) => {
    const yaw = Math.atan2(-(w.x), -(w.z));
    // Stand close enough that arm + toolLength cover the seam.
    window.__app.teleportRescuer({ x: w.x + 0.5, y: w.y, z: w.z + 0.5 }, yaw, false);
    const { camera, controls } = window.__app;
    camera.position.set(w.x + 1.6, w.y + 1.3, w.z + 1.6);
    controls.target.set(w.x, w.y, w.z);
    controls.update();
  }, rb);
  await page.waitForTimeout(200);
  const aim = rb.aim || rb;
  const s = await page.evaluate((w) => window.__app.project(w), aim);
  await page.mouse.move(s.x, s.y); await page.mouse.move(s.x + 2, s.y + 1);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `${OUT}/cut_5_rebar.png` });
  const eng = await page.evaluate(() => ({
    status: document.getElementById('status')?.textContent,
    state: window.__app.toolState(),
  }));
  console.log('rebar cutter aimed at exposed rebar @', rb, '| engaged:', eng.state.engaged, '| status:', eng.status);
} else console.log('no exposed rebar found for the rebar-cutter screenshot');

await browser.close();
console.log('screenshots written to', OUT);
