// Procedural props for the equipment the rescuer carries, in the same primitives-only style as
// src/rescuer-mesh.js (this project ships no GLTF or texture assets — everything is boxes,
// cylinders and CanvasTexture, so the whole sim stays one Vite bundle).
//
// Each prop is used in TWO places, which is why they live in their own module:
//
//   1. THIRD PERSON — parented into the rescuer's right hand, so you can see what he is holding
//      as he walks the pile. src/rescuer-mesh.js swings the arm; the prop just rides along.
//   2. FIRST PERSON ("T") — the body mesh is hidden at the eyes, so the same prop is rebuilt into
//      a viewmodel parented to the CAMERA: a forearm coming in from the lower right with the tool
//      in front of it, the way you would actually see your own hands.
//
// LOCAL AXIS CONVENTION
// ---------------------
// Every prop is modelled with:
//   * the origin at the GRIP — the point the fist closes around;
//   * +Z pointing along the working direction, i.e. out of the front of the tool.
// Callers only ever have to rotate that one axis to wherever the tool should point, which keeps
// the hand-mount and the viewmodel from needing two different sets of magic angles.

import * as THREE from 'three';

const STEEL = 0x9aa3ab;
const DARK = 0x24282d;
const BLADE = 0xd6dbe0;
const BODY_BLUE = 0x4a90d9;
const TIMBER = 0xc79a5b;
const RUBBER = 0x1c1f23;

function mat(color, extras = {}) {
  return new THREE.MeshStandardMaterial({ color, roughness: 0.6, metalness: 0.25, ...extras });
}

/**
 * A petrol cut-off saw: engine body, top handle, and a disc sticking out the front.
 *
 * The disc is a very flat cylinder. A cylinder's axis is +Y by default, so rotating it 90° about Z
 * lays the axis along X — which leaves the disc FACE in the YZ plane, i.e. the blade slices
 * forward along +Z, exactly how you would push a saw into a slab.
 */
function buildDiscSaw(bladeRadius = 0.15) {
  const g = new THREE.Group();

  const body = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.16, 0.26), mat(BODY_BLUE, { roughness: 0.5 }));
  body.position.z = 0.10;
  g.add(body);

  // Rear grip the fist closes on, at the origin, plus the top bar you steady it with.
  const grip = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.13, 8), mat(RUBBER, { metalness: 0.05 }));
  grip.rotation.x = Math.PI / 2;
  g.add(grip);
  const bar = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 0.20), mat(DARK, { metalness: 0.1 }));
  bar.position.set(0, 0.11, 0.10);
  g.add(bar);

  // Blade guard hugging the top rear quadrant of the disc.
  const guard = new THREE.Mesh(new THREE.CylinderGeometry(bladeRadius * 1.1, bladeRadius * 1.1, 0.035, 12, 1, false, 0, Math.PI),
    mat(0xe08a2e, { roughness: 0.55 }));
  guard.rotation.z = Math.PI / 2;
  guard.position.set(0, 0.02, 0.26);
  g.add(guard);

  const disc = new THREE.Mesh(new THREE.CylinderGeometry(bladeRadius, bladeRadius, 0.008, 20), mat(BLADE, { metalness: 0.6, roughness: 0.35 }));
  disc.rotation.z = Math.PI / 2;
  disc.position.z = 0.30;
  g.add(disc);
  // Arbor nut, so the disc reads as a disc and not a floating coin.
  const arbor = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.016, 8), mat(DARK));
  arbor.rotation.z = Math.PI / 2;
  arbor.position.z = 0.30;
  g.add(arbor);

  g.userData.spin = disc;        // the render loop spins this while cutting
  return g;
}

/** Hydraulic rebar cutter: stubby hydraulic body with a short pair of jaws. */
function buildPliers() {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.055, 0.30, 10), mat(BODY_BLUE));
  body.rotation.x = Math.PI / 2;
  body.position.z = 0.15;
  g.add(body);
  for (const side of [-1, 1]) {
    const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.028, 0.05, 0.16), mat(STEEL, { metalness: 0.7 }));
    jaw.position.set(side * 0.03, side * 0.02, 0.38);
    jaw.rotation.x = side * 0.12;
    g.add(jaw);
  }
  return g;
}

