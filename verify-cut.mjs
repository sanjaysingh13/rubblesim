// Headless verification of the concrete cutter (no three.js / WebGL).
// build -> collapse -> settle -> freeze -> detectVoids (V0), then apply a cut and confirm
// the rubble re-settles into a new equilibrium (pieces move) without exploding. Deterministic.
// Run: node verify-cut.mjs

import RAPIER from '@dimforge/rapier3d-compat';
import { RubbleSim } from './src/sim.js';

await RAPIER.init();
const sim = new RubbleSim(RAPIER, { seed: 1 });
sim.build();
sim.collapse();
for (let f = 0; f < 9 * 60; f++) sim.step();
sim.freeze();
const V0 = sim.detectVoids().length;
const cracksBefore = sim.stats.cracks;

// choose a cut point at a still-RIGID concrete seam (an un-cracked tie): its midpoint, with a
// normal aligned to the two tiles so they straddle the cut plane (guarantees a real cut).
const rigid = sim.joints.find((j) => j.type === 'tie' && !j.cracked && !j.broken && !j.a.dead && !j.b.dead)
  || sim.joints.find((j) => j.type === 'member' && !j.cracked && !j.broken && j.member.kind === 'column' && !j.a.dead && !j.b.dead);
if (!rigid) { console.log('no rigid concrete joint left to cut — inconclusive'); process.exit(1); }
const pa0 = rigid.a.body.translation(), pb0 = rigid.b.body.translation();
const point = { x: (pa0.x + pb0.x) / 2, y: (pa0.y + pb0.y) / 2, z: (pa0.z + pb0.z) / 2 };
const normal = { x: pb0.x - pa0.x, y: pb0.y - pa0.y, z: pb0.z - pa0.z };
const reach = 1.6;   // a substantial cut severing several seams (user can pick smaller/larger)

// snapshot pre-cut positions of the pieces that will be woken
const wake = Math.max(reach, sim.opts.wakeRadius);
const before = new Map();
for (const p of sim.parts) {
  const t = p.body.translation();
  if (Math.hypot(t.x - point.x, t.y - point.y, t.z - point.z) <= wake) before.set(p, { x: t.x, y: t.y, z: t.z });
}

const res = sim.cut(point, normal, reach);

// re-settle
let maxAbs = 0;
for (let f = 0; f < 4 * 60; f++) {
  sim.step();
  for (const p of sim.parts) { const t = p.body.translation(); maxAbs = Math.max(maxAbs, Math.abs(t.x), Math.abs(t.y), Math.abs(t.z)); }
}
sim.freeze();
const V1 = sim.detectVoids().length;

let maxMove = 0;
for (const [p, b] of before) {
  if (p.dead) { maxMove = Math.max(maxMove, 1); continue; }
  const t = p.body.translation();
  maxMove = Math.max(maxMove, Math.hypot(t.x - b.x, t.y - b.y, t.z - b.z));
}

console.log(`cut result:          severed=${res.severed} woken=${res.woken}`);
console.log(`concrete joints cut: ${sim.stats.cracks - cracksBefore}`);
console.log(`max piece movement:  ${maxMove.toFixed(3)} m  (equilibrium change)`);
console.log(`max |coord|:         ${maxAbs.toFixed(1)} m  (explosion check)`);
console.log(`voids: before=${V0}  after=${V1}`);

const exploded = maxAbs > 60;
const ok = sim.stats.cuts >= 1 && res.severed > 0 && maxMove > 0.01 && !exploded;
console.log(exploded ? '\nFAIL: pieces flung too far after cut.' :
  ok ? '\nPASS: cut severed concrete and the rubble re-settled into a new equilibrium.' :
       '\nFAIL: expected a severing cut that shifts the rubble.');
process.exit(ok ? 0 : 1);
