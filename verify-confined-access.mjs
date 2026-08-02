// Headless tests for confined-access clearance + prone near-victim scoring.
// Run: node verify-confined-access.mjs

import RAPIER from '@dimforge/rapier3d-compat';
import { RescuerAgent, ACCESS_RADIUS, COMMIT_DURATION } from './src/rescuer.js';
import {
  CAPSULE_HALF, CAPSULE_RADIUS, PRONE_HEIGHT, PRONE_HALF, PRONE_RADIUS,
} from './src/rescuer-constants.js';
import { clearanceToVictim, debrisAabbsFromSim } from './src/confined-access.js';

let failed = 0;
function assert(cond, msg) {
  if (!cond) { console.log('FAIL:', msg); failed++; }
  else console.log('ok:', msg);
}

// ---- pure clearance ---------------------------------------------------------
{
  const voidRef = {
    x: 0, y: 0.45, z: 0, radius: 1.4, height: 0.75, floorY: 0.05, confined: true,
  };
  const victim = {
    id: 'v', x: 1.2, y: 0.12, z: 0, voidRef, ingressUnlocked: true,
  };
  const rescuer = { x: 0.1, y: 0.27, z: 0, feetY: 0.05 };

  assert(clearanceToVictim({
    rescuer, victim: { ...victim, ingressUnlocked: false }, voids: [voidRef],
  }).reason === 'no_ingress', 'no_ingress without unlock');

  assert(clearanceToVictim({
    rescuer, victim, voids: [voidRef],
    debrisAabbs: [{
      // Roof slab that defines the void — must NOT false-block when void is tall enough.
      minX: -2, maxX: 2, minY: 0.7, maxY: 0.95, minZ: -2, maxZ: 2,
    }],
  }).ok, 'roof AABB above a tall void does not block commit');

  assert(clearanceToVictim({
    rescuer, victim, voids: [],
    debrisAabbs: [{
      minX: 0.4, maxX: 0.8, minY: 0.1, maxY: 0.55, minZ: -0.3, maxZ: 0.3,
    }],
  }).reason === 'blocked', 'mid-corridor debris blocks when voids list is empty');

  assert(
    debrisAabbsFromSim({
      parts: [
        { kind: 'rescuer', agent: true, shape: { hx: 0.3, hy: 0.5, hz: 0.3 }, body: { translation: () => ({ x: 0, y: 1, z: 0 }) } },
        { kind: 'slab', shape: { hx: 1, hy: 0.1, hz: 1 }, body: { translation: () => ({ x: 0, y: 0.1, z: 0 }) } },
      ],
    }).length === 1,
    'debrisAabbsFromSim skips rescuer-tagged parts',
  );
}

await RAPIER.init();

function makeFloorSim() {
  const w = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
  const g = w.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(0, -0.5, 0));
  w.createCollider(RAPIER.ColliderDesc.cuboid(20, 0.5, 20), g);
  w.step();
  return {
    R: RAPIER, world: w, opts: { rescuerLoad: 1.2 }, phase: 'frozen', frame: null,
    rescue: { ladders: [] }, colliderToPart: new Map(), parts: [], voids: [],
    confinedVoids() { return this.voids; },
    _wakeNear() { return 0; },
  };
}

// ---- prone crawl up to victim scores without needing E ----------------------
{
  const sim = makeFloorSim();
  const agent = new RescuerAgent(sim, { x: 0, y: CAPSULE_HALF + CAPSULE_RADIUS + 0.05, z: 0 });
  agent.snapToGround();
  agent.setProne(true);

  const voidRef = {
    x: 1.0, y: 0.4, z: 0, radius: 1.2, height: 0.8, floorY: 0, confined: true,
  };
  sim.voids = [voidRef];
  agent.setVictims([{
    id: 'survivor', x: 1.0, y: 0.07, z: 0, voidRef, ingressUnlocked: false,
  }]);
  agent.accessed.clear();
  agent.drainEvents();

  // Elbow-crawl toward the victim over several frames (player agency).
  for (let i = 0; i < 90; i++) {
    agent.step(1 / 60, {
      prone: true,
      forward: true,
      camForward: { x: 1, z: 0 },
      camRight: { x: 0, z: 1 },
    });
  }
  assert(agent.accessedCount() === 0, 'crawling near without ingress never scores');

  agent.unlockVictimIngress('survivor');
  // Place so the prone body segment (not only the centre) reaches the victim.
  agent.yaw = 0; // face +Z; put victim along +X near the torso
  agent._setPose({ x: 1.0 - 0.5, y: PRONE_RADIUS, z: 0 });
  agent._checkVictimAccess();
  assert(agent.accessedCount() === 1, 'after ingress, prone nearness awards +1');

  const ev = agent.drainEvents().filter((e) => e.type === 'VICTIM_ACCESSED');
  assert(ev.length === 1, 'VICTIM_ACCESSED emitted for prone proximity');
  agent.dispose();
}

