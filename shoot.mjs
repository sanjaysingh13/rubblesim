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

// cut a square hole via a real RIGHT-CLICK on the slab under the blade
await page.mouse.move(640, 500);
await page.mouse.click(640, 500, { button: 'right' });
await page.waitForTimeout(1500);              // plug drops + region re-settles
await page.evaluate(() => window.__app.doFreeze());
await page.waitForTimeout(300);
const status2 = await page.evaluate(() => document.getElementById('status')?.textContent);
const stats = await page.evaluate(() => { const s = window.__app.sim().stats; return { cuts: s.cuts, parts: window.__app.sim().parts.length }; });
await page.screenshot({ path: `${OUT}/cut_3_hole.png` });
console.log('after cut:', status2, JSON.stringify(stats));

// hide the void markers so the hole is visible, then zoom the camera onto it
await page.keyboard.press('v');
await page.evaluate(() => {
  const { camera, controls, lastCut } = window.__app;
  const p = lastCut();
  camera.position.set(p.x + 2.2, p.y + 1.8, p.z + 2.2);
  controls.target.set(p.x, p.y - 0.3, p.z);
  controls.update();
});
await page.waitForTimeout(400);
await page.screenshot({ path: `${OUT}/cut_4_closeup.png` });

await browser.close();
console.log('screenshots written to', OUT);
