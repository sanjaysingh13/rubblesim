// Headless verification of the concrete cutter's square-hole ingress (no three.js).
// build -> collapse -> settle -> freeze, then cut a square hole in a slab tile and confirm
// the plug drops and the tile becomes a 4-box frame, without exploding. Run: node verify-hole.mjs

import RAPIER from '@dimforge/rapier3d-compat';
import { RubbleSim } from './src/sim.js';

await RAPIER.init();
const sim = new RubbleSim(RAPIER, { seed: 1 });
sim.build(); sim.collapse();
for (let f = 0; f < 9 * 60; f++) sim.step();
sim.freeze();

const partsBefore = sim.parts.length;
// pick a slab tile that sits ABOVE a detected void, so the plug can drop into the ingress
const voids = sim.detectVoids();
const slabs = sim.parts.filter((p) => p.kind === 'slab' && !p.frame);
let slab = null, best = 1e9;
for (const v of voids) {
  for (const p of slabs) {
    const t = p.body.translation();
    if (t.y <= v.y + 0.2) continue;                        // slab must be above the void
    const d = Math.hypot(t.x - v.x, t.z - v.z);
    if (d < 1.0 && t.y - v.y < best) { best = t.y - v.y; slab = p; }
  }
}
if (!slab) slab = slabs.reduce((a, b) => (b.body.translation().y > a.body.translation().y ? b : a), slabs[0]);

const res = sim.cutHoleInSlab(slab, 0, 0, 0.3, 0.3);   // 0.6 m square in the tile centre
const plug = res && res.plug;
const plugY0 = plug ? plug.body.translation().y : null;

let maxAbs = 0;
for (let f = 0; f < 4 * 60; f++) {
  sim.step();
  for (const p of sim.parts) { const t = p.body.translation(); maxAbs = Math.max(maxAbs, Math.abs(t.x), Math.abs(t.y), Math.abs(t.z)); }
}
const plugY1 = plug && !plug.dead ? plug.body.translation().y : (plug ? -99 : null);
const plugDrop = plug ? (plugY0 - plugY1) : 0;

console.log(`slab frame boxes:    ${slab.frame ? slab.frame.length : 0}  (hole cut into the tile)`);
console.log(`slab colliders now:  ${slab.colliders.length}`);
console.log(`plug spawned:        ${plug ? 'yes' : 'no'}   startY=${plugY0 && plugY0.toFixed(2)}  drop=${plugDrop.toFixed(2)} m`);
console.log(`parts: before=${partsBefore}  after=${sim.parts.length}`);
console.log(`max |coord|:         ${maxAbs.toFixed(1)} m  (explosion check)`);

const exploded = maxAbs > 60;
const ok = !!plug && slab.frame && slab.frame.length >= 3 && slab.colliders.length >= 3 && plugDrop > 0.05 && !exploded;
console.log(exploded ? '\nFAIL: exploded after hole cut.' :
  ok ? '\nPASS: square hole opened, plug dropped, tile became a frame, no explosion.' :
       '\nFAIL: expected a hole + dropping plug.');
process.exit(ok ? 0 : 1);
