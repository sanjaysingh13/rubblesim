// Headless verification of the USAR rescuer agent (walk / mantle band / ladder / intrusion exclude).
// Run: node verify-rescuer.mjs

import RAPIER from '@dimforge/rapier3d-compat';
import { RubbleSim } from './src/sim.js';
import {
  RescuerAgent, mantleRiseOk, agentTriggersCompromise, slopeOk,
  MANTLE_MIN, MANTLE_MAX, ACCESS_RADIUS, MAX_JUMP_LAND_H, MAX_GRAB_H,
  JUMP_SPEED, GRAVITY,
} from './src/rescuer.js';
import { CAPSULE_HALF, CAPSULE_RADIUS } from './src/rescuer-constants.js';

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.log('FAIL:', msg); failed++; }
  else console.log('ok:', msg);
}

// ---- pure helpers ----------------------------------------------------------
assert(mantleRiseOk(2.2), `2.2 m rise is within pull-up band [${MANTLE_MIN}, ${MANTLE_MAX}]`);
assert(mantleRiseOk(6.5), `6.5 m rise is within grab band (max ${MAX_GRAB_H} m)`);
assert(!mantleRiseOk(7.5), '7.5 m rise is above grab band');
assert(!mantleRiseOk(0.5), '0.5 m rise is below pull-up band (use autostep / walk)');
assert(slopeOk(0, 1, 0), 'flat floor slope OK');
assert(slopeOk(0, Math.cos(25 * Math.PI / 180), Math.sin(25 * Math.PI / 180)), '25° incline OK');
assert(!slopeOk(0, Math.cos(40 * Math.PI / 180), Math.sin(40 * Math.PI / 180)), '40° incline rejected');
assert(MAX_JUMP_LAND_H === 1.0, 'jump land height cap is 1 m');
assert(!agentTriggersCompromise({ agent: true }), 'agent-tagged part must not trigger compromise');
assert(!agentTriggersCompromise({ rescuer: true }), 'rescuer-tagged part must not trigger compromise');
assert(!agentTriggersCompromise({ victim: true }), 'victim-tagged part must not trigger compromise');
assert(!agentTriggersCompromise({ ladder: true }), 'ladder-tagged part must not trigger compromise');
assert(agentTriggersCompromise({ kind: 'slab' }), 'ordinary debris still triggers compromise');

await RAPIER.init();

// ---- spawn agent on a simple box stack and walk ----------------------------
const sim = new RubbleSim(RAPIER, { seed: 2, stories: 2, buildingSize: 4, grid: 2, furniturePerFloor: 0 });
sim.build();
sim.collapse();
for (let f = 0; f < 5 * 60; f++) sim.step();
sim.freeze();

const spawnY = CAPSULE_HALF + CAPSULE_RADIUS + 0.05;
const agent = new RescuerAgent(sim, { x: (sim.opts.buildingSize / 2) + 2, y: spawnY, z: 0 });
const t0 = agent.translation();

// Walk toward the pile for a short burst (camera-forward = -X).
for (let i = 0; i < 90; i++) {
  agent.step(1 / 60, {
    forward: true,
    camForward: { x: -1, z: 0 },
    camRight: { x: 0, z: 1 },
    loadkN: 1.2,
  });
}
const t1 = agent.translation();
const moved = Math.hypot(t1.x - t0.x, t1.z - t0.z);
assert(moved > 0.5, `rescuer walked ~${moved.toFixed(2)} m toward the pile`);
assert(agent.part.rescuer === true, 'rescuer part is tagged');
assert(sim.colliderToPart.get(agent.collider.handle) === agent.part, 'collider map registers rescuer');

// ---- mantle probe against a fixture wall -----------------------------------
// Build an isolated world with a tall box so findMantleTarget can see a 2.2 m ledge.
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const ground = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.05, 0));
world.createCollider(RAPIER.ColliderDesc.cuboid(5, 0.05, 5), ground);
const wallBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 1.1, -1.2));
const wallCol = world.createCollider(RAPIER.ColliderDesc.cuboid(1.0, 1.1, 0.2), wallBody); // top at y=2.2
world.step();

const fixtureSim = {
  R: RAPIER,
  world,
  opts: { rescuerLoad: 1.2 },
  phase: 'frozen',
  frame: null,
  rescue: { ladders: [] },
  colliderToPart: new Map(),
  _wakeNear() { return 0; },
};
fixtureSim.colliderToPart.set(wallCol.handle, { body: wallBody, kind: 'slab', dead: false });

