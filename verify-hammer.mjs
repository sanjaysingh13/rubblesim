// Headless check of the demolition hammer progressive breach.
// build → collapse → settle → freeze → chip a slab until through, confirm rebar still present.
// Run: node verify-hammer.mjs
import RAPIER from '@dimforge/rapier3d-compat';
import { RubbleSim } from './src/sim.js';

await RAPIER.init();
const sim = new RubbleSim(RAPIER, { seed: 1 });
sim.build(); sim.collapse();
for (let f = 0; f < 9 * 60; f++) sim.step();
sim.freeze();

const slab = sim.parts
  .filter((p) => !p.dead && p.kind === 'slab' && !p.frame)
  .sort((a, b) => b.body.translation().y - a.body.translation().y)[0];
if (!slab) { console.log('no intact slab — inconclusive'); process.exit(1); }

const t = slab.body.translation();
const rodsBefore = (slab.rebars || []).length;
console.log(`target slab @ (${t.x.toFixed(2)}, ${t.y.toFixed(2)}, ${t.z.toFixed(2)})  rods=${rodsBefore}`);

let last = null;
for (let i = 0; i < 20; i++) {
  last = sim.chipBreach(slab, { x: t.x, y: t.y + slab.shape.hy, z: t.z });
  if (!last.chipped) break;
  if (last.through && last.radius >= 0.3) break;
}
console.log(`after chips: through=${last.through} r=${last.radius?.toFixed(3)} depthFrac=${last.depthFrac?.toFixed(2)} chips=${last.chips}`);
console.log(`rods after:  ${slab.rebars?.length} (must stay — hammer does not cut rebar)`);
console.log(`frame boxes: ${slab.frame?.length || 0}`);
console.log(`rebarExposed: ${!!slab.rebarExposed}`);

const ok = last.chipped && last.through && slab.frame && slab.rebarExposed
  && (slab.rebars?.length || 0) >= rodsBefore * 0.9;
console.log(ok
  ? '\nPASS: hammer opened a through-hole with rebar still spanning.'
  : '\nFAIL: expected through-hole with intact rebar cage.');
process.exit(ok ? 0 : 1);
