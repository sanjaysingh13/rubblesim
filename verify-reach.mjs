// Headless verification of the rescuer's tool reach envelope (no three.js, no Rapier).
// src/rescuer-reach.js is deliberately pure geometry so it can be checked like this.
// Run: node verify-reach.mjs
//
// What we are protecting:
//   * a tool may only be used at arm's length, so the player has to WALK the rescuer to the work
//     face instead of clicking across the site;
//   * reaching straight up still works (soffit / underside of a slab) without a special case;
//   * nothing can be cut behind his back;
//   * a floor tile gives a horizontal cut plane and a tile standing on edge a vertical one;
//   * the envelope agrees with the jump-grab reach src/rescuer.js already uses — a rescuer must
//     not be able to touch with a tool what he could not touch with a bare hand.

import {
  ARM_REACH, SHOULDER_HEIGHT, HAND_REACH_ABOVE_FEET, WORK_CONE_DEG,
  reachCheck, headingTo, cutPlaneOf, isBroadFace, shoulderOf,
} from './src/rescuer-reach.js';
import { HAND_REACH } from './src/rescuer.js';

const CUTTER = 0.45;                       // m of disc-cutter body + blade beyond the fist
const stance = { x: 0, z: 0, feetY: 0, yaw: 0 };   // standing at the origin, facing +Z

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass });
  console.log(`${pass ? 'ok  ' : 'FAIL'}  ${name}${detail ? `   ${detail}` : ''}`);
};

// --- 1. the envelope agrees with the agent's own bare-hand reach ------------------------------
const anchorErr = Math.abs(HAND_REACH_ABOVE_FEET - HAND_REACH);
check('shoulder + arm reproduces rescuer.js HAND_REACH', anchorErr < 1e-9,
  `${SHOULDER_HEIGHT.toFixed(2)} + ${ARM_REACH.toFixed(2)} = ${HAND_REACH_ABOVE_FEET.toFixed(2)} m ` +
  `vs HAND_REACH ${HAND_REACH}`);

// --- 2. the work face he is standing at ------------------------------------------------------
const atFeet = reachCheck(stance, { x: 0, y: 0, z: 0.5 }, CUTTER);
check('floor 0.5 m in front is reachable', atFeet.ok,
  `dist ${atFeet.dist.toFixed(2)} m of ${atFeet.maxDist.toFixed(2)} m`);

// --- 3. clicking across the site is refused --------------------------------------------------
const faraway = reachCheck(stance, { x: 0, y: 0, z: 3 }, CUTTER);
check('a slab 3 m away is out of reach',
  !faraway.ok && faraway.reason === 'out-of-reach' && faraway.offBy > 1.5,
  `dist ${faraway.dist.toFixed(2)} m, walk ${faraway.offBy.toFixed(2)} m closer`);

// --- 4. vertical reach: a soffit overhead, no special case needed -----------------------------
const overhead = reachCheck(stance, { x: 0.05, y: 2.3, z: 0.02 }, CUTTER);
check('underside of a slab 2.3 m up is reachable', overhead.ok,
  `dist ${overhead.dist.toFixed(2)} m of ${overhead.maxDist.toFixed(2)} m`);

// A ceiling beyond the raised tool is not.
const tooHigh = reachCheck(stance, { x: 0, y: 3.0, z: 0 }, CUTTER);
check('a soffit 3.0 m up is out of reach', !tooHigh.ok && tooHigh.reason === 'out-of-reach',
  `dist ${tooHigh.dist.toFixed(2)} m`);

// --- 5. nothing gets cut behind his back ------------------------------------------------------
const behind = reachCheck(stance, { x: 0, y: 0, z: -0.8 }, CUTTER);
check('a point behind him is refused even though it is close',
  !behind.ok && behind.reason === 'behind',
  `${behind.azimuthDeg.toFixed(0)}° off heading, cone is ±${WORK_CONE_DEG}°`);

// ...and turning to face it fixes exactly that.
const turned = { ...stance, yaw: headingTo(stance, { x: 0, y: 0, z: -0.8 }) };
const afterTurn = reachCheck(turned, { x: 0, y: 0, z: -0.8 }, CUTTER);
check('turning to face it makes the same point valid', afterTurn.ok,
  `new heading ${((turned.yaw * 180) / Math.PI).toFixed(0)}°`);

// --- 6. the working sphere really is a sphere centred on the shoulder -------------------------
// Sample the horizon at shoulder height all the way round; every bearing inside the cone must
// agree with the plain distance test, and the shoulder must sit on the correct side of the body.
const sh = shoulderOf(stance, 1);
check('right shoulder is offset to the rescuer\'s right', sh.x > 0.2 && Math.abs(sh.z) < 1e-9,
  `shoulder at (${sh.x.toFixed(2)}, ${sh.y.toFixed(2)}, ${sh.z.toFixed(2)})`);

// Sweep the working cone at chest height: everything at 0.8 m in front must be workable at any
// bearing inside the cone, and nothing at 2.5 m may be, whichever way he is turned.
let nearAllOk = true, farAllRefused = true;
for (let deg = -WORK_CONE_DEG + 5; deg <= WORK_CONE_DEG - 5; deg += 5) {
  const a = (deg * Math.PI) / 180;
  const at = (d) => ({ x: Math.sin(a) * d, y: sh.y, z: Math.cos(a) * d });
  if (!reachCheck(stance, at(0.8), CUTTER).ok) nearAllOk = false;
  if (reachCheck(stance, at(2.5), CUTTER).ok) farAllRefused = false;
}
check('every bearing inside the cone is workable at 0.8 m', nearAllOk);
check('no bearing inside the cone is workable at 2.5 m', farAllRefused);

// --- 7. cut plane follows the face you present the tool to ------------------------------------
check('a floor tile cuts in a horizontal plane', cutPlaneOf({ x: 0, y: 1, z: 0 }) === 'horizontal');
check('a tile on edge cuts in a vertical plane', cutPlaneOf({ x: 1, y: 0, z: 0 }) === 'vertical');
// A slab tipped 20° off flat is still a floor to work on; one leaning 70° is a wall.
const tilt = (deg) => ({ x: Math.sin((deg * Math.PI) / 180), y: Math.cos((deg * Math.PI) / 180), z: 0 });
check('a slab tipped 20° still cuts horizontally', cutPlaneOf(tilt(20)) === 'horizontal');
check('a slab leaning 70° cuts vertically', cutPlaneOf(tilt(70)) === 'vertical');

// --- 8. the hole is bored through the thickness, so aim at a broad face ------------------------
check('square-on to the broad face is accepted', isBroadFace({ x: 0, y: 1, z: 0 }, { x: 0, y: 1, z: 0 }));
check('the underside of the same tile is accepted', isBroadFace({ x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 }));
check('the thin edge of a tile is refused', !isBroadFace({ x: 1, y: 0, z: 0 }, { x: 0, y: 1, z: 0 }));

const failed = checks.filter((c) => !c.pass);
console.log(`\n${checks.length - failed.length}/${checks.length} reach checks passed`);
console.log(failed.length ? 'FAIL: reach envelope is wrong.' : 'PASS: tool reach envelope behaves.');
process.exit(failed.length ? 1 : 0);
