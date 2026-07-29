// Quick look at the STANDING building (columns intact) to assess rebar visibility.
import { chromium } from 'playwright';
import { homedir } from 'node:os';
const OUT = homedir();
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const p = await b.newPage({ viewport: { width: 1280, height: 800 } });
await p.goto('http://localhost:5173/?test=1', { waitUntil: 'load' });
await p.waitForFunction(() => window.__app, null, { timeout: 20000 });
// keep it standing: big standSeconds, then rebuild (P)
await p.evaluate(() => { window.__app.params.standSeconds = 9999; });
await p.keyboard.press('p');
await p.waitForTimeout(800);
await p.evaluate(() => { const { camera, controls } = window.__app; camera.position.set(7, 6, 9); controls.target.set(0, 4, 0); controls.update(); });
await p.waitForTimeout(300);
await p.screenshot({ path: `${OUT}/look_standing.png` });
console.log('phase:', await p.evaluate(() => window.__app.phase()));
await b.close();
console.log('wrote look_standing.png');