/** Oxy-fuel cutting torch: bottle-fed handle, long neck, and a little flame at the tip. */
function buildTorch() {
  const g = new THREE.Group();
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.032, 0.032, 0.22, 10), mat(DARK, { metalness: 0.4 }));
  handle.rotation.x = Math.PI / 2;
  handle.position.z = 0.11;
  g.add(handle);
  const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.014, 0.010, 0.22, 8), mat(STEEL, { metalness: 0.8 }));
  neck.rotation.x = Math.PI / 2;
  neck.position.z = 0.32;
  g.add(neck);
  // Flame: an emissive cone so it glows without needing a light source.
  const flame = new THREE.Mesh(new THREE.ConeGeometry(0.022, 0.11, 8),
    new THREE.MeshStandardMaterial({ color: 0xffb347, emissive: 0xff7b1a, emissiveIntensity: 1.6, roughness: 1 }));
  flame.rotation.x = Math.PI / 2;
  flame.position.z = 0.48;
  g.add(flame);
  g.userData.flicker = flame;    // scaled by the render loop so the flame is not dead still
  return g;
}

/** Breaching hammer: long shaft with a heavy head — a sledge, held near the butt. */
function buildHammer() {
  const g = new THREE.Group();
  const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.026, 0.62, 8), mat(TIMBER, { metalness: 0.02, roughness: 0.85 }));
  shaft.rotation.x = Math.PI / 2;
  shaft.position.z = 0.31;
  g.add(shaft);
  const head = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.10, 0.20), mat(STEEL, { metalness: 0.75, roughness: 0.4 }));
  head.rotation.y = Math.PI / 2;
  head.position.z = 0.62;
  g.add(head);
  return g;
}

/** Deflated lifting bag, carried folded flat with its hose coiled at the grip. */
function buildBag() {
  const g = new THREE.Group();
  const pad = new THREE.Mesh(new THREE.BoxGeometry(0.30, 0.06, 0.30), mat(0xffd76a, { metalness: 0.02, roughness: 0.9 }));
  pad.position.z = 0.18;
  g.add(pad);
  const hose = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.012, 6, 12), mat(DARK, { metalness: 0.1 }));
  hose.position.set(0, -0.02, 0.02);
  g.add(hose);
  return g;
}

/** A shoring post carried on the shoulder — one timber, cut to length on site. */
function buildShorePost() {
  const g = new THREE.Group();
  const post = new THREE.Mesh(new THREE.BoxGeometry(0.09, 0.09, 0.9), mat(TIMBER, { metalness: 0.02, roughness: 0.9 }));
  post.position.z = 0.45;
  g.add(post);
  return g;
}

/** Collapsed extension ladder, carried by one rail. */
function buildLadder() {
  const g = new THREE.Group();
  for (const side of [-0.1, 0.1]) {
    const rail = new THREE.Mesh(new THREE.BoxGeometry(0.035, 0.035, 1.1), mat(0xb87333, { metalness: 0.3 }));
    rail.position.set(side, 0, 0.55);
    g.add(rail);
  }
  for (let i = 0; i < 4; i++) {
    const rung = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.022, 0.022), mat(0x8a6040));
    rung.position.z = 0.2 + i * 0.25;
    g.add(rung);
  }
  return g;
}

// The tool `kind` from src/equipment.js selects the prop. Keeping the map here (rather than a
// switch inside the builder) makes it obvious at a glance which kinds have art and which fall
// through to the generic block.
const BUILDERS = {
  hole: () => buildDiscSaw(0.15),
  slice: () => buildDiscSaw(0.19),      // the big saw: same machine, larger disc
  rebar: buildPliers,
  torch: buildTorch,
  hammer: buildHammer,
  bag: buildBag,
  shore: buildShorePost,
  ladder: buildLadder,
};

/**
 * Build the prop for a tool kind, grip at the origin and working end along +Z.
 * Returns null for an unknown kind so callers can simply skip attaching anything.
 */
