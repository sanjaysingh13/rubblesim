// Procedural Civil Defence / USAR rescuer (and simple victim) meshes for three.js.
//
// WHY PROCEDURAL?
// ---------------
// This project has no GLTF / texture asset pipeline — every tool cursor and piece of debris is
// built from primitives + CanvasTexture. The rescuer follows the same rule so the sim stays a
// single Vite bundle with zero external art.
//
// COORDINATE CONVENTION
// ---------------------
// The Group's origin sits at the PHYSICS CAPSULE CENTRE (mid-torso height). Feet hang below
// that origin by CAPSULE_HALF + CAPSULE_RADIUS so the mesh lines up with the Rapier capsule in
// src/rescuer.js. Call syncRescuerMesh(group, body, yaw, walkPhase) each frame.

import * as THREE from 'three';
import { CAPSULE_RADIUS, CAPSULE_HALF, RESCUER_HEIGHT } from './rescuer-constants.js';

// Re-export so callers can import dimensions from either module.
export { CAPSULE_RADIUS, CAPSULE_HALF, RESCUER_HEIGHT };

const FLESH = 0xc68642;
const ORANGE = 0xe85d04;
const HELMET = 0xc1121f;
const BOOT = 0x1a1a1a;
const VICTIM_CLOTH = 0x2c333a;

/**
 * Paint a canvas with bold "CIVIL DEFENCE" text on an orange field.
 * CanvasTexture lets us emblazon the tee without shipping an image file — the GPU just samples
 * this 2D canvas as if it were a photo of a printed shirt.
 */
