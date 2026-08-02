// Drive RubbleSim in a real Chromium (Playwright) and score +1 victim reached.
// Requires vite on http://127.0.0.1:5173. Run: node play-score.mjs
//
// This is not a full human playthrough of cutting every rebar — it uses the same
// browser + __app hooks as shoot-*.mjs, plus keyboard/mouse where practical, to
// prove the score / stretcher path end-to-end.

import { chromium } from 'playwright';
import { homedir } from 'node:os';
import { join } from 'node:path';

const OUT = join(homedir(), 'play_score.png');
const TRIAGE = join(homedir(), 'play_score_triage.png');
const BASE = process.env.RUBBLE_URL || 'http://127.0.0.1:5173';

const browser = await chromium.launch({
  args: [
    '--use-gl=angle', '--use-angle=swiftshader',
    '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist',
  ],
});
const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
const errors = [];
page.on('pageerror', (e) => { errors.push(e.message); console.log('PAGEERROR:', e.message); });

console.log('loading', `${BASE}/?test=1`);
await page.goto(`${BASE}/?test=1`, { waitUntil: 'load', timeout: 60000 });
await page.waitForFunction(() => window.__app, null, { timeout: 30000 });
await page.waitForFunction(() => window.__app.phase() === 'frozen', null, { timeout: 90000 });
console.log('status:', await page.evaluate(() => document.getElementById('status')?.textContent));

// Some seeds have zero confined pockets. Regen with faster collapse until survivors exist.
for (let attempt = 0; attempt < 15; attempt++) {
  const n = await page.evaluate(() => window.__app.voids().filter((v) => v.confined).length);
  console.log(`seed attempt ${attempt}: ${n} confined void(s), seed=${await page.evaluate(() => window.__app.params.seed)}`);
  if (n > 0) break;
  await page.evaluate((s) => {
    const p = window.__app.params;
    p.seed = s;
    p.standSeconds = 0.25;
    p.settleSeconds = 2.5;
    // Slightly easier confine so playtests usually find a pocket.
    p.voidConfineMinHits = Math.min(p.voidConfineMinHits || 6, 5);
    p.rebuild();
  }, 10 + attempt * 7);
  await page.waitForTimeout(400);
  // Force collapse + freeze so we do not wait forever on settle heuristics.
  await page.evaluate(() => {
    if (window.__app.phase() === 'standing') window.__app.doCollapse();
  });
  await page.waitForTimeout(2800);
  await page.evaluate(() => window.__app.doFreeze());
  await page.waitForFunction(() => window.__app.phase() === 'frozen', null, { timeout: 20000 });
}
console.log('status:', await page.evaluate(() => document.getElementById('status')?.textContent));

// Spawn rescuer like a player pressing R.
await page.keyboard.press('r');
await page.waitForTimeout(400);
const spawned = await page.evaluate(() => !!window.__app.rescuer());
if (!spawned) {
  await page.evaluate(() => window.__app.spawnRescuer());
  await page.waitForTimeout(300);
}
console.log('rescuer on site:', await page.evaluate(() => !!window.__app.rescuer()));

// Pick a confined survivor (orange figure in a void).
const target = await page.evaluate(() => {
  const voids = window.__app.voids().filter((v) => v.confined);
  if (!voids.length) return null;
  const v = voids[0];
  const floorY = v.floorY != null ? v.floorY : v.y - v.height / 2;
  return {
    victimId: 'v0',
    x: v.x,
    y: floorY + 0.07,
    z: v.z,
    floorY,
    voidY: v.y,
    height: v.height,
    radius: v.radius,
  };
});
if (!target) {
  console.log('FAIL: no confined victim this seed');
  await browser.close();
  process.exit(1);
}
console.log(
  `target survivor at (${target.x.toFixed(2)}, ${target.y.toFixed(2)}, ${target.z.toFixed(2)})`,
);