export function createToolProp(kind) {
  const build = BUILDERS[kind];
  if (!build) return null;
  const g = build();
  g.name = `tool:${kind}`;
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

/**
 * Build the first-person viewmodel: a gloved forearm entering from the lower right with the tool
 * in its fist. Parent the returned Group to the CAMERA (and make sure the camera itself is added
 * to the scene, or three.js will never traverse its children).
 *
 * Camera space is right-handed with -Z forward, so the tool is turned 180° about Y to point its
 * +Z working axis away from the viewer.
 */
export function createToolViewmodel(kind) {
  const root = new THREE.Group();
  root.name = 'toolViewmodel';

  // The hand sits low and right of centre, close enough to read but clear of the near plane
  // (the perspective camera in main.js has near = 0.1).
  const hand = new THREE.Group();
  hand.position.set(0.20, -0.24, -0.42);
  root.add(hand);

  // Forearm angling back toward the bottom-right corner of the screen — the sleeve of the same
  // orange Civil Defence tee the body mesh wears, with a bare hand at the end.
  const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.055, 0.062, 0.34, 8),
    new THREE.MeshStandardMaterial({ color: 0xe85d04, roughness: 0.7 }));
  sleeve.position.set(0.09, -0.11, 0.17);
  sleeve.rotation.set(-1.05, 0, -0.42);
  hand.add(sleeve);
  const fist = new THREE.Mesh(new THREE.BoxGeometry(0.075, 0.085, 0.09),
    new THREE.MeshStandardMaterial({ color: 0xc68642, roughness: 0.8 }));
  hand.add(fist);

  const prop = createToolProp(kind);
  if (prop) {
    prop.rotation.y = Math.PI;      // +Z working axis -> -Z, i.e. away from the eye
    hand.add(prop);
  }

  root.userData.hand = hand;
  root.userData.prop = prop;
  root.userData.restPos = hand.position.clone();
  // Viewmodels must never be clipped by the world or occluded by debris the tool is inside of.
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.castShadow = false;
    o.receiveShadow = false;
    o.renderOrder = 1000;
    o.material.depthTest = false;
  });
  return root;
}

/**
 * Animate a viewmodel toward where the tool is aimed.
 *
 * @param {THREE.Group} vm     from createToolViewmodel
 * @param {{x:number,y:number,z:number}|null} dirCam
 *        unit direction to the work point expressed in CAMERA space, or null when there is no
 *        valid target (the tool then eases back to its carry pose)
 * @param {number} dt          seconds since the last frame
 * @param {number} cutting     0..1 — how hard the tool is working right now (drives the shake)
 */
export function aimToolViewmodel(vm, dirCam, dt, cutting = 0) {
  if (!vm) return;
  const hand = vm.userData.hand;
  if (!hand) return;
  const k = Math.min(1, dt * 8);                 // exponential ease, framerate independent

  // Screen-space lead: the further off-centre the cursor is, the further the tool leans that way.
  // Clamped hard, because a viewmodel that tracks 1:1 with the mouse looks like a swinging boom.
  let wantX = 0, wantY = 0;
  if (dirCam) {
    wantX = THREE.MathUtils.clamp(dirCam.x * 0.5, -0.16, 0.16);
    wantY = THREE.MathUtils.clamp(dirCam.y * 0.5, -0.12, 0.12);
  }
  const rest = vm.userData.restPos;
  hand.position.x += (rest.x + wantX - hand.position.x) * k;
  hand.position.y += (rest.y + wantY - hand.position.y) * k;
  // Pushing the tool INTO the work while cutting, then drawing it back out.
  const push = cutting > 0 ? -0.08 : 0;
  hand.position.z += (rest.z + push - hand.position.z) * k;

  // Point the fist roughly along the aim direction, again damped.
  const yaw = dirCam ? THREE.MathUtils.clamp(Math.atan2(dirCam.x, -dirCam.z), -0.5, 0.5) : 0;
  const pitch = dirCam ? THREE.MathUtils.clamp(Math.asin(THREE.MathUtils.clamp(dirCam.y, -1, 1)), -0.7, 0.7) : -0.15;
  hand.rotation.y += (yaw - hand.rotation.y) * k;
  hand.rotation.x += (pitch - hand.rotation.x) * k;

  // A cut-off saw kicks. Small, high-frequency, and only while the trigger is in.
  if (cutting > 0) {
    const t = performance.now() * 0.001;
    hand.position.x += Math.sin(t * 61) * 0.006 * cutting;
    hand.position.y += Math.cos(t * 47) * 0.005 * cutting;
  }
  spinToolProp(vm.userData.prop, dt, cutting);
}

/** Spin the blade / flicker the flame on whichever prop is passed (hand-held or viewmodel). */
export function spinToolProp(prop, dt, cutting = 0) {
  if (!prop) return;
  const disc = prop.userData.spin;
  if (disc) disc.rotation.x += dt * (cutting > 0 ? 40 : 6);
  const flame = prop.userData.flicker;
  if (flame) {
    const s = 0.85 + Math.sin(performance.now() * 0.02) * 0.15;
    flame.scale.set(s, 1 + (1 - s), s);
  }
}

/** Free the GPU buffers of a prop / viewmodel that is being swapped out. */
export function disposeToolProp(group) {
  if (!group) return;
  group.traverse((o) => {
    if (o.geometry) o.geometry.dispose();
    if (o.material) {
      if (o.material.map) o.material.map.dispose();
      o.material.dispose();
    }
  });
}
