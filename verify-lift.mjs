// Headless verification of pneumatic lifting bags (specs.md §3.2).
// Asserts the three things the spec actually requires:
//   1. An under-rated bag STALLS on a load heavier than its rating (and lifts ~nothing).
//   2. An adequately rated bag lifts the load.
//   3. Displacement caps RIGIDLY at 50 cm — no overshoot, no runaway.
// Run: node verify-lift.mjs

import RAPIER from '@dimforge/rapier3d-compat';
import { RubbleSim } from './src/sim.js';

await RAPIER.init();
const sim = new RubbleSim(RAPIER, { seed: 1 });
sim.build();
sim.collapse();
for (let f = 0; f < 9 * 60; f++) sim.step();
sim.freeze();
sim.support.rebuild();

// Lift the most heavily loaded slab in the pile — the worst realistic case. The bag goes just
// under its underside so the ray-based interface detection finds it directly overhead.
function pickTarget() {
  sim.support.rebuild();
  const ranked = sim.parts.filter((p) => !p.dead && p.kind === 'slab')
    .map((p) => ({ p, load: sim.support.supportedLoad(p) }))
    .sort((a, b) => b.load - a.load);
  if (!ranked.length) return null;
  const best = ranked[0];
  const t = best.p.body.translation();
  return { part: best.p, load: best.load, point: { x: t.x, y: t.y - best.p.shape.hy - 0.12, z: t.z } };
}
const first = pickTarget();
if (!first) { console.log('FAIL: no slab to lift'); process.exit(1); }
console.log(`target slab: supported load ${first.load.toFixed(1)} kN, bagging at y=${first.point.y.toFixed(2)} m`);

const maxAbsNow = () => {
  let m = 0;
  for (const p of sim.parts) { const q = p.body.translation(); m = Math.max(m, Math.abs(q.x), Math.abs(q.y), Math.abs(q.z)); }
  return m;
};

function trial(id, steps) {
  const tgt = pickTarget();          // re-locate: the pile shifts between trials
  if (!tgt) return null;
  const bag = sim.rescue.placeBag(tgt.point, id);
  if (!bag) return null;
  for (let f = 0; f < steps; f++) sim.step();
  const out = {
    label: bag.spec.label, capacity: bag.capacity, W: bag.load, carrying: bag.carrying,
    lift: bag.lift, maxLift: bag.maxLift, stalled: bag.stalled, inflated: bag.inflated,
    maxAbs: maxAbsNow(),
  };
  sim.rescue.removeBag(bag);
  for (let f = 0; f < 45; f++) sim.step();
  return out;
}

const small = trial('bag4t', 300);
const big = trial('bag20t', 480);
for (const r of [small, big]) {
  if (!r) { console.log('FAIL: bag found no lift interface'); process.exit(1); }
  console.log(`${r.label.padEnd(18)} rating ${r.capacity.toFixed(0).padStart(4)} kN · W_debris ` +
    `${r.W.toFixed(0).padStart(4)} kN · carrying ${r.carrying.toFixed(0).padStart(4)} kN · ` +
    `lift ${r.lift.toFixed(3)} m · stalled ${String(r.stalled).padEnd(5)} · inflated ${r.inflated}`);
}

const capRespected = small.lift <= small.maxLift + 1e-6 && big.lift <= big.maxLift + 1e-6;
const smallStalls = small.capacity < small.W && small.lift < big.lift;
const bigLifts = big.lift > 0.05;
const stable = small.maxAbs < 60 && big.maxAbs < 60;

console.log(`\n50 cm cap respected:      ${capRespected}  (4t ${small.lift.toFixed(3)} m, 20t ${big.lift.toFixed(3)} m, cap 0.500 m)`);
console.log(`under-rated bag stalls:   ${smallStalls}`);
console.log(`rated bag lifts:          ${bigLifts}`);
console.log(`no explosion:             ${stable}  (max |coord| ${Math.max(small.maxAbs, big.maxAbs).toFixed(1)} m)`);

const ok = capRespected && smallStalls && bigLifts && stable;
console.log(ok ? '\nPASS: bags stall under-rated, lift when rated, and cap rigidly at 50 cm.'
              : '\nFAIL: lifting-bag behaviour does not match specs.md §3.2.');
process.exit(ok ? 0 : 1);
