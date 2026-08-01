// Where a rescuer can physically put a tool, and which way the resulting cut runs.
//
// WHY A SEPARATE MODULE?
// ---------------------
// Until now every tool in src/equipment.js was applied wherever the mouse ray happened to land:
// `apply(sim, { point })` took no agent at all, so a cutter could be used across the site, in
// mid-air, with no rescuer even spawned. The fix is a reach test, and a reach test is pure
// geometry — no three.js, no Rapier, no DOM. Keeping it here means:
//   * src/main.js (renderer) and src/rescuer.js (physics agent) can both import it;
//   * verify-reach.mjs can test the numbers headlessly in Node, like the other verify-*.mjs
//     scripts, without booting a browser.
//
// THE MODEL
// ---------
// A standing person's hand can be anywhere inside a SPHERE centred on the shoulder joint, with a
// radius of one arm (plus whatever the tool adds in front of the fist). That single sphere gives
// us both halves of the requirement for free:
//   * "walk up to it"  — the sphere is small (~1 m), so the player must actually walk the rescuer
//                        to the work face before the cursor will go green;
//   * "vertical reach" — a point overhead is inside the same sphere, so reaching up to a soffit
//                        needs no separate rule.
// On top of the sphere we add a FORWARD CONE, because nobody cuts concrete behind their own back.

import { CAPSULE_HALF, CAPSULE_RADIUS } from './rescuer-constants.js';

// ---------------------------------------------------------------------------
// Body geometry — all heights are measured from the SOLES OF THE BOOTS upward.
// ---------------------------------------------------------------------------

// The Rapier capsule's centre sits this far above the feet: half the cylindrical section plus one
// end-cap radius. src/rescuer.js computes feetY() as exactly this subtraction, so the two agree.
export const CAPSULE_CENTRE_HEIGHT = CAPSULE_HALF + CAPSULE_RADIUS;   // 0.84 m

// The shoulder pivot. In src/rescuer-mesh.js the arm Groups are parented at y = +0.28 relative to
// the capsule centre, so this number IS the mesh's shoulder — change one and change the other, or
// the held tool will float away from the arm that is supposed to be swinging it.
export const SHOULDER_HEIGHT = CAPSULE_CENTRE_HEIGHT + 0.28;          // 1.12 m above the soles

// Shoulder joint to fingertips. Chosen so that SHOULDER_HEIGHT + ARM_REACH reproduces the
// HAND_REACH = 2.15 m constant that src/rescuer.js already uses for jump-grabs; the rescuer must
// not be able to touch something with a tool that he could not touch with a bare hand.
export const ARM_REACH = 1.03;                                        // m
export const HAND_REACH_ABOVE_FEET = SHOULDER_HEIGHT + ARM_REACH;     // 2.15 m — sanity anchor

// Half-angle of the working cone, measured in plan (top view) from the direction the body faces.
// 60° each side is a comfortable turn of the torso without moving the feet; anything wider and the
// rescuer would be cutting sideways.
export const WORK_CONE_DEG = 60;
export const WORK_CONE_COS = Math.cos((WORK_CONE_DEG * Math.PI) / 180);

// Directly overhead or straight down between the boots there is no meaningful compass bearing to
// the target, and atan2 on a near-zero horizontal offset just returns noise. Inside this radius we
// skip the cone test entirely.
export const CONE_DEADZONE = 0.12;                                    // m, horizontal

// ---------------------------------------------------------------------------
// Cut-plane classification
// ---------------------------------------------------------------------------

// A "slab" and an "inclined wall" are the SAME part kind in this sim — src/sim.js builds every
// floor tile as kind 'slab', and a wall is simply one of those tiles that ended up standing on
// edge in the pile. What separates them is the surface normal of the face you are aiming at:
// a floor's face points up (or down), a wall's face points sideways. 45° is the natural divide.
export const FACE_TILT_DEG = 45;
export const FACE_TILT_COS = Math.cos((FACE_TILT_DEG * Math.PI) / 180); // 0.7071

// sim.cutHoleInSlab always cuts THROUGH the slab's local Y, i.e. through its thickness, because
// every slab is built as { hx: tileHalf, hy: thickness/2, hz: tileHalf }. So the tool must be
// presented to one of the two broad faces (±local Y). Aiming at the thin edge would ask for a hole
// bored along the length of the tile, which the geometry code cannot produce.
export const BROAD_FACE_MIN_DOT = 0.80;   // ≈ within 37° of square-on to the face

// ---------------------------------------------------------------------------
// Small vector helpers (plain objects, so Node can run this without three.js)
// ---------------------------------------------------------------------------

const sub = (a, b) => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });
const len = (v) => Math.hypot(v.x, v.y, v.z);
const dot = (a, b) => a.x * b.x + a.y * b.y + a.z * b.z;

/** Unit vector, or null for a zero-length input (callers must handle the degenerate case). */
export function normalize(v) {
  const l = len(v);
  if (l < 1e-9) return null;
  return { x: v.x / l, y: v.y / l, z: v.z / l };
}

/**
 * World position of the rescuer's right shoulder.
 *
 * @param {{x:number, z:number, feetY:number, yaw:number}} stance
 *        Where he is standing. `feetY` is RescuerAgent.feetY(); `yaw` is his heading in radians
 *        with 0 = +Z, matching the convention used everywhere else in this project.
 * @param {number} side  +1 for the right shoulder, -1 for the left, 0 for the neck/centre.
 */