function makeCivilDefenceTexture() {
  const s = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  // Solid high-vis orange base (same hue as the torso material so seams don't show).
  g.fillStyle = '#e85d04';
  g.fillRect(0, 0, s, s);
  // Dark navy lettering — reads as a stamped Civil Defence unit marking.
  g.fillStyle = '#1a2744';
  g.font = `bold ${Math.round(s * 0.11)}px system-ui, sans-serif`;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText('CIVIL', s * 0.5, s * 0.42);
  g.fillText('DEFENCE', s * 0.5, s * 0.58);
  const tex = new THREE.CanvasTexture(cv);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * Procedural digi-camo for the trousers: scatter rectangular patches of olive / khaki / brown
 * over a dark green field. Real camo is photographic; this is a readable stand-in that still
 * reads as "military trousers" at sim camera distances.
 */
function makeCamoTexture() {
  const s = 256;
  const cv = document.createElement('canvas');
  cv.width = cv.height = s;
  const g = cv.getContext('2d');
  g.fillStyle = '#3d4a2e';
  g.fillRect(0, 0, s, s);
  const palette = ['#5a6b3a', '#8a7a4a', '#4a3a28', '#6b7a50', '#2e3820'];
  // Deterministic-ish scatter (no Math.random in a texture builder — keep rebuilds stable).
  let n = 1;
  const rnd = () => { n = (n * 16807) % 2147483647; return (n - 1) / 2147483646; };
  for (let i = 0; i < 90; i++) {
    g.fillStyle = palette[Math.floor(rnd() * palette.length)];
    const w = 8 + rnd() * 28;
    const h = 6 + rnd() * 22;
    g.fillRect(rnd() * s, rnd() * s, w, h);
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(2, 2);
  tex.anisotropy = 4;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function mat(color, extras = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.75, metalness: 0.05, ...extras });
}

/**
 * Build one dressed USAR rescuer as a THREE.Group.
 * Parts are named so walk-bob can swing arms/legs without a full skeleton.
 */
export function createRescuerMesh() {
  // Root group: origin = capsule centre. Children are positioned relative to that.
  const root = new THREE.Group();
  root.name = 'rescuer';

  const shirtTex = makeCivilDefenceTexture();
  const camoTex = makeCamoTexture();
  const shirtMat = new THREE.MeshStandardMaterial({
    map: shirtTex, color: 0xffffff, roughness: 0.7, metalness: 0.02,
  });
  // Back/sides stay solid orange (map only on front would need UVs; a uniform orange + map
  // tint is fine — the text still reads on the chest faces of the box).
  const camoMat = new THREE.MeshStandardMaterial({
    map: camoTex, color: 0xffffff, roughness: 0.85, metalness: 0.02,
  });
  const fleshMat = mat(FLESH);
  const helmetMat = mat(HELMET, { roughness: 0.45 });
  const bootMat = mat(BOOT, { roughness: 0.9 });

  // Vertical layout (metres relative to capsule centre at y=0):
  //   feet ≈ -(half+radius) … head ≈ +(half+radius)
  const footY = -(CAPSULE_HALF + CAPSULE_RADIUS);

  // --- legs (camo trousers) -------------------------------------------------
  // Each leg is a Group so we can rotate at the hip for a simple walk cycle.
  const leftLeg = new THREE.Group();
  leftLeg.name = 'leftLeg';
  leftLeg.position.set(-0.11, footY + 0.55, 0);
  const leftThigh = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.55, 0.2), camoMat);
  leftThigh.position.y = -0.2;
  leftThigh.castShadow = true;
  leftLeg.add(leftThigh);
  const leftBoot = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.14, 0.28), bootMat);
  leftBoot.position.set(0, -0.52, 0.04);
  leftBoot.castShadow = true;
  leftLeg.add(leftBoot);
  root.add(leftLeg);

  const rightLeg = new THREE.Group();
  rightLeg.name = 'rightLeg';
  rightLeg.position.set(0.11, footY + 0.55, 0);
  const rightThigh = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.55, 0.2), camoMat);
  rightThigh.position.y = -0.2;
  rightThigh.castShadow = true;
  rightLeg.add(rightThigh);
  const rightBoot = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.14, 0.28), bootMat);
  rightBoot.position.set(0, -0.52, 0.04);
  rightBoot.castShadow = true;
  rightLeg.add(rightBoot);
  root.add(rightLeg);

  // --- torso (orange Civil Defence tee) -------------------------------------
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.55, 0.26), shirtMat);
  torso.name = 'torso';
  torso.position.y = 0.12;
  torso.castShadow = true;
  root.add(torso);

  // --- head + red helmet ----------------------------------------------------
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.12, 12, 10), fleshMat);
  head.position.y = 0.52;
  head.castShadow = true;
  root.add(head);
  // Hard hat: short cylinder sitting on the skull (USAR red).
  const helmet = new THREE.Mesh(new THREE.CylinderGeometry(0.14, 0.15, 0.12, 14), helmetMat);
  helmet.position.y = 0.60;
  helmet.castShadow = true;
  root.add(helmet);
  // Small brim for silhouette.
  const brim = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.18, 0.025, 14), helmetMat);
  brim.position.y = 0.55;
  root.add(brim);

  // --- arms -----------------------------------------------------------------
  const leftArm = new THREE.Group();
  leftArm.name = 'leftArm';
  leftArm.position.set(-0.28, 0.28, 0);
  const leftUpper = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.45, 0.12), shirtMat);
  leftUpper.position.y = -0.18;
  leftUpper.castShadow = true;
  leftArm.add(leftUpper);
  const leftHand = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.09), fleshMat);
  leftHand.position.y = -0.44;
  leftArm.add(leftHand);
  root.add(leftArm);

  const rightArm = new THREE.Group();
  rightArm.name = 'rightArm';
  rightArm.position.set(0.28, 0.28, 0);
  const rightUpper = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.45, 0.12), shirtMat);
  rightUpper.position.y = -0.18;
  rightUpper.castShadow = true;
  rightArm.add(rightUpper);
  const rightHand = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.1, 0.09), fleshMat);
  rightHand.position.y = -0.44;
  rightArm.add(rightHand);

  // Where a selected tool gets clipped into the right fist.
  //
  // Props from src/tool-mesh.js are modelled with their grip at the origin and their working end
  // along +Z. An arm hangs along its own -Y, so rotating the mount +90° about X maps that +Z onto
  // -Y: whichever way the arm is swung or aimed, the tool points down the arm and out of the fist.
  const toolMount = new THREE.Group();
  toolMount.name = 'toolMount';
  toolMount.position.y = -0.46;
  toolMount.rotation.x = Math.PI / 2;
  rightArm.add(toolMount);
  root.add(rightArm);

  // Stash limb handles for the walk-bob updater.
  root.userData.limbs = { leftLeg, rightLeg, leftArm, rightArm };
  root.userData.toolMount = toolMount;
  root.userData.shirtTex = shirtTex;
  root.userData.camoTex = camoTex;
  return root;
}

