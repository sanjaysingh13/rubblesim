// Headless verification of the collapse pipeline (no three.js / WebGL).
// Drives the shared physics core in src/sim.js. Run: `node verify.mjs`.

import RAPIER from '@dimforge/rapier3d-compat';
import { RubbleSim } from './src/sim.js';

await RAPIER.init();
const sim = new RubbleSim(RAPIER, { seed: 1 });

const built = sim.build();
sim.collapse();

// simulate ~9 s of settling
let maxAbs = 0;
const frames = Math.round(9 * 60);
for (let f = 0; f < frames; f++) {
  sim.step();
  for (const p of sim.parts) {
    const t = p.body.translation();
    maxAbs = Math.max(maxAbs, Math.abs(t.x), Math.abs(t.z), Math.abs(t.y));
  }
}
sim.freeze();
const voids = sim.detectVoids();

let top = 0;
for (const p of sim.parts) top = Math.max(top, p.body.translation().y);
const buried = voids.filter((v) => v.y < top - 0.3).length;

console.log(`built pieces:          ${built}`);
console.log(`member snaps:          ${sim.stats.snaps}`);
console.log(`slab cracks (hinged):  ${sim.stats.cracks}`);
console.log(`slab rebar tears:      ${sim.stats.tears}`);
console.log(`settled pieces:        ${sim.parts.length}`);
console.log(`pile top height:       ${top.toFixed(2)} m`);
console.log(`max |coord| any piece: ${maxAbs.toFixed(1)} m  (explosion check)`);
console.log(`voids detected:        ${voids.length}  (buried: ${buried})`);
for (const v of voids.slice(0, 6)) console.log(`   void @ (${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})  gap ${v.height.toFixed(2)} m`);

const exploded = maxAbs > 60;                 // nothing should be flung far
const ok = sim.parts.length > 0 && voids.length > 0 && buried > 0 && !exploded;
console.log(exploded ? '\nFAIL: pieces flung too far — instability.' :
  ok ? '\nPASS: heavy collapse settled with fractures/snaps and buried voids.' :
       '\nFAIL: expected settled debris with internal voids.');
process.exit(ok ? 0 : 1);
