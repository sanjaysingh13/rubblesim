// Headless verification of the contact-based equilibrium check (support / tip / slip).
//
// The rubble pile used to be "settled" by raycasting downwards at freeze time and deleting or
// kicking anything that looked unsupported. That produced a visible second collapse and still
// left floaters. The check verified here instead reads Rapier's narrow phase — real contact
// points, normals and solver impulses — so it can tell a genuinely floating piece from one that
// is legitimately wedged, tied by rebar, or carrying debris from above.
//
// Run: node verify-equilibrium.mjs

import RAPIER from '@dimforge/rapier3d-compat';
import { RubbleSim } from './src/sim.js';

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.log('FAIL:', msg); failed++; }
  else console.log('ok:', msg);
}

await RAPIER.init();

// ---------------------------------------------------------------------------------------------
// Fixtures: a bare world we can hand-place single bodies into, so each physical situation is
// isolated. `build()` gives us the ground plane; everything it constructed is then removed.
// ---------------------------------------------------------------------------------------------
function harness() {
  const sim = new RubbleSim(RAPIER, { seed: 1, stories: 1, grid: 2, furniturePerFloor: 0 });
  sim.build();
  for (const p of [...sim.parts]) sim._removePart(p);
  sim.parts.length = 0;
  sim.joints.length = 0;
  sim.phase = 'collapsing';
  return sim;
}

// Minimal part record — the equilibrium check only needs the body, its colliders and its shape.
function addBox(sim, { x, y, z, hx, hy, hz, rotZ = 0, mu = 0.65, fixed = false }) {
  const desc = (fixed ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic())
    .setTranslation(x, y, z);
  // A rotation about Z tilts the box in the X/Y plane — that is our "ramp" angle.
  if (rotZ) desc.setRotation({ x: 0, y: 0, z: Math.sin(rotZ / 2), w: Math.cos(rotZ / 2) });
  const body = sim.world.createRigidBody(desc);
  const col = sim.world.createCollider(
    RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(mu).setDensity(2.4), body,
  );
  const part = {
    body, col, colliders: [col], shape: { hx, hy, hz },
    kind: 'slab', dead: false, fixed, friction: mu,
  };
  sim.parts.push(part);
  return part;
}

const run = (sim, frames) => { for (let i = 0; i < frames; i++) sim.step(); };

// Reproduce the old freeze bug: stop a piece dead and put it to sleep wherever it happens to be.
// Contact impulses need a few steps to build up before they mean anything, hence the settle.
function forceSleep(sim, part, settleFrames = 6) {
  run(sim, settleFrames);
  part.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
  part.body.setAngvel({ x: 0, y: 0, z: 0 }, false);
  part.body.sleep();
}

// ---- 1. flat on the ground: the trivial stable case -------------------------------------------
{
  const sim = harness();
  const p = addBox(sim, { x: 0, y: 0.31, z: 0, hx: 0.5, hy: 0.3, hz: 0.5 });
  run(sim, 120);
  assert(sim._equilibriumOf(p).state === 'stable', 'slab flat on the ground reads stable');
  assert(sim.isSettled(), 'a single resting slab counts as a settled pile');
  sim.dispose();
}

// ---- 2. asleep in mid-air: the floating-solids bug --------------------------------------------
{
  const sim = harness();
  const p = addBox(sim, { x: 0, y: 4, z: 0, hx: 0.5, hy: 0.3, hz: 0.5 });
  sim.world.step();
  p.body.setLinvel({ x: 0, y: 0, z: 0 }, false);
  p.body.sleep();
  assert(sim._equilibriumOf(p).state === 'unsupported', 'slab asleep in mid-air reads unsupported');
  assert(sim._wakeUnstable() === 1, 'the equilibrium sweep wakes the floating slab');
  run(sim, 120);
  assert(p.body.translation().y < 0.5, 'once woken it falls to the ground under gravity alone');
  assert(sim._equilibriumOf(p).state === 'stable', 'and then reads stable');
  sim.dispose();
}