/**
 * Simple prone victim figure placed at a void centre. No kit — dark clothing only.
 * Origin at mid-body; lay flat so they read as someone trapped in the pocket.
 */
export function createVictimMesh() {
  const root = new THREE.Group();
  root.name = 'victim';
  const cloth = mat(VICTIM_CLOTH);
  const flesh = mat(FLESH);
  // Body along +Z when prone (lying on back in the void).
  const torso = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.14, 0.55), cloth);
  torso.castShadow = true;
  root.add(torso);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.1, 10, 8), flesh);
  head.position.set(0, 0.02, 0.38);
  root.add(head);
  const legL = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.4), cloth);
  legL.position.set(-0.1, 0, -0.42);
  root.add(legL);
  const legR = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.1, 0.4), cloth);
  legR.position.set(0.1, 0, -0.42);
  root.add(legR);
  return root;
}

/**
 * USAR stretcher trolley — a taken chess-piece bay for rescued survivors.
 *
 * Origin at ground under the bed centre. The canvas top sits at ~0.85 m so a prone
 * victim mesh (origin mid-torso) can lie on it with a small Y offset.
 * Built from primitives only — same art rule as the rescuer / tools.
 */
export function createStretcherTrolley() {
  const root = new THREE.Group();
  root.name = 'stretcher';
  // Canvas bed — bright so a parked survivor is obvious from the pile camera.
  const canvas = mat(0xd4c4a8, { roughness: 0.85 });
  const rail = mat(0xb8c0c8, { metalness: 0.55, roughness: 0.35 });
  const wheel = mat(0x222222, { roughness: 0.7 });
  // High-vis corner posts so the triage bay reads at a distance.
  const marker = mat(0xe85d04, { roughness: 0.5 });

  // Four legs / uprights.
  for (const [x, z] of [[-0.28, -0.55], [0.28, -0.55], [-0.28, 0.55], [0.28, 0.55]]) {
    const leg = new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.78, 8), rail);
    leg.position.set(x, 0.39, z);
    leg.castShadow = true;
    root.add(leg);
  }
  // Long rails along the bed.
  for (const x of [-0.28, 0.28]) {
    const long = new THREE.Mesh(new THREE.BoxGeometry(0.04, 0.04, 1.2), rail);
    long.position.set(x, 0.78, 0);
    root.add(long);
  }
  // Cross bars.
  for (const z of [-0.55, 0, 0.55]) {
    const cross = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.03, 0.04), rail);
    cross.position.set(0, 0.78, z);
    root.add(cross);
  }
  // Canvas bed surface — survivors lie here after evacuation.
  const bed = new THREE.Mesh(new THREE.BoxGeometry(0.52, 0.03, 1.15), canvas);
  bed.position.set(0, 0.82, 0);
  bed.receiveShadow = true;
  root.add(bed);
  // Small wheels (discs) at each corner — trolley silhouette.
  for (const [x, z] of [[-0.28, -0.55], [0.28, -0.55], [-0.28, 0.55], [0.28, 0.55]]) {
    const w = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.04, 10), wheel);
    w.rotation.z = Math.PI / 2;
    w.position.set(x, 0.08, z);
    root.add(w);
  }
  // World Y of the bed top — callers park the victim mid-torso just above this.
  root.userData.bedY = 0.85;
  // Orange upright so the bay is findable when the camera is still in the pile.
  const flag = new THREE.Mesh(new THREE.BoxGeometry(0.06, 1.1, 0.06), marker);
  flag.position.set(0.35, 1.15, 0);
  root.add(flag);
  const flagTop = new THREE.Mesh(new THREE.BoxGeometry(0.35, 0.22, 0.04), marker);
  flagTop.position.set(0.48, 1.55, 0);
  root.add(flagTop);
  return root;
}