const fixtureAgent = new RescuerAgent(fixtureSim, { x: 0, y: spawnY, z: 0.1 });
fixtureAgent.yaw = Math.PI; // face -Z toward the wall
const target = fixtureAgent.findMantleTarget();
assert(!!target, 'mantle finds a ~2.2 m ledge on the fixture wall');
if (target) assert(target.rise >= MANTLE_MIN && target.rise <= MANTLE_MAX, `mantle rise ${target?.rise?.toFixed(2)} m in band`);

// Reject an 8 m wall as a mantle target (above MAX_GRAB_H = 7 m).
const tallBody = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(2, 4.0, -1.2));
const tallCol = world.createCollider(RAPIER.ColliderDesc.cuboid(0.8, 4.0, 0.2), tallBody); // top at y=8
world.step();
fixtureSim.colliderToPart.set(tallCol.handle, { body: tallBody, kind: 'slab', dead: false });
const tallAgent = new RescuerAgent(fixtureSim, { x: 2, y: spawnY, z: 0.1 });
tallAgent.yaw = Math.PI;
const tallTarget = tallAgent.findMantleTarget();
assert(!tallTarget, '8 m wall is rejected for pull-up (above 7 m grab limit)');

// ---- ladder mount moves agent along axis -----------------------------------
const ladder = {
  active: true,
  base: { x: 5, y: 0, z: 0 },
  top: { x: 5, y: 3.5, z: 0 },
  normal: { x: 1, y: 0, z: 0 },
  length: 3.5,
};
fixtureSim.rescue.ladders = [ladder];
const climbAgent = new RescuerAgent(fixtureSim, { x: 5.3, y: 1.0, z: 0 });
climbAgent.mode = 'ladder';
climbAgent.ladderRide = { ladder, t: 0.2 };
const yBefore = climbAgent.translation().y;
for (let i = 0; i < 60; i++) {
  climbAgent.step(1 / 60, { forward: true, loadkN: 1.2 });
}
const yAfter = climbAgent.translation().y;
assert(yAfter > yBefore + 0.4, `ladder climb raised agent ${(yAfter - yBefore).toFixed(2)} m`);

// ---- agent overlapping a void AABB does NOT count as compromise ------------
const voids = sim.detectVoids();
let agentWouldCompromise = false;
if (voids.length && agent.part) {
  // Place agent inside first void and run the same AABB test as main.js, with exclusions.
  const v = voids[0];
  agent._setPose({ x: v.x, y: v.y, z: v.z });
  const part = agent.part;
  const t = part.body.translation(), s = part.shape;
  const overlaps =
    Math.abs(t.x - v.x) < v.radius + s.hx &&
    Math.abs(t.z - v.z) < v.radius + s.hz &&
    Math.abs(t.y - v.y) < v.height / 2 + s.hy;
  if (overlaps && agentTriggersCompromise(part)) agentWouldCompromise = true;
}
assert(!agentWouldCompromise, 'rescuer inside a void AABB does not alone fire SURVIVOR_COMPROMISED');

// Victim access distance constant is sane.
assert(ACCESS_RADIUS > 0.3 && ACCESS_RADIUS < 1.5, `ACCESS_RADIUS=${ACCESS_RADIUS} m is a touch range`);

// ---- frozen-world solid collision (no world.step between moves) -------------
// Soft freeze skips world.step(); without query-pipeline sync the KCC ghosts through
// solids. This fixture never steps after the agent is created — same as gameplay.
{
  const fw = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const fg = fw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  fw.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20), fg);
  const wallB = fw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, 1.0, -2));
  fw.createCollider(RAPIER.ColliderDesc.cuboid(2, 1.0, 0.25), wallB);
  fw.step();

  const fSim = {
    R: RAPIER, world: fw, opts: { rescuerLoad: 1.2 }, phase: 'frozen', frame: null,
    rescue: { ladders: [] }, colliderToPart: new Map(), _wakeNear() { return 0; },
  };
  const fAgent = new RescuerAgent(fSim, { x: 0, y: spawnY, z: 1.5 });
  fAgent.snapToGround();
  assert(fAgent.locoReady && Math.abs(fAgent.feetY()) < 0.15, 'snap latches grounded on frozen floor');

  // Idle — must not spontaneously enter jump / climb away.
  for (let i = 0; i < 45; i++) {
    fAgent.step(1 / 60, { camForward: { x: 0, z: -1 }, camRight: { x: 1, z: 0 } });
  }
  assert(fAgent.mode !== 'jump', `idle after spawn stays grounded (mode=${fAgent.mode})`);
  assert(fAgent.feetY() > -0.05, `idle does not fall through floor (feetY=${fAgent.feetY().toFixed(3)})`);

  const z0 = fAgent.translation().z;
  for (let i = 0; i < 120; i++) {
    fAgent.step(1 / 60, {
      forward: true,
      camForward: { x: 0, z: -1 },
      camRight: { x: 1, z: 0 },
    });
  }
  const z1 = fAgent.translation().z;
  assert(z1 > -1.55, `frozen KCC blocked by wall (z ${z0.toFixed(2)} → ${z1.toFixed(2)}, not through)`);
  assert(z1 < z0 - 0.3, `walked toward wall before stopping (Δz=${(z0 - z1).toFixed(2)})`);
  fAgent.dispose();
}

