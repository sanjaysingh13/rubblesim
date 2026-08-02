// Headless verification of the USAR rescuer agent (walk / mantle band / ladder / intrusion exclude).
// Run: node verify-rescuer.mjs

import RAPIER from '@dimforge/rapier3d-compat';
import { RubbleSim } from './src/sim.js';
import {
  RescuerAgent, mantleRiseOk, agentTriggersCompromise, slopeOk,
  MANTLE_MIN, MANTLE_MAX, ACCESS_RADIUS, MAX_JUMP_LAND_H, MAX_HOLE_DROP, MAX_GRAB_H,
  JUMP_SPEED, GRAVITY, COMMIT_DURATION, COMMIT_REACH, PRONE_SPEED,
} from './src/rescuer.js';
import {
  CAPSULE_HALF, CAPSULE_RADIUS, CROUCH_HEIGHT, PRONE_HEIGHT,
} from './src/rescuer-constants.js';
import { clearanceToVictim } from './src/confined-access.js';

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
assert(MAX_HOLE_DROP === 2.5, 'hole drop cap is 2.5 m (rappel for deeper)');
assert(PRONE_HEIGHT < CROUCH_HEIGHT, `prone envelope ${PRONE_HEIGHT.toFixed(2)} m < crouch ${CROUCH_HEIGHT.toFixed(2)} m`);
assert(PRONE_HEIGHT < 0.5, 'prone height fits under ~0.5 m soffits');
assert(Math.abs(CROUCH_HEIGHT - 0.88) < 0.02, 'crouch height unchanged (~0.88 m)');
assert(PRONE_SPEED < 1.0, 'elbow-crawl is slower than upright crawl');
assert(COMMIT_DURATION >= 2 && COMMIT_DURATION <= 3.5, 'commit duration is a short 2–3.5 s squeeze');
assert(COMMIT_REACH >= 1.5 && COMMIT_REACH <= 3.5, 'commit reach is a short crawl assist');
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
if (voids.length) {
  assert(voids[0].floorY != null, 'detectVoids stores floorY for victim placement');
  assert(voids[0].floorY <= voids[0].y + 1e-6, 'floorY is at or below void centre');
  assert(typeof voids[0].confined === 'boolean', 'each void is marked confined or open');
}
assert(typeof sim.confinedVoids === 'function', 'confinedVoids() helper exists');
assert(
  sim.confinedVoids().every((v) => v.confined),
  'confinedVoids returns only confined pockets',
);

// ---- confine heuristic: open deck fails; walled pocket passes --------------------
{
  const deck = { x: 0, y: 0.6, z: 0, height: 1.2, floorY: 0.1, radius: 0.5 };
  // Open deck: no solids anywhere → rooftop reject (localTop stays at floorY).
  const openSolid = () => false;
  assert(!sim._isVoidConfined(deck, openSolid), 'open deck with no solids is not confined');

  // Walled pocket: solids on all 8 lateral spokes + a roof well above the floor.
  const walledSolid = (x, y, z) => {
    const dx = x - deck.x, dz = z - deck.z;
    const r = Math.hypot(dx, dz);
    if (y >= deck.floorY + 1.5 && r < 0.3) return true; // roof above pocket centre
    if (Math.abs(y - (deck.floorY + 0.45)) < 0.2 && r >= 0.4 && r <= 1.05) return true; // ring wall
    return false;
  };
  assert(sim._isVoidConfined(deck, walledSolid), 'pocket with 8-sided walls + roof is confined');
}
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

// ---- ingress gate: proximity alone must NOT score; unlock then proximity does ----------
{
  const voidRef = { x: 1, y: 1.2, z: 0, radius: 0.6, height: 1.2, floorY: 0.6 };
  const vy = voidRef.floorY + 0.07;
  agent.setVictims([{ id: 'v0', x: voidRef.x, y: vy, z: voidRef.z, voidRef }]);
  agent.accessed.clear();
  agent.drainEvents();
  agent._setPose({
    x: voidRef.x,
    y: vy + CAPSULE_HALF + CAPSULE_RADIUS,
    z: voidRef.z,
  });
  agent._checkVictimAccess();
  assert(agent.accessedCount() === 0, 'proximity without hole ingress does not score');
  agent.unlockVictimIngress('v0');
  agent._checkVictimAccess();
  assert(agent.accessedCount() === 1, 'ingress unlock + proximity scores VICTIM_ACCESSED');
  const accessedEv = agent.drainEvents().filter((e) => e.type === 'VICTIM_ACCESSED');
  assert(accessedEv.length === 1, 'emits exactly one VICTIM_ACCESSED after ingress');
}