// ---- occupy void after hole ingress unlocks a far side pocket ---------------
{
  const sim = makeFloorSim();
  const agent = new RescuerAgent(sim, { x: 0, y: CAPSULE_HALF + CAPSULE_RADIUS + 0.05, z: 0 });
  agent.snapToGround();
  const farVoid = {
    x: 4.0, y: 0.4, z: 0, radius: 0.8, height: 0.7, floorY: 0, confined: true,
  };
  agent.setVictims([{ id: 'far', x: 4.0, y: 0.07, z: 0, voidRef: farVoid }]);
  // Go prone first so feetY uses the horizontal capsule, then plant in the far void.
  agent.setProne(true);
  agent.hasMadeIngress = true;
  agent._setPose({ x: 4.0, y: PRONE_RADIUS, z: 0 });
  agent._unlockVictimsInOccupiedVoid();
  assert(agent.victims[0].ingressUnlocked, 'occupying a void after ingress unlocks its survivor');
  agent._checkVictimAccess();
  assert(agent.accessedCount() === 1, 'prone on occupied-unlocked victim scores');
  agent.dispose();
}

// ---- side-void unlock from a hole 1.8 m away --------------------------------
{
  const sim = makeFloorSim();
  const agent = new RescuerAgent(sim, { x: 0, y: CAPSULE_HALF + CAPSULE_RADIUS + 0.05, z: 0 });
  const voidRef = {
    x: 1.8, y: 0.5, z: 0.2, radius: 0.6, height: 0.7, floorY: 0.1, confined: true,
  };
  agent.setVictims([{ id: 'side', x: 1.8, y: 0.17, z: 0.2, voidRef }]);
  agent._unlockVictimsNearOpening({ x: 0, y: 1.1, z: 0, radius: 0.3 });
  assert(agent.victims[0].ingressUnlocked, 'hole unlocks side void at 1.8 m (margin 2.5 m)');

  agent.setProne(true);
  agent._setPose({ x: 1.5, y: PRONE_RADIUS, z: 0.2 });
  agent._checkVictimAccess();
  assert(agent.accessedCount() === 1, 'prone approach after side-void unlock scores');
  agent.dispose();
}

// ---- E commit still works when void covers the path -------------------------
{
  const sim = makeFloorSim();
  const agent = new RescuerAgent(sim, { x: 0, y: CAPSULE_HALF + CAPSULE_RADIUS + 0.05, z: 0 });
  agent.snapToGround();
  agent.setProne(true);
  const voidRef = {
    x: 0.9, y: 0.4, z: 0, radius: 1.5, height: 0.85, floorY: 0, confined: true,
  };
  sim.voids = [voidRef];
  // Fake "roof" part that used to false-block every commit.
  sim.parts = [{
    kind: 'slab',
    shape: { hx: 2, hy: 0.12, hz: 2 },
    body: { translation: () => ({ x: 0.5, y: 0.85, z: 0 }) },
  }];
  agent.setVictims([{
    id: 'c1', x: 1.4, y: 0.07, z: 0, voidRef, ingressUnlocked: true,
  }]);
  agent.drainEvents();
  const started = agent._tryCommit();
  assert(started && agent.mode === 'commit', 'commit starts despite roof AABB in sim.parts');

  let scored = false;
  for (let i = 0; i < Math.ceil(COMMIT_DURATION * 60) + 15; i++) {
    agent.step(1 / 60, { prone: true, camForward: { x: 1, z: 0 }, camRight: { x: 0, z: 1 } });
    for (const e of agent.drainEvents()) {
      if (e.type === 'VICTIM_ACCESSED') scored = true;
    }
    if (scored) break;
  }
  assert(scored, 'commit completes with VICTIM_ACCESSED');
  assert(PRONE_HEIGHT < 0.5, 'prone envelope stays under 0.5 m');
  agent.dispose();
}

if (failed) {
  console.log(`\n${failed} assertion(s) failed`);
  process.exit(1);
}
console.log('\nverify-confined-access: all checks passed');
