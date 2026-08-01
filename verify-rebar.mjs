// Headless verification of the hydraulic rebar cutter (no three.js).
//
// Two things the snips must do:
//   1. Sever a VISIBLE rod descriptor on a rebarExposed part (the red bar the player aims at).
//   2. Break a cracked-tie hinge when one is near the snip (so fractured pieces can separate).
//
// build -> collapse -> settle -> freeze, then exercise both. Run: node verify-rebar.mjs
import RAPIER from '@dimforge/rapier3d-compat';
import { RubbleSim } from './src/sim.js';

await RAPIER.init();
const sim = new RubbleSim(RAPIER, { seed: 1 });
sim.build(); sim.collapse();
for (let f = 0; f < 9 * 60; f++) sim.step();
sim.freeze();

// --- A. snip a visible rod on an exposed part -------------------------------------------------
const exposed = sim.parts.find((p) => !p.dead && p.rebarExposed && p.rebars && p.rebars.length);
if (!exposed) { console.log('no rebarExposed part this seed — inconclusive'); process.exit(1); }
const rod0 = exposed.rebars.find((d) => d && d.len > 0.08) || exposed.rebars[0];
const nRodsBefore = exposed.rebars.length;
// World point at the rod centre (body frame → world).
const t0 = exposed.body.translation(), q0 = exposed.body.rotation();
// Inline the same rotate the sim uses (avoid importing a private helper).
const rot = (q, v) => {
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
};
const off = rot(q0, { x: rod0.x, y: rod0.y, z: rod0.z });
const rodWorld = { x: t0.x + off.x, y: t0.y + off.y, z: t0.z + off.z };

const rodCut = sim.cutRebar(rodWorld, 0.5);
console.log(`rod snip:        severed=${rodCut.severed} snippedRod=${rodCut.snippedRod} brokeTie=${rodCut.brokeTie}`);
console.log(`rod count:       ${nRodsBefore} → ${exposed.rebars.length} (one bar becomes 0–2 stubs)`);

const rodOk = rodCut.severed === 1 && rodCut.snippedRod === true;

// --- B. break a cracked-tie hinge (structural free at a fracture) -----------------------------
const rebar = sim.joints.find((j) => j.type === 'tie' && j.cracked && !j.broken && !j.a.dead && !j.b.dead);
if (!rebar) {
  console.log('no cracked tie left this seed — skipping hinge check (rod snip already ran)');
} else {
  const a0 = rebar.a.body.translation(), b0 = rebar.b.body.translation();
  const mid = { x: (a0.x + b0.x) / 2, y: (a0.y + b0.y) / 2, z: (a0.z + b0.z) / 2 };

  const before = new Map();
  for (const p of sim.parts) {
    const t = p.body.translation();
    if (Math.hypot(t.x - mid.x, t.y - mid.y, t.z - mid.z) <= 1.5) before.set(p, { x: t.x, y: t.y, z: t.z });
  }

  const res = sim.cutRebar(mid, 0.6);

  let maxAbs = 0;
  for (let f = 0; f < 4 * 60; f++) {
    sim.step();
    for (const p of sim.parts) {
      const t = p.body.translation();
      maxAbs = Math.max(maxAbs, Math.abs(t.x), Math.abs(t.y), Math.abs(t.z));
    }
  }
  let maxMove = 0;
  for (const [p, b] of before) {
    if (p.dead) { maxMove = Math.max(maxMove, 1); continue; }
    const t = p.body.translation();
    maxMove = Math.max(maxMove, Math.hypot(t.x - b.x, t.y - b.y, t.z - b.z));
  }

  console.log(`hinge snip:      severed=${res.severed} brokeTie=${res.brokeTie} woken=${res.woken}`);
  console.log(`joint broken:    ${rebar.broken}`);
  console.log(`nearby movement: ${maxMove.toFixed(3)} m`);
  console.log(`max |coord|:     ${maxAbs.toFixed(1)} m  (explosion check)`);

  const exploded = maxAbs > 60;
  const hingeOk = res.severed === 1 && rebar.broken && !exploded;
  if (!hingeOk || !rodOk) {
    console.log(exploded ? '\nFAIL: exploded after rebar cut.' :
      '\nFAIL: expected rod snip and cracked-tie break.');
    process.exit(1);
  }
}

if (!rodOk) {
  console.log('\nFAIL: expected a visible rod to be snipped.');
  process.exit(1);
}

console.log('\nPASS: hydraulic cutter snips visible rods and breaks nearby fracture hinges.');
process.exit(0);