// ---- clearanceToVictim pure helper ------------------------------------------
{
  const voidRef = {
    x: 0, y: 0.5, z: 0, radius: 1.2, height: 0.7, h: 0.7, floorY: 0.1, confined: true,
  };
  const victim = {
    id: 'c0', x: 1.0, y: 0.17, z: 0, voidRef, ingressUnlocked: true, lost: false,
  };
  const rescuer = { x: 0, y: 0.3, z: 0, feetY: 0.1 };
  const voids = [voidRef];

  assert(
    clearanceToVictim({ rescuer, victim: { ...victim, ingressUnlocked: false }, voids }).reason === 'no_ingress',
    'clearance rejects without ingress unlock',
  );
  assert(
    clearanceToVictim({
      rescuer, victim, voids, commitReach: 0.3,
    }).reason === 'too_far',
    'clearance rejects beyond commit reach',
  );
  // Debris only counts in gaps between voids — covered samples skip roof/floor AABBs.
  assert(
    clearanceToVictim({
      rescuer, victim, voids: [],
      debrisAabbs: [{ minX: 0.3, maxX: 0.7, minY: 0.15, maxY: 0.6, minZ: -0.4, maxZ: 0.4 }],
    }).reason === 'blocked',
    'clearance rejects blocking debris AABB when no void covers the path',
  );
  assert(
    clearanceToVictim({
      rescuer, victim, voids,
      debrisAabbs: [{ minX: 0.3, maxX: 0.7, minY: 0.15, maxY: 0.6, minZ: -0.4, maxZ: 0.4 }],
    }).ok === true,
    'clearance ignores structure AABBs inside a tall-enough void',
  );
  assert(
    clearanceToVictim({
      rescuer, victim: { ...victim, voidRef: { ...voidRef, h: 0.3, height: 0.3 } },
      voids: [{ ...voidRef, h: 0.3, height: 0.3 }],
    }).reason === 'too_tight',
    'clearance rejects void shorter than prone envelope',
  );
  const ok = clearanceToVictim({ rescuer, victim, voids, debrisAabbs: [] });
  assert(ok.ok, 'clearance passes for unlocked short clear path');
}

// ---- prone near victim: horizontal proximity scores (the playtest bug) -------
{
  const pw = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const pg = pw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  pw.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20), pg);
  pw.step();
  const pSim = {
    R: RAPIER, world: pw, opts: { rescuerLoad: 1.2 }, phase: 'frozen', frame: null,
    rescue: { ladders: [] }, colliderToPart: new Map(), parts: [], voids: [],
    confinedVoids() { return this.voids; },
    _wakeNear() { return 0; },
  };
  const nearAgent = new RescuerAgent(pSim, { x: 0, y: spawnY, z: 0 });
  nearAgent.snapToGround();
  nearAgent.setProne(true);

  const sideVoid = {
    x: 1.1, y: 0.35, z: 0, radius: 0.9, height: 0.7, h: 0.7, floorY: 0, confined: true,
  };
  pSim.voids = [sideVoid];
  // Victim ~1.1 m away horizontally; capsule centre Y differs from victim Y (old 3D
  // hypot burned ACCESS_RADIUS on ΔY and never scored).
  nearAgent.setVictims([{
    id: 'vNear', x: 1.1, y: 0.07, z: 0, voidRef: sideVoid, ingressUnlocked: false,
  }]);
  nearAgent.accessed.clear();
  nearAgent.drainEvents();

  // Plant prone centre ~0.7 m from victim (within ACCESS_RADIUS + prone radius).
  nearAgent._setPose({ x: 0.4, y: 0.0 + nearAgent.capRadius, z: 0 });

  nearAgent._checkVictimAccess();
  assert(nearAgent.accessedCount() === 0, 'prone near victim without ingress does not score');

  nearAgent.unlockVictimIngress('vNear');
  nearAgent._checkVictimAccess();
  assert(nearAgent.accessedCount() === 1,
    'prone + ingress + horizontal nearness scores VICTIM_ACCESSED');
  const nearEv = nearAgent.drainEvents().filter((e) => e.type === 'VICTIM_ACCESSED');
  assert(nearEv.length === 1, 'emits VICTIM_ACCESSED when crawling up to survivor');

  // Standing regression: capsule centre sits ~0.84 m above the victim mid-body.
  // Old 3D hypot used that ΔY and refused the score; horizontal band must still pass.
  nearAgent.accessed.clear();
  nearAgent.drainEvents();
  if (nearAgent.prone) {
    nearAgent._buildCapsuleCollider(CAPSULE_HALF, CAPSULE_RADIUS, { prone: false });
    nearAgent.crouched = false;
  }
  nearAgent._setPose({ x: 0.4, y: 0.07 + CAPSULE_HALF + CAPSULE_RADIUS, z: 0 });
  nearAgent.unlockVictimIngress('vNear');
  nearAgent._checkVictimAccess();
  assert(nearAgent.accessedCount() === 1,
    'standing above same floor still scores on horizontal proximity');
  nearAgent.dispose();
}

