// Headless browser driver for the rescuer ↔ equipment coupling (DEVLOG 2026-08-01).
//
// The reach envelope itself is unit-tested in verify-reach.mjs; what can only be checked in a real
// browser is the WIRING: that the tool ring is dead until somebody is on site, that the rescuer
// actually picks the tool up, that the cutter refuses a slab he is standing too far from and
// accepts the same slab once he is beside it, and that a floor and a wall give different cut
// planes. Requires the vite dev server on http://localhost:5173. Run: node shoot-tooling.mjs

import { chromium } from 'playwright';
import { homedir } from 'node:os';

const OUT = homedir();
const browser = await chromium.launch({
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
page.on('pageerror', (e) => console.log('PAGEERROR:', e.message));

const checks = [];
const check = (name, pass, detail = '') => {
  checks.push({ name, pass });
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
};

await page.goto('http://localhost:5173/?test=1', { waitUntil: 'load' });
await page.waitForFunction(() => window.__app, null, { timeout: 20000 });
await page.waitForFunction(() => window.__app.phase() === 'frozen', null, { timeout: 40000 });

// --- 1. equipment is locked with nobody on site -----------------------------------------------
const locked = await page.evaluate(() => {
  window.__app.setEquipment('Concrete cutter');            // via the API
  const afterApi = window.__app.toolState();
  return { afterApi, disabled: window.__app.toolRingDisabled(), status: document.getElementById('status').textContent };
});
check('the cutter cannot be selected before a rescuer exists',
  locked.afterApi.tool === 'NONE' && !locked.afterApi.unlocked, locked.status);
check('all eight ring buttons are greyed out', locked.disabled === 8, `${locked.disabled} disabled`);

// The keyboard must not be a way round the gate.
await page.keyboard.press('1');
const afterKey = await page.evaluate(() => window.__app.toolState().tool);
check('pressing 1 does not slip past the gate', afterKey === 'NONE');
await page.screenshot({ path: `${OUT}/tool_1_locked.png` });

// --- 2. spawning a rescuer unlocks it, and he picks the tool up -------------------------------
await page.evaluate(() => window.__app.spawnRescuer());
await page.waitForTimeout(300);
const unlocked = await page.evaluate(() => {
  window.__app.setEquipment('Concrete cutter');
  return { state: window.__app.toolState(), disabled: window.__app.toolRingDisabled() };
});
check('a spawned rescuer unlocks the ring', unlocked.state.unlocked && unlocked.disabled === 0);
check('the cutter is selected and held in his right hand',
  unlocked.state.tool === 'CONCRETE_CUTTER' && unlocked.state.holdingProp);

// --- 3. the same slab: out of reach, then in reach ---------------------------------------------
// Pick an intact tile with clear sky above it so the mouse ray reaches it from a raised camera.
const target = await page.evaluate(() => {
  const sim = window.__app.sim();
  const slabs = sim.parts.filter((p) => !p.dead && p.kind === 'slab' && !p.frame)
    .map((p) => { const t = p.body.translation(); return { x: t.x, y: t.y, z: t.z }; })
    .sort((a, b) => b.y - a.y);
  return slabs[0] || null;
});
if (!target) { console.log('no intact slab left to aim at'); await browser.close(); process.exit(1); }
console.log(`target tile at (${target.x.toFixed(2)}, ${target.y.toFixed(2)}, ${target.z.toFixed(2)})`);

// Free camera, parked looking down at the tile, so both trials aim at exactly the same pixel.
const aimAt = async (world) => {
  await page.evaluate((w) => {
    const { camera, controls, params } = window.__app;
    params.rescuerMode = false;                 // free orbit; the rescuer stays where he is put
    camera.position.set(w.x + 2.6, w.y + 3.2, w.z + 2.6);
    controls.target.set(w.x, w.y, w.z);
    controls.update();
  }, world);
  await page.waitForTimeout(150);
  const s = await page.evaluate((w) => window.__app.project(w), world);
  await page.mouse.move(s.x, s.y);
  await page.mouse.move(s.x + 2, s.y + 1);      // a second move so pointermove fires with a delta
  await page.waitForTimeout(250);
  return s;
};

// (a) rescuer left at the pile perimeter — far from this tile
await page.evaluate((t) => window.__app.teleportRescuer({ x: t.x + 8, y: t.y, z: t.z + 8 }, 0, false), target);
await aimAt(target);
const far = await page.evaluate(() => window.__app.toolState());
check('the cutter refuses a tile he is nowhere near', !far.engaged && /reach|closer/i.test(far.reason), far.reason);
await page.screenshot({ path: `${OUT}/tool_2_out_of_reach.png` });

// (b) same tile, same pixel, rescuer now standing beside it and facing it
await page.evaluate((t) => {
  const yaw = Math.atan2(-0.55, -0.55);         // look back toward the tile from the +X/+Z side
  window.__app.teleportRescuer({ x: t.x + 0.55, y: t.y + 0.15, z: t.z + 0.55 }, yaw, false);
}, target);
await aimAt(target);
const near = await page.evaluate(() => window.__app.toolState());
check('the same tile is workable once he is beside it', near.engaged, `plane: ${near.cutPlane}`);
check('his arm reaches for the work', near.aiming);
await page.screenshot({ path: `${OUT}/tool_3_in_reach.png` });

// --- 4. the cut lands, and reports the plane it ran in -----------------------------------------
// Watch every status message rather than sampling one: cutting wakes the pile, and a piece
// shifting into a void raises SURVIVOR_COMPROMISED within a frame or two, overwriting the line.
await page.evaluate(() => {
  window.__statusLog = [];
  const el = document.getElementById('status');
  new MutationObserver(() => window.__statusLog.push(el.textContent))
    .observe(el, { childList: true, characterData: true, subtree: true });
});
const before = await page.evaluate(() => window.__app.sim().stats.cuts);
const s = await page.evaluate((w) => window.__app.project(w), target);
await page.mouse.click(s.x, s.y, { button: 'right' });
await page.waitForTimeout(1400);
const cut = await page.evaluate(() => ({
  cuts: window.__app.sim().stats.cuts,
  said: window.__statusLog.find((t) => /near-(horizontal|vertical) plane/.test(t)) || '',
}));
check('right-click opened the hole', cut.cuts > before, `cuts ${before} → ${cut.cuts}`);
check('the cut is reported as running in a near-horizontal plane',
  /near-horizontal plane/.test(cut.said), cut.said);

// --- 4b. a tile standing on edge cuts in the other plane ---------------------------------------
// "Slab" and "inclined wall" are the same part kind here; what differs is the face you present
// the saw to. Find an intact tile whose broad face points sideways and work that instead.
// Only a couple of tiles per pile end up steep enough (src/rescuer-reach.js calls a face vertical
// once its normal is more than 45° off world up), and one of those may well be buried where the
// mouse ray cannot see it — so gather the candidates steepest-first and try each in turn.
const leaning = await page.evaluate(() => {
  const sim = window.__app.sim();
  const out = [];
  for (const p of sim.parts) {
    if (p.dead || p.kind !== 'slab' || p.frame) continue;
    const q = p.body.rotation(), t = p.body.translation();
    // Rotate the tile's own local +Y (its thickness axis) into world space.
    const ax = 2 * (q.x * q.y - q.w * q.z);
    const ay = 1 - 2 * (q.x * q.x + q.z * q.z);
    const az = 2 * (q.y * q.z + q.w * q.x);
    if (Math.abs(ay) < 0.68) out.push({ x: t.x, y: t.y, z: t.z, ax, ay, az, tilt: Math.abs(ay) });
  }
  return out.sort((a, b) => a.tilt - b.tilt).slice(0, 4);
});
console.log(`${leaning.length} intact tiles are standing steeply enough to be a wall`);

let verticalSeen = null;
for (const L of leaning) {
  // Stand him off the broad face along its own normal, looking straight at it, with the camera
  // over his shoulder on the same axis so the mouse ray lands on that face.
  await page.evaluate((w) => {
    const { camera, controls } = window.__app;
    const sign = w.ay >= 0 ? 1 : -1;      // work the upper face, whichever way the tile fell
    window.__app.teleportRescuer(
      { x: w.x + w.ax * 0.8 * sign, y: w.y + w.ay * 0.8 * sign, z: w.z + w.az * 0.8 * sign },
      Math.atan2(-w.ax * sign, -w.az * sign), false);
    camera.position.set(w.x + w.ax * 2.6 * sign, w.y + w.ay * 2.6 * sign + 0.3, w.z + w.az * 2.6 * sign);
    controls.target.set(w.x, w.y, w.z);
    controls.update();
  }, L);
  await page.waitForTimeout(200);
  const sv = await page.evaluate((w) => window.__app.project(w), L);
  await page.mouse.move(sv.x, sv.y);
  await page.mouse.move(sv.x + 2, sv.y + 1);
  await page.waitForTimeout(250);
  const vstate = await page.evaluate(() => window.__app.toolState());
  if (vstate.engaged && vstate.cutPlane === 'vertical') { verticalSeen = vstate; break; }
}
check('a tile on edge is workable and reads as a near-vertical cut plane', !!verticalSeen,
  verticalSeen ? '' : 'none of the steep tiles was visible to the cursor');
if (verticalSeen) await page.screenshot({ path: `${OUT}/tool_5_vertical.png` });

// --- 5. first person shows the hand and the tool ----------------------------------------------
// T only toggles, and only applies the change through applyRescuerViewMode() — so hand it a known
// starting point ('third') and press it exactly once.
await page.evaluate(() => {
  window.__app.params.rescuerMode = true;
  window.__app.params.rescuerView = 'third';
});
await page.keyboard.press('t');
await page.waitForTimeout(500);
const fp = await page.evaluate(() => ({
  view: window.__app.params.rescuerView,
  state: window.__app.toolState(),
}));
check('T drops to the eyes', fp.view === 'first');
check('the tool viewmodel is showing at the eyes', fp.state.viewmodel && fp.state.holdingProp);
await page.screenshot({ path: `${OUT}/tool_4_first_person.png` });

// Back over the shoulder: the viewmodel must give way to the real arm holding the real prop.
await page.keyboard.press('t');
await page.waitForTimeout(400);
const tp = await page.evaluate(() => window.__app.toolState());
check('over the shoulder the viewmodel is hidden again', !tp.viewmodel && tp.holdingProp);
await page.screenshot({ path: `${OUT}/tool_6_third_person.png` });

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} coupling checks passed`);
console.log(`screenshots written to ${OUT}`);
await browser.close();
process.exit(failed.length ? 1 : 0);