// ---- 3. overhanging a block: CoG outside the footprint ----------------------------------------
{
  const sim = harness();
  addBox(sim, { x: 0, y: 0.5, z: 0, hx: 0.5, hy: 0.5, hz: 0.5, fixed: true });
  // Only 5 cm of the slab sits on the block; its centre of gravity is 45 cm past the edge.
  const p = addBox(sim, { x: 0.95, y: 1.31, z: 0, hx: 0.5, hy: 0.3, hz: 0.5 });
  forceSleep(sim, p);
  const eq = sim._equilibriumOf(p);
  assert(eq.state === 'tipping', `slab overhanging a block reads tipping (got ${eq.state})`);
  assert(eq.margin < 0, 'its centre of gravity is outside the support polygon');
  assert(sim._wakeUnstable() === 1, 'the equilibrium sweep wakes the overhanging slab');
  run(sim, 200);
  assert(p.body.translation().y < 0.9, 'once woken gravity tips it off the block');
  sim.dispose();
}

// ---- 4. friction: the same slope holds or sheds a slab depending on μ -------------------------
// A block on an incline slides when tan(α) > μ. With μ = 0.35 the friction angle is ~19°.
function rampCase(angleDeg, mu) {
  const sim = harness();
  const a = -angleDeg * Math.PI / 180;
  addBox(sim, { x: 0, y: 1, z: 0, hx: 3, hy: 0.2, hz: 3, rotZ: a, mu, fixed: true });
  const p = addBox(sim, { x: 0, y: 1.42, z: 0, hx: 0.4, hy: 0.2, hz: 0.4, rotZ: a, mu });
  forceSleep(sim, p);
  const eq = sim._equilibriumOf(p);
  sim.dispose();
  return eq;
}
{
  const steep = rampCase(40, 0.35);
  assert(steep.state === 'slipping', `40° face with μ=0.35 reads slipping (got ${steep.state})`);
  const shallow = rampCase(10, 0.35);
  assert(shallow.state === 'stable', `10° face with μ=0.35 reads stable (got ${shallow.state})`);
  const grippy = rampCase(30, 0.65);
  assert(grippy.state === 'stable', `30° face with μ=0.65 still holds (got ${grippy.state})`);
}

// ---------------------------------------------------------------------------------------------
// Whole-pile behaviour: collapse a real building, then check that freezing changes nothing.
// ---------------------------------------------------------------------------------------------
const sim = new RubbleSim(RAPIER, { seed: 2, stories: 3, buildingSize: 6, grid: 3, furniturePerFloor: 3 });
sim.build();
sim.collapse();
for (let f = 0; f < 8 * 60; f++) sim.step();
sim.settleToEquilibrium(8);

const report = sim.equilibriumReport({ samples: 5 });
console.log('pile census:', JSON.stringify(report));
assert(report.unsupported === 0, 'no piece is left floating with nothing carrying it');
assert(report.failing <= Math.ceil(report.total * 0.02),
  `at most 2% of pieces fail equilibrium (${report.failing}/${report.total})`);

// Freezing must be a pure "stop here": no re-simulation, no joint surgery, no deletions.
const before = new Map();
for (const p of sim.parts) {
  if (!p.dead) {
    const t = p.body.translation();
    before.set(p, { x: t.x, y: t.y, z: t.z });
  }
}
const partsBefore = sim.parts.filter((p) => !p.dead).length;
const jointsBefore = sim.joints.filter((j) => !j.broken).length;

sim.freeze();

let maxMove = 0;
for (const [p, t0] of before) {
  if (p.dead) continue;
  const t = p.body.translation();
  maxMove = Math.max(maxMove, Math.hypot(t.x - t0.x, t.y - t0.y, t.z - t0.z));
}
assert(maxMove < 1e-6, `freeze moves nothing (max ${maxMove.toFixed(6)} m)`);
assert(sim.parts.filter((p) => !p.dead).length === partsBefore, 'freeze deletes no debris');
assert(sim.joints.filter((j) => !j.broken).length === jointsBefore, 'freeze breaks no rebar ties');
assert(sim.equilibrium && sim.equilibrium.total > 0, 'freeze records an equilibrium census');
assert(sim.parts.every((p) => p.dead || p.body.isSleeping()), 'every frozen piece is asleep');

sim.dispose();
console.log(failed ? `\n${failed} FAILED` : '\nall equilibrium checks passed');
process.exit(failed ? 1 : 0);