export function shoulderOf(stance, side = 1) {
  // Facing unit vector in plan. yaw 0 = +Z, so forward = (sin yaw, cos yaw) and the rescuer's own
  // right hand is that vector turned 90° clockwise = (cos yaw, -sin yaw).
  const rx = Math.cos(stance.yaw);
  const rz = -Math.sin(stance.yaw);
  const offset = 0.28 * side;              // half the shoulder width, from the mesh's arm pivots
  return {
    x: stance.x + rx * offset,
    y: stance.feetY + SHOULDER_HEIGHT,
    z: stance.z + rz * offset,
  };
}

/**
 * Can the rescuer standing at `stance` put the business end of his tool on `point`?
 *
 * @param {{x:number, z:number, feetY:number, yaw:number}} stance
 * @param {{x:number, y:number, z:number}} point   the world point under the mouse cursor
 * @param {number} toolLength  how far the working edge sits beyond the fist (m). A disc cutter is
 *                             about 0.45 m of body + blade; a bare hand is 0.
 * @returns {{ok:boolean, reason:string, dist:number, maxDist:number, offBy:number,
 *            azimuthDeg:number, shoulder:{x:number,y:number,z:number}}}
 *          `reason` is 'ok' | 'out-of-reach' | 'behind', suitable for a HUD message.
 */
export function reachCheck(stance, point, toolLength = 0) {
  const shoulder = shoulderOf(stance, 1);
  const toPoint = sub(point, shoulder);
  const dist = len(toPoint);
  const maxDist = ARM_REACH + Math.max(0, toolLength);

  // 1. Is it inside the working sphere? This is the "walk closer" test.
  if (dist > maxDist) {
    return {
      ok: false, reason: 'out-of-reach', dist, maxDist,
      offBy: dist - maxDist, azimuthDeg: 0, shoulder,
    };
  }

  // 2. Is it in front of him? "In front" is a property of the TORSO, not of the shoulder joint, so
  //    the bearing is measured from the body axis. Measuring it from the (0.28 m offset) shoulder
  //    instead would report a point directly above his head as 85° off to one side and refuse it.
  //    Straight up / straight down (inside the deadzone) is always "in front" — you can reach a
  //    soffit above your head without turning to face anything.
  const flatX = point.x - stance.x;
  const flatZ = point.z - stance.z;
  const flatLen = Math.hypot(flatX, flatZ);
  let azimuthDeg = 0;
  if (flatLen > CONE_DEADZONE) {
    const fx = Math.sin(stance.yaw);
    const fz = Math.cos(stance.yaw);
    const cos = (flatX * fx + flatZ * fz) / flatLen;           // facing vector is already unit
    azimuthDeg = (Math.acos(Math.max(-1, Math.min(1, cos))) * 180) / Math.PI;
    if (cos < WORK_CONE_COS) {
      return { ok: false, reason: 'behind', dist, maxDist, offBy: 0, azimuthDeg, shoulder };
    }
  }

  return { ok: true, reason: 'ok', dist, maxDist, offBy: 0, azimuthDeg, shoulder };
}

/**
 * Heading (radians, 0 = +Z) that would square the rescuer up to a work point.
 * Returns null when the point is effectively on his own axis, where any heading is as good as
 * another and snapping would only make him spin on the spot.
 */
export function headingTo(stance, point) {
  const dx = point.x - stance.x;
  const dz = point.z - stance.z;
  if (Math.hypot(dx, dz) < CONE_DEADZONE) return null;
  return Math.atan2(dx, dz);
}

/**
 * Which way does the cut run on the face we are aiming at?
 *
 * The cut is made through the thickness of the tile, so the OPENING lies in the plane of the face.
 * A floor tile's face points up → the opening lies in a near-horizontal plane (you cut down into
 * the floor). A tile standing on edge as a wall has a face pointing sideways → the opening lies in
 * a near-vertical plane (you cut through the wall).
 *
 * @param {{x:number, y:number, z:number}} normal  world-space surface normal at the cursor
 * @returns {'horizontal'|'vertical'}
 */
export function cutPlaneOf(normal) {
  const n = normalize(normal);
  if (!n) return 'horizontal';
  return Math.abs(n.y) >= FACE_TILT_COS ? 'horizontal' : 'vertical';
}

/**
 * Is the cursor square-on to a broad face of the tile, rather than skimming its thin edge?
 *
 * @param {{x:number,y:number,z:number}} normal        world normal under the cursor
 * @param {{x:number,y:number,z:number}} thicknessAxis the tile's own local Y, rotated into world
 *                                                     space (the axis the hole is bored along)
 */
export function isBroadFace(normal, thicknessAxis) {
  const n = normalize(normal);
  const a = normalize(thicknessAxis);
  if (!n || !a) return false;
  // Absolute value: either broad face will do — top or bottom, near side or far side.
  return Math.abs(dot(n, a)) >= BROAD_FACE_MIN_DOT;
}

/** Human-readable explanation for a failed reachCheck, used verbatim in the HUD status line. */
export function reachMessage(res, toolLabel = 'tool') {
  if (res.ok) return '';
  if (res.reason === 'out-of-reach') {
    return `${toolLabel}: out of reach — walk ${res.offBy.toFixed(1)} m closer ` +
           `(working radius ${res.maxDist.toFixed(2)} m from the shoulder)`;
  }
  if (res.reason === 'behind') {
    return `${toolLabel}: that is ${res.azimuthDeg.toFixed(0)}° off your heading — turn to face it ` +
           `(you can work ${WORK_CONE_DEG}° either side)`;
  }
  return `${toolLabel}: cannot work there`;
}