// ---- hole-column ingress unlock associates a side void -----------------------
{
  const voidRef = {
    x: 1.5, y: 0.5, z: 0, radius: 0.7, height: 0.8, floorY: 0.1, confined: true,
  };
  const opening = { x: 0, y: 1.0, z: 0, radius: 0.3 };
  agent.setVictims([{ id: 'vSide', x: 1.5, y: 0.17, z: 0, voidRef }]);
  agent.accessed.clear();
  agent.drainEvents();
  agent._unlockVictimsNearOpening(opening);
  assert(agent.victims[0].ingressUnlocked,
    'cut hole unlocks a side void within ~2 m lateral reach');
  agent._setPose({ x: 1.2, y: 0.17 + CAPSULE_HALF + CAPSULE_RADIUS, z: 0 });
  agent._checkVictimAccess();
  assert(agent.accessedCount() === 1, 'after side-void unlock, proximity scores');
}

// ---- prone capsule + assisted commit awards access --------------------------
{
  const pw = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const pg = pw.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  pw.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20), pg);
  pw.step();
  const pSim = {
    R: RAPIER, world: pw, opts: { rescuerLoad: 1.2 }, phase: 'frozen', frame: null,
    rescue: { ladders: [] }, colliderToPart: new Map(), parts: [], voids: [],
    confinedVoids() { return this.voids; },
    _wakeNear() { return 0; },
  };
  const pAgent = new RescuerAgent(pSim, { x: 0, y: spawnY, z: 0 });
  pAgent.snapToGround();
  pAgent.drainEvents();
  pAgent.setProne(true);
  assert(pAgent.prone, 'setProne builds horizontal capsule');
  assert(Math.abs(pAgent.capsuleHeight() - PRONE_HEIGHT) < 1e-6, 'prone capsuleHeight matches PRONE_HEIGHT');
  assert(pAgent.mode === 'prone', 'mode is prone after setProne');
  const proneEv = pAgent.drainEvents().filter((e) => e.type === 'RESCUER_PRONE' && e.prone);
  assert(proneEv.length === 1, 'emits RESCUER_PRONE on enter');

  const voidRef = {
    x: 0.8, y: 0.4, z: 0, radius: 1.5, height: 0.8, h: 0.8, floorY: 0, confined: true,
  };
  pSim.voids = [voidRef];
  pAgent.setVictims([{
    id: 'vCommit', x: 1.2, y: 0.07, z: 0, voidRef, ingressUnlocked: false,
  }]);
  pAgent.accessed.clear();
  pAgent.drainEvents();

  // Without ingress, E must fail with no_ingress (no silent score).
  pAgent._tryCommit();
  const failNoIngress = pAgent.drainEvents().filter((e) => e.type === 'COMMIT_FAIL');
  assert(failNoIngress.length === 1 && failNoIngress[0].reason === 'no_ingress',
    'commit without ingress emits COMMIT_FAIL no_ingress');
  assert(pAgent.accessedCount() === 0, 'failed commit does not score');

  pAgent.unlockVictimIngress('vCommit');
  pAgent._tryCommit();
  const startEv = pAgent.drainEvents().filter((e) => e.type === 'COMMIT_START');
  assert(startEv.length === 1, 'unlocked clear path starts COMMIT');
  assert(pAgent.mode === 'commit', 'mode switches to commit');

  let sawAccess = false;
  for (let i = 0; i < Math.ceil(COMMIT_DURATION * 60) + 10; i++) {
    pAgent.step(1 / 60, { camForward: { x: 1, z: 0 }, camRight: { x: 0, z: 1 } });
    for (const e of pAgent.drainEvents()) {
      if (e.type === 'VICTIM_ACCESSED') sawAccess = true;
    }
    if (sawAccess) break;
  }
  assert(sawAccess, 'successful commit awards VICTIM_ACCESSED');
  assert(pAgent.accessedCount() === 1, 'accessed set has the committed victim');
  pAgent.dispose();
}

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
