// Freed rebar inside an opening must fall, not float on the parent slab mesh.
// Setup: slab with a through-breach and a spanning X-bar; snip the bar twice inside the
// opening so the middle segment is disconnected from concrete-anchored stubs.
// Run: node verify-rebar-fall.mjs
import RAPIER from '@dimforge/rapier3d-compat';
import { RubbleSim } from './src/sim.js';

await RAPIER.init();
const sim = new RubbleSim(RAPIER, { seed: 1 });
sim.build();

const slab = sim.parts.find((p) => !p.dead && p.kind === 'slab' && p.rebars?.length > 10);
if (!slab) { console.log('no slab with rebar — inconclusive'); process.exit(1); }

// Pretend a demolition-hammer through-hole at the tile centre (rebar left spanning).
const rOpen = 0.45;
slab.breach = {
  cx: 0, cz: 0, r: rOpen, depth: slab.shape.hy * 2,
  faceSign: 1, through: true, chips: 8,
};
slab.frame = [{ hx: 0.1, hy: slab.shape.hy, hz: 0.1, x: 0, y: 0, z: 0 }]; // mark as opened
sim._exposeRebar(slab);

// Pick a long X-bar that crosses the opening (runs through x=0 at |z| < r).
const bar = slab.rebars.find((d) => d.axis === 'x' && Math.abs(d.z) < rOpen * 0.5 && d.len > 1.0);
if (!bar) { console.log('no spanning X-bar — inconclusive'); process.exit(1); }
console.log(`spanning bar: axis=${bar.axis} z=${bar.z.toFixed(3)} len=${bar.len.toFixed(2)}`);

const t = slab.body.translation(), q = slab.body.rotation();
const rot = (qq, v) => {
  const tx = 2 * (qq.y * v.z - qq.z * v.y), ty = 2 * (qq.z * v.x - qq.x * v.z), tz = 2 * (qq.x * v.y - qq.y * v.x);
  return {
    x: v.x + qq.w * tx + (qq.y * tz - qq.z * ty),
    y: v.y + qq.w * ty + (qq.z * tx - qq.x * tz),
    z: v.z + qq.w * tz + (qq.x * ty - qq.y * tx),
  };
};
const worldAt = (local) => {
  const o = rot(q, local);
  return { x: t.x + o.x, y: t.y + o.y, z: t.z + o.z };
};

const partsBefore = sim.parts.length;
const rodsBefore = slab.rebars.length;

// Two snips inside the opening, either side of centre → frees the middle segment.
const cut1 = worldAt({ x: -0.15, y: bar.y, z: bar.z });
const cut2 = worldAt({ x: 0.15, y: bar.y, z: bar.z });
const r1 = sim.cutRebar(cut1, 0.4);
const r2 = sim.cutRebar(cut2, 0.4);

console.log(`snip 1: dropped=${r1.dropped} snipped=${r1.snippedRod}`);
console.log(`snip 2: dropped=${r2.dropped} snipped=${r2.snippedRod}`);
console.log(`rods on slab: ${rodsBefore} → ${slab.rebars.length}`);
console.log(`parts:        ${partsBefore} → ${sim.parts.length}`);

const droppedTotal = (r1.dropped || 0) + (r2.dropped || 0);
const newFrags = sim.parts.slice(partsBefore).filter((p) => p.rebars?.length && !p.fixed);

// Step so free bars actually move under gravity.
const y0 = newFrags.map((p) => p.body.translation().y);
for (let f = 0; f < 2 * 60; f++) sim.step();
const fell = newFrags.some((p, i) => p.body.translation().y < y0[i] - 0.05);

console.log(`free rebar frags: ${newFrags.length}  fell=${fell}`);

const ok = droppedTotal >= 1 && newFrags.length >= 1 && fell;
console.log(ok
  ? '\nPASS: disconnected rebar in the opening dropped and fell.'
  : '\nFAIL: expected freed rebar debris to spawn and fall under gravity.');
process.exit(ok ? 0 : 1);