/**
 * Clip a tool prop (from src/tool-mesh.js) into the right fist, replacing whatever was held.
 * Pass `null` to empty the hand. The caller owns disposal of the prop it hands over.
 */
export function setHeldTool(group, prop) {
  const mount = group && group.userData.toolMount;
  if (!mount) return null;
  const previous = mount.children[0] || null;
  if (previous) mount.remove(previous);
  if (prop) mount.add(prop);
  return previous;
}

/** The Group a held tool hangs from, so callers can spin a blade without re-walking the tree. */
export function heldTool(group) {
  const mount = group && group.userData.toolMount;
  return mount ? mount.children[0] || null : null;
}

// Scratch objects reused every frame — allocating vectors inside a render loop is how you get
// garbage-collection stutter in a sim that is already asking a lot of the main thread.
const UP = new THREE.Vector3(0, 1, 0);
const ARM_REST_DIR = new THREE.Vector3(0, -1, 0);      // an arm hangs along its own -Y
const SHOULDER_LOCAL = new THREE.Vector3(0.28, 0.28, 0); // must match the rightArm pivot above
const _shoulder = new THREE.Vector3();
const _toAim = new THREE.Vector3();
const _origin = new THREE.Vector3();

/**
 * Swing the right arm so the fist (and therefore the tool in it) points at a world position.
 *
 * The maths is one line of three.js once the target is expressed in the body's own frame:
 * `setFromUnitVectors` builds the SHORTEST rotation taking the arm's rest direction onto the
 * direction we want, which is exactly what a shoulder joint does.
 */
function aimRightArmAt(group, translation, yaw, aim) {
  const arm = group.userData.limbs.rightArm;
  // Shoulder in world space: body origin plus the arm pivot, turned by the body's heading.
  _origin.set(translation.x, translation.y, translation.z);
  _shoulder.copy(SHOULDER_LOCAL).applyAxisAngle(UP, yaw).add(_origin);
  _toAim.set(aim.x - _shoulder.x, aim.y - _shoulder.y, aim.z - _shoulder.z);
  if (_toAim.lengthSq() < 1e-8) return;
  // Undo the body's yaw so the direction is in the same frame the arm rotates in.
  _toAim.applyAxisAngle(UP, -yaw).normalize();
  arm.quaternion.setFromUnitVectors(ARM_REST_DIR, _toAim);
}

/**
 * Sync the humanoid Group to the Rapier body pose.
 * `yaw` is heading in radians (0 = +Z). `walkPhase` drives a light limb swing when moving.
 * `aim` is an optional world point the held tool is being presented to; when given, the right arm
 * stops swinging and reaches for it and the left hand comes across to steady the machine.
 *
 * Modes `prone` / `elbow` / `commit` lay the figure flat (pitch ≈ 90°) so the mesh matches the
 * horizontal capsule — this is NOT the upright squat used for crouch/crawl.
 */