// Human-ish path compressed: prove ingress (unlock), go prone, stand on the survivor.
// Cutting a real hole above an arbitrary void is seed-dependent and often wakes −N ops;
// the training gate we care about here is unlock → touch → +1 → stretcher.
const scored = await page.evaluate(async (t) => {
  const agent = window.__app.rescuer();
  if (!agent) return { ok: false, reason: 'no agent' };

  // Latch "cut your way in" without relying on a lucky hole above this void.
  agent.hasMadeIngress = true;
  agent.unlockVictimIngress(t.victimId);

  // Hold X (prone) via the same input path the player uses.
  // Direct setProne is OK as a stand-in when the tab may not keep key state in headless.
  agent.setProne(true);

  // Plant on the pocket floor, within touch range of the survivor.
  const y = t.floorY + (agent.capRadius || 0.22);
  agent._setPose({ x: t.x - 0.35, y, z: t.z });
  agent.yaw = Math.atan2(0.35, 0);

  // Run a few agent steps so access + evacuate hooks fire like a normal frame.
  for (let i = 0; i < 10; i++) {
    agent.step(1 / 60, {
      prone: true,
      camForward: { x: 1, z: 0 },
      camRight: { x: 0, z: 1 },
    });
  }
  // Drain into the renderer event path by ticking via a no-op evaluate after rAF.
  return {
    ok: true,
    accessed: agent.accessedCount(),
    prone: agent.prone,
    unlocked: agent.victims?.[0]?.ingressUnlocked,
  };
}, target);

console.log('agent after approach:', scored);

// Let the main loop drain VICTIM_ACCESSED → evacuate animation.
await page.waitForTimeout(200);
// Force one more access check through the live stepRescuer path if needed.
await page.evaluate(() => {
  const a = window.__app.rescuer();
  if (a) a._checkVictimAccess();
});
// Manually dispatch score if agent already accessed but renderer missed the event
// (events are drained only inside stepRescuer). Re-step via keyboard X hold + tiny wait.
await page.keyboard.down('x');
await page.waitForTimeout(800);
await page.keyboard.up('x');
await page.waitForTimeout(900);

let report = await page.evaluate(() => ({
  score: window.__app.score(),
  reached: window.__app.victimsAccessed(),
  ops: window.__app.rescuerCompromised(),
  status: document.getElementById('status')?.textContent,
  loads: document.getElementById('loads')?.textContent,
  stretchers: document.querySelectorAll ? null : null,
}));

// If the renderer never saw the event (stepRescuer didn't run with drained events),
// synthesize the toast path by reading agent.accessed and calling evacuate helpers is hard.
// Instead: teleport + run stepRescuer by enabling rescuerMode and waiting.
if (report.reached < 1) {
  console.log('renderer score still 0 — driving live stepRescuer frames…');
  await page.evaluate((t) => {
    const app = window.__app;
    app.params.rescuerMode = true;
    const a = app.rescuer();
    a.hasMadeIngress = true;
    a.unlockVictimIngress(t.victimId);
    a.accessed.clear();
    a.setProne(true);
    const y = t.floorY + a.capRadius;
    a._setPose({ x: t.x - 0.3, y, z: t.z });
  }, target);
  await page.keyboard.down('x');
  await page.waitForTimeout(1500);
  await page.keyboard.up('x');
  await page.waitForTimeout(1000);
  report = await page.evaluate(() => ({
    score: window.__app.score(),
    reached: window.__app.victimsAccessed(),
    ops: window.__app.rescuerCompromised(),
    status: document.getElementById('status')?.textContent,
    loads: document.getElementById('loads')?.textContent,
  }));
}

console.log('USAR report:', report);

// Frame the triage bay on +X and screenshot.
await page.evaluate(() => {
  const { camera, controls, params } = window.__app;
  const edge = (params.buildingSize || 6) / 2 + 6;
  camera.position.set(edge + 4, 4, 2);
  controls.target.set(edge, 1.0, -2);
  controls.update();
});
await page.waitForTimeout(400);
await page.screenshot({ path: TRIAGE, fullPage: false });

// Also a pile overview.
await page.evaluate((t) => {
  const { camera, controls } = window.__app;
  camera.position.set(t.x + 8, t.y + 6, t.z + 8);
  controls.target.set(t.x, t.y + 0.5, t.z);
  controls.update();
}, target);
await page.waitForTimeout(300);
await page.screenshot({ path: OUT });

const triageKids = await page.evaluate(() => {
  // Count stretcher groups in the scene via __app if exposed; else DOM is useless for WebGL.
  // Walk three.js via the rescuer's sim is not enough — look at triage via a small hook.
  const g = window.__app;
  // Fallback: inspect THREE scene through camera's parent chain is fragile; report score only.
  return {
    reached: g.victimsAccessed(),
    score: g.score(),
  };
});

await browser.close();

const pass = triageKids.reached >= 1;
console.log(`\nscreenshots: ${OUT}`);
console.log(`             ${TRIAGE}`);
console.log(pass
  ? `PASS: scored victims reached = ${triageKids.reached} (net score ${triageKids.score})`
  : 'FAIL: never got victims reached ≥ 1');
console.log(`page errors: ${errors.length}`);
process.exit(pass && errors.length === 0 ? 0 : 1);
