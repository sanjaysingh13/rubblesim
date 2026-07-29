// Headless verification of the hydraulic rebar cutter (no three.js).
// build -> collapse -> settle -> freeze, find an exposed rebar (a cracked tie between slabs),
// snip it, and confirm the two pieces separate without exploding. Run: node verify-rebar.mjs
import RAPIER from '@dimforge/rapier3d-compat';
import { RubbleSim } from './src/sim.js';

await RAPIER.init();
const sim = new RubbleSim(RAPIER, { seed: 1 });
sim.build(); sim.collapse();
for (let f = 0; f < 9 * 60; f++) sim.step();
sim.freeze();

const rebar = sim.joints.find((j) => j.type === 'tie' && j.cracked && !j.broken && !j.a.dead && !j.b.dead);
if (!rebar) { console.log('no exposed rebar (cracked tie) this seed — inconclusive'); process.exit(1); }
const a0 = rebar.a.body.translation(), b0 = rebar.b.body.translation();
const mid = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2, z: (a0.z + b0.z) / 2 };
const sep0 = Math.hypot(a0.x - b0.x, a0.y - b0.y, a0.z - b0.z);

// snapshot the woken region so we can report how much it shifts
const before = new Map();
for (const p of sim.parts) { const t = p.body.translation(); if (Math.hypot(t.x - mid.x, t.y - mid.y, t.z - mid.z) <= 1.5) before.set(p, { x: t.x, y: t.y, z: t.z }); }

const res = sim.cutRebar(mid, 0.4);

let maxAbs = 0;
for (let f = 0; f < 4 * 60; f++) {
  sim.step();
  for (const p of sim.parts) { const t = p.body.translation(); maxAbs = Math.max(maxAbs, Math.abs(t.x), Math.abs(t.y), Math.abs(t.z)); }
}
let maxMove = 0;
for (const [p, b] of before) { if (p.dead) { maxMove = Math.max(maxMove, 1); continue; } const t = p.body.translation(); maxMove = Math.max(maxMove, Math.hypot(t.x - b.x, t.y - b.y, t.z - b.z)); }

console.log(`rebar snipped:   severed=${res.severed} woken=${res.woken}`);
console.log(`joint broken:    ${rebar.broken}`);
console.log(`nearby movement: ${maxMove.toFixed(3)} m  (settled pile shifts little; the cut is the point)`);
console.log(`max |coord|:     ${maxAbs.toFixed(1)} m  (explosion check)`);

const exploded = maxAbs > 60;
const ok = res.severed === 1 && rebar.broken && !exploded;
console.log(exploded ? '\nFAIL: exploded after rebar cut.' :
  ok ? '\nPASS: hydraulic cutter found and snipped the exposed rebar (hinge broken), no explosion.' :
       '\nFAIL: expected the exposed rebar to be found and snipped.');
process.exit(ok ? 0 : 1);