export function syncRescuerMesh(group, translation, yaw, walkPhase = 0, mode = 'idle', aim = null) {
  if (!group) return;
  group.position.set(translation.x, translation.y, translation.z);

  const limbs = group.userData.limbs;
  if (!limbs) return;

  // Prone / elbow-crawl / assisted commit: horizontal figure, belly near the floor.
  // Pitch the whole group so the torso lies along heading; do not squash with scale.y.
  const proneLike = mode === 'prone' || mode === 'elbow' || mode === 'commit';
  if (proneLike) {
    group.scale.set(1, 1, 1);
    // Pitch −90° around X after yaw so local +Y (up on the standing mesh) becomes −Z in
    // local-before-yaw, then yaw swings that onto the world heading. Visually: lying on belly.
    group.rotation.set(-Math.PI / 2, yaw, 0, 'YXZ');
    const swing = mode === 'elbow' || mode === 'commit'
      ? Math.sin(walkPhase) * 0.35
      : 0;
    // Elbows forward, legs trailing — reads as a low crawl into the void.
    limbs.leftArm.rotation.set(-1.4 + swing, 0, 0.35);
    limbs.rightArm.rotation.set(-1.4 - swing, 0, -0.35);
    limbs.leftLeg.rotation.x = 0.25 - swing * 0.5;
    limbs.rightLeg.rotation.x = 0.25 + swing * 0.5;
    return;
  }

  group.rotation.set(0, yaw, 0);

  // Crouch / crawl: squat the figure (scale + fold) so it matches the shorter capsule.
  const crouched = mode === 'crouch' || mode === 'crawl';
  if (crouched) {
    group.scale.set(1, 0.62, 1.05);
    limbs.leftLeg.rotation.x = 1.15;
    limbs.rightLeg.rotation.x = 1.15;
    limbs.leftArm.rotation.set(-0.9, 0, 0.2);
    limbs.rightArm.rotation.set(-0.9, 0, -0.2);
    if (mode === 'crawl') {
      const swing = Math.sin(walkPhase) * 0.25;
      limbs.leftLeg.rotation.x = 1.05 + swing;
      limbs.rightLeg.rotation.x = 1.05 - swing;
    }
    return;
  }
  group.scale.set(1, 1, 1);

  // On a ladder / mantle, freeze the walk cycle and raise the arms slightly. Both hands are busy,
  // so an aim request is ignored — you do not run a cut-off saw one-handed off a ladder.
  if (mode === 'ladder' || mode === 'mantle') {
    limbs.leftArm.rotation.set(-1.1, 0, 0);
    limbs.rightArm.rotation.set(-1.1, 0, 0);
    limbs.leftLeg.rotation.x = 0.15;
    limbs.rightLeg.rotation.x = -0.15;
    return;
  }

  const amp = mode === 'walk' || mode === 'jump' ? 0.45 : 0.05;
  const swing = Math.sin(walkPhase) * amp;
  limbs.leftLeg.rotation.x = swing;
  limbs.rightLeg.rotation.x = -swing;

  if (aim) {
    aimRightArmAt(group, translation, yaw, aim);
    limbs.leftArm.rotation.set(-0.8, 0, -0.4);   // second hand on the tool
  } else {
    limbs.leftArm.rotation.set(-swing * 0.7, 0, 0);
    limbs.rightArm.rotation.set(swing * 0.7, 0, 0);
  }
}

/** Build a simple extension-ladder mesh (rails + rungs) of given length (m). */
export function createLadderMesh(length, width = 0.45) {
  const root = new THREE.Group();
  root.name = 'ladder';
  const railMat = mat(0xb87333, { roughness: 0.6 }); // timber / alloy stand-in
  const rungMat = mat(0x8a6040, { roughness: 0.7 });
  const railL = new THREE.Mesh(new THREE.BoxGeometry(0.04, length, 0.04), railMat);
  railL.position.set(-width / 2, length / 2, 0);
  railL.castShadow = true;
  root.add(railL);
  const railR = new THREE.Mesh(new THREE.BoxGeometry(0.04, length, 0.04), railMat);
  railR.position.set(width / 2, length / 2, 0);
  railR.castShadow = true;
  root.add(railR);
  const rungCount = Math.max(3, Math.floor(length / 0.3));
  for (let i = 0; i < rungCount; i++) {
    const y = (i + 0.5) * (length / rungCount);
    const rung = new THREE.Mesh(new THREE.BoxGeometry(width, 0.03, 0.03), rungMat);
    rung.position.set(0, y, 0);
    root.add(rung);
  }
  return root;
}

export function disposeRescuerMesh(group) {
  if (!group) return;
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  });
}