// ---- jump → grab → pull-up on a 2.2 m ledge (frozen, no world.step) ----------
{
  const jw = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const jg = jw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  jw.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20), jg);
  const ledgeTop = 2.2;
  const hy = ledgeTop / 2;
  const ledgeBody = jw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, hy, -0.95));
  const ledgeCol = jw.createCollider(RAPIER.ColliderDesc.cuboid(1.2, hy, 0.25), ledgeBody);
  jw.step();

  const jSim = {
    R: RAPIER, world: jw, opts: { rescuerLoad: 1.2 }, phase: 'frozen', frame: null,
    rescue: { ladders: [] }, colliderToPart: new Map(), _wakeNear() { return 0; },
  };
  jSim.colliderToPart.set(ledgeCol.handle, { body: ledgeBody, kind: 'slab', dead: false });

  const jAgent = new RescuerAgent(jSim, { x: 0, y: spawnY, z: 0.7 });
  jAgent.snapToGround();
  jAgent.yaw = Math.PI; // face -Z toward the ledge
  // Close the gap so the jump-grab face probes can see the wall.
  for (let i = 0; i < 20; i++) {
    jAgent.step(1 / 60, { forward: true, camForward: { x: 0, z: -1 }, camRight: { x: 1, z: 0 } });
  }
  jAgent.drainEvents();

  let sawJump = false, sawMantleStart = false, sawMantleDone = false, mantleRise = 0;
  for (let i = 0; i < 200; i++) {
    jAgent.step(1 / 60, {
      forward: true,
      jump: i === 0,
      camForward: { x: 0, z: -1 },
      camRight: { x: 1, z: 0 },
    });
    for (const e of jAgent.drainEvents()) {
      if (e.type === 'RESCUER_JUMP') sawJump = true;
      if (e.type === 'MANTLE_START') { sawMantleStart = true; mantleRise = e.rise; }
      if (e.type === 'MANTLE_DONE') sawMantleDone = true;
    }
    if (sawMantleDone) break;
  }
  assert(sawJump, 'Space starts a jump before grab');
  assert(sawMantleStart, 'jump grab starts mantle on ~2.2 m ledge');
  assert(mantleRise >= MANTLE_MIN && mantleRise <= MANTLE_MAX, `mantle rise ${mantleRise.toFixed(2)} m in grab band`);
  assert(sawMantleDone, 'mantle pull-up completes (MANTLE_DONE)');
  assert(jAgent.feetY() > ledgeTop - 0.15, `feet planted on ledge after pull-up (feetY=${jAgent.feetY().toFixed(2)})`);
  jAgent.dispose();

  // Unreachable during a standing jump: 4 m ledge, hands only reach ~2.9 m at apex.
  const tallTop = 4.0;
  const thy = tallTop / 2;
  const tallBody = jw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(3, thy, -1.0));
  const tallCol = jw.createCollider(RAPIER.ColliderDesc.cuboid(1.0, thy, 0.3), tallBody);
  jSim.colliderToPart.set(tallCol.handle, { body: tallBody, kind: 'slab', dead: false });
  const apexFeet = (JUMP_SPEED * JUMP_SPEED) / (2 * GRAVITY);
  const highAgent = new RescuerAgent(jSim, { x: 3, y: spawnY, z: 0.45 });
  highAgent.snapToGround();
  highAgent.yaw = Math.PI;
  highAgent.jumpOrigin = { x: 3, y: spawnY, z: 0.45, feetY: 0.02 };
  highAgent.mode = 'jump';
  highAgent.wasGrounded = false;
  highAgent.locoReady = true;
  highAgent._setPose({
    x: 3,
    y: apexFeet + CAPSULE_HALF + CAPSULE_RADIUS,
    z: 0.4,
  });
  assert(!highAgent._findJumpGrab(), '4 m ledge rejected — hands cannot reach at jump apex');
  highAgent.dispose();
}

agent.dispose();
fixtureAgent.dispose();
tallAgent.dispose();
climbAgent.dispose();
sim.dispose();

if (failed) {
  console.log(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nverify-rescuer: all checks passed');
