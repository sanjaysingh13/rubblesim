// RubbleSim Web — renderer. Drives the framework-agnostic physics core (src/sim.js)
// and mirrors each physics part as a three.js mesh. See sim.js for the collapse model.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import GUI from 'lil-gui';
import RAPIER from '@dimforge/rapier3d-compat';
import { RubbleSim, DEFAULTS } from './sim.js';
import { EQUIPMENT, TOOL_LABELS, equipmentById, equipmentByLabel } from './equipment.js';
import { LIFT_BAGS, SHORE_TYPES } from './rescue.js';
import { ensureAudio, playContact, playBodyBump, startGrind, stopGrind } from './audio.js';
import { RescuerAgent } from './rescuer.js';
import { CAPSULE_HALF, CAPSULE_RADIUS } from './rescuer-constants.js';
import {
  createRescuerMesh, createVictimMesh, createLadderMesh,
  syncRescuerMesh, disposeRescuerMesh, setHeldTool, heldTool,
} from './rescuer-mesh.js';
import {
  createToolProp, createToolViewmodel, aimToolViewmodel, spinToolProp, disposeToolProp,
} from './tool-mesh.js';
import {
  reachCheck, reachMessage, cutPlaneOf, isBroadFace,
} from './rescuer-reach.js';

const statusEl = document.getElementById('status');
const setStatus = (t) => { statusEl.textContent = t; };

const params = {
  ...DEFAULTS,
  standSeconds: 1.2,
  settleSeconds: 8,
  showVoidMarkers: true,
  equipment: 'None',          // active tool label; the enum lives in src/equipment.js
  cutReach: 0.55,             // rebar-cutter mouth reach (m) — short (hydraulic pliers)
  holeSize: 0.6,             // concrete-cutter square side (m)
  cutSettleSeconds: 3,       // local re-settle time after a cut
  bagSize: 'bag10t',         // which lifting bag to place
  shoreType: 'tShore',       // which shoring assembly to erect
  rescuerMode: false,        // WASD rescuer control
  rescuerView: 'third',      // 'third' = behind shoulder + orbit; 'first' = eyes + zoom
  showStress: false,         // §4A stress map (grey -> red)
  stressRefLoad: 150,        // kN that reads as "fully stressed" for debris contact force
  stressEveryNFrames: 6,     // §4A "query every N frames" — the map is not free
  rebuild: () => rebuild(),
  collapseNow: () => doCollapse(),
  freezeNow: () => doFreeze(),
  spawnRescuer: () => spawnRescuer(),
  exportSTL: () => exportSTL(),
  exportVoids: () => exportVoids(),
};

// ---------------------------------------------------------------------------
// Renderer / scene / camera
// ---------------------------------------------------------------------------
const app = document.getElementById('app');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.setSize(innerWidth, innerHeight);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
app.appendChild(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b0d10);
scene.fog = new THREE.Fog(0x0b0d10, 28, 88);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 500);
camera.position.set(15, 12, 17);
// Layers gate RENDERING as well as raycasting, and a camera only renders layer 0 by default.
// Rebar (layer 1) and void volumes (layer 2) are on their own layers purely so the active tool
// can filter what it picks (specs.md §4B) — the camera must still draw them, or reinforcement and
// void markers silently vanish from the scene.
camera.layers.enable(1);
camera.layers.enable(2);
// The first-person tool viewmodel is parented to the CAMERA so it stays glued to the eye. three.js
// only draws what it reaches by walking the scene graph, and a camera is not in that graph by
// default — without this line the held tool would exist but never be rendered.
scene.add(camera);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 4, 0);
controls.enableDamping = true;

// --- Cut preview (concrete cutter only) -------------------------------------------------------
//
// The old disc-cutter sprite that floated at the mouse is gone: the rescuer carries the real
// machine in his right hand (src/tool-mesh.js). Aim with the mouse, right-click an eligible
// spot, and the cut fires. The only on-screen tell left is the square footprint of the hole the
// cutter would open — green when right-click will cut, amber when the tile is fine but something
// else (usually the rescuer's reach) is stopping him.
const MARK_OK = 0x33ff88;
const MARK_NO = 0xff9a3c;

// Both meshes are a UNIT square (1 m × 1 m in the XY plane, normal +Z) scaled/rotated per frame
// by `showHolePreview`. Unit size lets the preview shrink with sim.cutHoleInSlab's 60 mm border.
const cutSquare = new THREE.Group();
cutSquare.visible = false;
const squareFill = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ color: MARK_OK, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
const unitCorners = [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5], [-0.5, -0.5]];
const unitEdges = [];
for (let i = 0; i < 4; i++) {
  unitEdges.push(new THREE.Vector3(unitCorners[i][0], unitCorners[i][1], 0),
    new THREE.Vector3(unitCorners[i + 1][0], unitCorners[i + 1][1], 0));
}
const squareOutline = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(unitEdges),
  new THREE.LineBasicMaterial({ color: MARK_OK, depthTest: false }));
squareFill.renderOrder = 997; squareOutline.renderOrder = 998;
cutSquare.add(squareFill, squareOutline);
scene.add(cutSquare);

scene.add(new THREE.HemisphereLight(0x9fbfff, 0x20160f, 0.75));
const sun = new THREE.DirectionalLight(0xfff2e0, 2.3);
sun.position.set(12, 24, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1; sun.shadow.camera.far = 90;
sun.shadow.camera.left = -24; sun.shadow.camera.right = 24;
sun.shadow.camera.top = 24; sun.shadow.camera.bottom = -24;
scene.add(sun);

const ground = new THREE.Mesh(new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 1 }));
ground.rotation.x = -Math.PI / 2; ground.receiveShadow = true;
scene.add(ground);
scene.add(new THREE.GridHelper(48, 48, 0x223, 0x1a1f24));

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------------------
// Materials per part kind
// ---------------------------------------------------------------------------
// Everything structural is REINFORced CONCRETE: grey concrete with a rust-red rebar cage.
//   concrete (slabs/columns/beams/fragments) = grey · rebar = rust-red · furniture = brown
const MAT = {
  slab:      new THREE.MeshStandardMaterial({ color: 0x9a9c9f, roughness: 0.95 }),           // concrete slab
  column:    new THREE.MeshStandardMaterial({ color: 0x929699, roughness: 0.95 }),            // concrete column
  beam:      new THREE.MeshStandardMaterial({ color: 0x868b90, roughness: 0.95 }),            // concrete beam (RC, not steel)
  rebar:     new THREE.MeshStandardMaterial({ color: 0x904428, roughness: 0.7, metalness: 0.35 }), // rust-red — subdued so grey concrete dominates
  furniture: new THREE.MeshStandardMaterial({ color: 0x9c6a3f, roughness: 0.9 }),             // contents
  fragment:  new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 1 }),               // broken concrete
  shore:     new THREE.MeshStandardMaterial({ color: 0xc79a5b, roughness: 0.85 }),            // timber shoring
};

// Chipped cover concrete — mostly opaque grey; rebar is a hint inside, not a solid red wash.
const MAT_SKINNED = {
  slab:     new THREE.MeshStandardMaterial({ color: 0x9a9c9f, roughness: 0.95, transparent: true, opacity: 0.68, depthWrite: true }),
  column:   new THREE.MeshStandardMaterial({ color: 0x929699, roughness: 0.95, transparent: true, opacity: 0.70, depthWrite: true }),
  beam:     new THREE.MeshStandardMaterial({ color: 0x868b90, roughness: 0.95, transparent: true, opacity: 0.70, depthWrite: true }),
  fragment: new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 1, transparent: true, opacity: 0.65, depthWrite: true }),
};

/** Concrete material for a part: opaque when intact, skinned (translucent) when rebar is exposed. */
function concreteMat(part) {
  const kind = part.matKind || part.kind;
  if (part.rebarExposed && MAT_SKINNED[kind]) return MAT_SKINNED[kind];
  return MAT[kind] || MAT.fragment;
}

// --- Stress map (specs.md §4A) -------------------------------------------------------------
// Lerp grey [0.5,0.5,0.5] -> red [1,0,0] with the stress fraction. Rather than cloning a material
// per part (hundreds of them) or rewriting vertex colours every frame, meshes are swapped between
// a small bank of pre-built bucket materials — same visual result, no per-frame allocation.
const STRESS_BUCKETS = 12;
const stressMats = Array.from({ length: STRESS_BUCKETS }, (_, i) => {
  const f = i / (STRESS_BUCKETS - 1);
  return new THREE.MeshStandardMaterial({
    color: new THREE.Color(0.5 + 0.5 * f, 0.5 * (1 - f), 0.5 * (1 - f)),
    roughness: 0.9,
  });
});
const stressMatFor = (frac) =>
  stressMats[Math.max(0, Math.min(STRESS_BUCKETS - 1, Math.round(frac * (STRESS_BUCKETS - 1))))];

const structureGroup = new THREE.Group();  // exported to STL
const markerGroup = new THREE.Group();
scene.add(structureGroup, markerGroup);

// --- Cement-dust particles (poor-mix collapses throw up a persistent haze) -------------------
const DUST_CAP = 2500;
const dustSlot = Array.from({ length: DUST_CAP }, () => ({ life: 0, vx: 0, vy: 0, vz: 0 }));
const dustPositions = new Float32Array(DUST_CAP * 3);
const dustGeo = new THREE.BufferGeometry();
dustGeo.setAttribute('position', new THREE.BufferAttribute(dustPositions, 3));
const dustMat = new THREE.PointsMaterial({
  color: 0x9a9088, size: 0.14, transparent: true, opacity: 0.42,
  depthWrite: false, sizeAttenuation: true,
});
const dustCloud = new THREE.Points(dustGeo, dustMat);
dustCloud.frustumCulled = false;
scene.add(dustCloud);

function spawnDustCloud(x, y, z, count, spread = 1) {
  let start = (Math.random() * DUST_CAP) | 0;
  for (let k = 0; k < count; k++) {
    const i = (start + k) % DUST_CAP;
    const slot = dustSlot[i];
    slot.life = 2.5 + Math.random() * 2.5;
    slot.vx = (Math.random() - 0.5) * spread * 2.2;
    slot.vy = Math.random() * spread * 1.8 + 0.4;
    slot.vz = (Math.random() - 0.5) * spread * 2.2;
    dustPositions[i * 3] = x + (Math.random() - 0.5) * spread;
    dustPositions[i * 3 + 1] = y + Math.random() * spread * 0.5;
    dustPositions[i * 3 + 2] = z + (Math.random() - 0.5) * spread;
  }
  dustGeo.attributes.position.needsUpdate = true;
}

function ingestSimDust() {
  if (!sim) return;
  for (const e of sim.drainDustEvents()) spawnDustCloud(e.x, e.y, e.z, e.count, e.spread ?? 0.8);
}

function updateDust(dt) {
  let active = 0;
  for (let i = 0; i < DUST_CAP; i++) {
    const s = dustSlot[i];
    if (s.life <= 0) {
      dustPositions[i * 3 + 1] = -999;
      continue;
    }
    s.life -= dt;
    s.vy -= dt * 0.35;
    s.vx *= 1 - dt * 0.35;
    s.vz *= 1 - dt * 0.35;
    dustPositions[i * 3] += s.vx * dt;
    dustPositions[i * 3 + 1] += s.vy * dt;
    dustPositions[i * 3 + 2] += s.vz * dt;
    active++;
  }
  dustGeo.attributes.position.needsUpdate = true;
  // Haze thickens while the pile is settling, then eases off.
  const haze = phase === 'collapsing' ? 0.48 : phase === 'frozen' ? 0.38 : 0.42;
  dustMat.opacity = haze;
  scene.fog.near = phase === 'collapsing' ? 18 : 28;
  scene.fog.far = phase === 'collapsing' ? 72 : 88;
}

function resetDust() {
  for (const s of dustSlot) { s.life = 0; }
  dustGeo.attributes.position.needsUpdate = true;
  scene.fog.near = 28;
  scene.fog.far = 88;
}

// Visual-only cement chips at beam/column snaps — parented to the broken piece so they move with it.
const _wq = new THREE.Quaternion();
const _wv = new THREE.Vector3();

function worldToPartLocal(part, wx, wy, wz) {
  const t = part.body.translation(), r = part.body.rotation();
  _wv.set(wx - t.x, wy - t.y, wz - t.z);
  _wq.set(r.x, r.y, r.z, r.w).invert();
  return _wv.applyQuaternion(_wq).clone();
}

function onSplinter(chips, parentPart) {
  if (!parentPart?.mesh) return;
  for (const c of chips) {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(c.hx * 2, c.hy * 2, c.hz * 2),
      MAT.fragment,
    );
    mesh.position.copy(worldToPartLocal(parentPart, c.x, c.y, c.z));
    mesh.rotation.set(c.rx, c.ry, c.rz);
    mesh.castShadow = true;
    parentPart.mesh.add(mesh);
  }
}

function clearSplinters() {
  /* chips are children of part meshes — cleared when sim.dispose() runs on rebuild */
}

// ---------------------------------------------------------------------------
// Sim wiring — a mesh per physics part
// ---------------------------------------------------------------------------
let sim;
const voidMarkers = [];
let phase = 'idle';
let timer = 0;
let settleDuration = 8;   // seconds of re-settling before auto-freeze (collapse vs cut)
const SETTLE_CAP = 2;     // hard stop at 2× settleDuration if the pile never reaches equilibrium

// merge a part's rebar rod descriptors {x,y,z,len,r,axis} into one thin-cylinder mesh.
// axis 'y' needs no rotation (CylinderGeometry already runs along +Y); 'x'/'z' are spun into place.
function buildRebarMesh(rebars) {
  if (!rebars || !rebars.length) return null;
  const geoms = [];
  for (const d of rebars) {
    const g = new THREE.CylinderGeometry(d.r, d.r, d.len, 6, 1);   // 6 segs — denser lattice, keep verts down
    if (d.axis === 'x') g.rotateZ(Math.PI / 2);
    else if (d.axis === 'z') g.rotateX(Math.PI / 2);
    g.translate(d.x, d.y, d.z);
    geoms.push(g);
  }
  const merged = mergeGeometries(geoms, false);
  geoms.forEach((g) => g.dispose());
  if (!merged) return null;
  const m = new THREE.Mesh(merged, MAT.rebar);
  m.castShadow = true;
  return m;
}

// Rebar is embedded under intact concrete — keep it hidden until a crack/cut/spall exposes it.
function attachRebar(parent, part) {
  const rb = buildRebarMesh(part.rebars);
  if (!rb) return;
  rb.visible = !!part.rebarExposed;
  rb.layers.set(LAYER_REBAR);
  rb.userData.part = part;
  rb.userData.isRebar = true;
  parent.add(rb);
}

function showRebar(part) {
  if (!part?.mesh) return;
  part.mesh.traverse((o) => { if (o.userData?.isRebar) o.visible = true; });
}

// Raycast layers (specs.md §4B): concrete on layer 0, reinforcement on layer 1, so the active
// tool can restrict what it is physically able to grab. A torch set to layer 1 simply cannot
// select a concrete face, which removes the whole class of "I aimed at rebar and cut the slab".
const LAYER_CONCRETE = 0, LAYER_REBAR = 1, LAYER_VOID = 2;

function onAdd(part) {
  // Ladder physics boxes are invisible stand-ins; the renderer draws rails/rungs separately.
  if (part.kind === 'ladder' || part.matKind === 'ladder') {
    part.mesh = null;
    part.baseMat = null;
    return;
  }
  const s = part.shape;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(s.hx * 2, s.hy * 2, s.hz * 2), concreteMat(part));
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.layers.set(LAYER_CONCRETE);
  const t = part.body.translation(), r = part.body.rotation();
  mesh.position.set(t.x, t.y, t.z);
  mesh.quaternion.set(r.x, r.y, r.z, r.w);
  // reinforcement: thin cylindrical rods (3D lattice in slabs; corner bars in columns/beams),
  // merged into one child mesh that rides with the concrete piece.
  attachRebar(mesh, part);
  part.mesh = mesh;
  part.baseMat = concreteMat(part);
  mesh.userData.part = part;   // back-reference for picking
  structureGroup.add(mesh);
}
function disposeMesh(obj) { obj.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); }
function onRemove(part) {
  if (part.mesh) { structureGroup.remove(part.mesh); disposeMesh(part.mesh); part.mesh = null; }
}
// Skin the concrete (translucent) so the endo-skeleton reads through — called when a crack,
// snap, cut, or spall exposes the rebar. No mesh rebuild; just swap materials on concrete faces.
function onExpose(part) {
  if (!part.mesh) return;
  showRebar(part);
  const mat = concreteMat(part);
  part.baseMat = mat;
  paintPart(part, params.showStress ? stressMatFor(stressOf(part)) : mat);
}
// after a hole is cut, rebuild the tile's mesh as a group of frame boxes (with the hole)
function onReshape(part) {
  if (part.mesh) { structureGroup.remove(part.mesh); disposeMesh(part.mesh); }
  const mat = concreteMat(part);
  const g = new THREE.Group();
  for (const b of part.frame) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(b.hx * 2, b.hy * 2, b.hz * 2), mat);
    box.position.set(b.x, b.y, b.z); box.castShadow = true; box.receiveShadow = true;
    box.layers.set(LAYER_CONCRETE); box.userData.part = part;
    g.add(box);
  }
  attachRebar(g, part);   // trimmed 3D lattice — frayed ends stick into the hole
  const t = part.body.translation(), r = part.body.rotation();
  g.position.set(t.x, t.y, t.z); g.quaternion.set(r.x, r.y, r.z, r.w);
  g.userData.part = part; part.mesh = g; part.baseMat = mat;
  structureGroup.add(g);
}

function clearMarkers() { for (const m of voidMarkers) markerGroup.remove(m); voidMarkers.length = 0; }

// --- lifting-bag rendering --------------------------------------------------------------------
// A bag is a kinematic body in the physics world, not a `part`, so it gets its own mesh: a pillow
// drawn between the seated base and the rising platform, so the inflation is legible.
const bagMeshes = new Map();
const MAT_BAG = new THREE.MeshStandardMaterial({ color: 0xffd76a, roughness: 0.55 });
const MAT_BAG_STALL = new THREE.MeshStandardMaterial({ color: 0xff6b5c, roughness: 0.55 });
function syncBagMeshes() {
  if (!sim || !sim.rescue) return;
  const live = new Set(sim.rescue.bags);
  for (const [bag, mesh] of bagMeshes) {
    if (!live.has(bag)) { structureGroup.remove(mesh); disposeMesh(mesh); bagMeshes.delete(bag); }
  }
  for (const bag of sim.rescue.bags) {
    let mesh = bagMeshes.get(bag);
    if (!mesh) {
      mesh = new THREE.Mesh(new THREE.CylinderGeometry(bag.spec.radius, bag.spec.radius, 1, 16), MAT_BAG);
      mesh.castShadow = true;
      structureGroup.add(mesh);
      bagMeshes.set(bag, mesh);
    }
    const h = Math.max(0.04, bag.lift + bag.plate * 2);
    mesh.scale.set(1, h, 1);
    mesh.position.set(bag.point.x, bag.baseY + h / 2, bag.point.z);
    mesh.material = bag.stalled ? MAT_BAG_STALL : MAT_BAG;
  }
}

// --- ladder rendering (rails + rungs; physics box stays invisible) ---------------------------
const ladderMeshes = new Map();
function syncLadderMeshes() {
  if (!sim || !sim.rescue) return;
  const live = new Set(sim.rescue.ladders);
  for (const [ladder, mesh] of ladderMeshes) {
    if (!live.has(ladder)) {
      structureGroup.remove(mesh); disposeMesh(mesh); ladderMeshes.delete(ladder);
    }
  }
  for (const ladder of sim.rescue.ladders) {
    let mesh = ladderMeshes.get(ladder);
    if (!mesh) {
      mesh = createLadderMesh(ladder.length, ladder.spec.width);
      // Orient the ladder from base toward top: local +Y is up the rails.
      const dx = ladder.top.x - ladder.base.x;
      const dy = ladder.top.y - ladder.base.y;
      const dz = ladder.top.z - ladder.base.z;
      const len = Math.hypot(dx, dy, dz) || 1;
      // Build a quaternion that maps local +Y to the ladder direction.
      const up = new THREE.Vector3(0, 1, 0);
      const dir = new THREE.Vector3(dx / len, dy / len, dz / len);
      mesh.quaternion.setFromUnitVectors(up, dir);
      mesh.position.set(ladder.base.x, ladder.base.y, ladder.base.z);
      structureGroup.add(mesh);
      ladderMeshes.set(ladder, mesh);
    }
  }
}

// --- USAR rescuer + victims ------------------------------------------------------------------
let rescuer = null;
let rescuerMesh = null;
const victimMeshes = [];
let victimsAccessed = 0;
const agentsGroup = new THREE.Group();
scene.add(agentsGroup);

const keysDown = new Set();
let interactEdge = false;
let jumpEdge = false;

function clearRescuer() {
  if (rescuer) { rescuer.dispose(); rescuer = null; }
  if (rescuerMesh) {
    agentsGroup.remove(rescuerMesh);
    disposeRescuerMesh(rescuerMesh);        // disposes the held prop with the rest of the body
    rescuerMesh = null;
    heldProp = null;
  }
  // No carrier, no equipment: drop whatever was selected and lock the ring again.
  refreshEquipmentGate();
  for (const m of victimMeshes) { agentsGroup.remove(m); disposeRescuerMesh(m); }
  victimMeshes.length = 0;
  victimsAccessed = 0;
  params.rescuerMode = false;
  // Restore free orbit over the pile.
  controls.enabled = true;
  controls.enablePan = true;
  controls.enableRotate = true;
  controls.enableZoom = true;
  controls.minDistance = 1;
  controls.maxDistance = 200;
  controls.maxPolarAngle = Math.PI;
}

/**
 * Place the orbit camera behind the rescuer's right shoulder and look at their chest.
 * Call on spawn / when switching into third-person — afterward OrbitControls owns pan/zoom/tilt.
 */
function placeShoulderCamera() {
  if (!rescuer) return;
  const t = rescuer.translation();
  const fx = Math.sin(rescuer.yaw);
  const fz = Math.cos(rescuer.yaw);
  // Right-shoulder offset: behind along -facing, and a little to the right.
  const back = 5.0;
  const side = 1.4;
  const up = 2.2;
  controls.target.set(t.x, t.y + 0.55, t.z);
  camera.position.set(
    t.x - fx * back - fz * side,
    t.y + up,
    t.z - fz * back + fx * side,
  );
  controls.update();
}

/** Jump the camera to the rescuer's eyes (first-person). Zoom still works via orbit distance. */
function placeEyeCamera() {
  if (!rescuer) return;
  const t = rescuer.translation();
  const eyeY = rescuer.feetY() + EYE_HEIGHT;
  const fx = Math.sin(rescuer.yaw);
  const fz = Math.cos(rescuer.yaw);
  controls.target.set(t.x + fx * 0.15, eyeY, t.z + fz * 0.15);
  camera.position.set(t.x, eyeY, t.z);
  controls.update();
}

function applyRescuerViewMode() {
  if (!rescuer) return;
  const first = params.rescuerView === 'first';
  if (rescuerMesh) rescuerMesh.visible = !first;
  // At the eyes the body is hidden, so the hand and its tool come from the camera-parented
  // viewmodel instead; over the shoulder you are looking at the real arm and the real prop.
  if (toolViewmodel) toolViewmodel.visible = first && params.rescuerMode;
  controls.enabled = true;
  controls.enableRotate = true;
  controls.enableZoom = true;
  if (first) {
    // Eyes: rotate = look, zoom = dolly in/out, no pan (pan would slide the head off body).
    controls.enablePan = false;
    controls.minDistance = 0.05;
    controls.maxDistance = 3.5;
    controls.maxPolarAngle = Math.PI * 0.95;
    placeEyeCamera();
  } else {
    // Shoulder: full orbit (pan / zoom / tilt) around the rescuer.
    controls.enablePan = true;
    controls.minDistance = 2.0;
    controls.maxDistance = 30;
    controls.maxPolarAngle = Math.PI * 0.48; // keep above the horizon a bit
    placeShoulderCamera();
  }
}

function spawnRescuer() {
  if (!sim) return;
  clearRescuer();
  // Spawn at the pile perimeter on the ground, facing the origin.
  const edge = (params.buildingSize || 6) / 2 + 2.5;
  const spawn = {
    x: edge,
    y: CAPSULE_HALF + CAPSULE_RADIUS + 0.5,
    z: 0,
  };
  // Clear sticky Space / E from GUI focus or prior key state so spawn never auto-jumps.
  jumpEdge = false;
  interactEdge = false;
  keysDown.delete(' ');
  keysDown.delete('spacebar');
  rescuer = new RescuerAgent(sim, spawn);
  rescuer.yaw = Math.atan2(-spawn.x, -spawn.z);
  rescuer.snapToGround();
  rescuerMesh = createRescuerMesh();
  agentsGroup.add(rescuerMesh);
  if (victimMeshes.length) {
    rescuer.setVictims(victimMeshes.map((m, i) => ({
      id: `v${i}`, x: m.position.x, y: m.position.y, z: m.position.z, voidRef: m.userData.voidRef,
    })));
  } else if (voidMarkers.length) {
    spawnVictimMeshes();
  }
  params.rescuerMode = true;
  params.rescuerView = 'third';
  applyRescuerViewMode();
  refreshEquipmentGate();          // somebody is on site: the tool ring unlocks
  setStatus('rescuer on site — WASD move · drag orbit · scroll zoom · T 1st/3rd person · ' +
    'tools 1-8 are now unlocked (walk within arm\'s reach to use one)');
}

function attachVictimsFromMarkers() {
  spawnVictimMeshes();
}

/** Eye height above the soles of the boots — roughly a standing adult. */
const EYE_HEIGHT = 1.65;

/**
 * Each frame: keep the orbit *target* on the rescuer so pan/zoom/tilt stay meaningful
 * as they walk. Do NOT overwrite camera.position every frame — that killed orbit and
 * jammed the view into debris when we forced first-person.
 */
function updateRescuerCamera(dt) {
  if (!rescuer || !params.rescuerMode) return;
  const t = rescuer.translation();
  const k = Math.min(1, dt * 10);
  if (params.rescuerView === 'first') {
    const eyeY = rescuer.feetY() + EYE_HEIGHT;
    const fx = Math.sin(rescuer.yaw);
    const fz = Math.cos(rescuer.yaw);
    // Keep the orbit pivot at the eyes; OrbitControls handles look + zoom around it.
    const pivot = new THREE.Vector3(t.x + fx * 0.1, eyeY, t.z + fz * 0.1);
    controls.target.lerp(pivot, k);
    // Soft-keep the camera near the head so zoom is "lean in", not flying away mid-pile.
    const offset = camera.position.clone().sub(controls.target);
    const dist = offset.length();
    if (dist < 0.02) {
      camera.position.copy(controls.target).add(new THREE.Vector3(-fx, 0.05, -fz).multiplyScalar(0.2));
    } else if (dist > controls.maxDistance) {
      offset.setLength(controls.maxDistance);
      camera.position.copy(controls.target).add(offset);
    }
  } else {
    const chest = new THREE.Vector3(t.x, t.y + 0.55, t.z);
    // Follow the chest with the orbit target; camera rides along because orbit is relative to target.
    const prev = controls.target.clone();
    controls.target.lerp(chest, k);
    camera.position.add(controls.target.clone().sub(prev));
  }
}

function camBasis() {
  // Flatten camera look onto XZ for WASD relative to view.
  const f = new THREE.Vector3();
  camera.getWorldDirection(f);
  f.y = 0;
  if (f.lengthSq() < 1e-6) f.set(0, 0, 1);
  f.normalize();
  const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
  return { forward: { x: f.x, z: f.z }, right: { x: r.x, z: r.z } };
}

function stepRescuer(dt) {
  if (!rescuer) return;
  const basis = camBasis();
  const input = {
    forward: keysDown.has('w') || keysDown.has('arrowup'),
    back: keysDown.has('s') || keysDown.has('arrowdown'),
    left: keysDown.has('a') || keysDown.has('arrowleft'),
    right: keysDown.has('d') || keysDown.has('arrowright'),
    jump: jumpEdge,
    interact: interactEdge,
    camForward: basis.forward,
    camRight: basis.right,
    loadkN: params.rescuerLoad,
  };
  jumpEdge = false;
  interactEdge = false;
  rescuer.step(dt, input);
  // Safety net only for true fall-through / flyaway — not a soft clamp that fights the KCC.
  if (rescuer.feetY() < -1 || rescuer.translation().y > 40) rescuer.snapToGround();
  const t = rescuer.translation();
  syncRescuerMesh(rescuerMesh, t, rescuer.yaw, rescuer.walkPhase, rescuer.mode, aimPoint);
  for (const e of rescuer.drainEvents()) {
    if (e.type === 'VICTIM_ACCESSED') {
      victimsAccessed++;
      setStatus(`✓ VICTIM_ACCESSED — reached survivor without collapsing their void (${victimsAccessed})`);
    } else if (e.type === 'RESCUER_BUMP') {
      ensureAudio();
      playBodyBump();
    } else if (e.type === 'RESCUER_LAND') {
      if (!e.ok) {
        setStatus(e.reason === 'too_steep'
          ? 'landing too steep (>30°) — slid back'
          : 'landing too high (>1 m) — slid back');
      }
    } else if (e.type === 'RESCUER_GRAB_FAIL') {
      setStatus('edge too steep to hold (>30°) — slipped');
    } else if (e.type === 'MANTLE_START') {
      setStatus(`pull-up — climbing ${(e.rise || 0).toFixed(1)} m ledge`);
    } else if (e.type === 'MANTLE_NO_LEDGE') {
      setStatus('no pull-up ledge in range — jump toward an edge ≤7 m, or place a ladder (8)');
    } else if (e.type === 'LADDER_MOUNT') {
      setStatus('on ladder — W/S climb, Space/E dismount');
    } else if (e.type === 'LADDER_NONE_NEAR') {
      setStatus('no ladder in reach — place one with tool 8, or find a mantle ledge');
    }
  }
  // If walking woke the pile, mirror sim.phase into the renderer settle loop.
  if (sim.phase === 'collapsing' && phase === 'frozen') {
    phase = 'collapsing';
    timer = 0;
    settleDuration = params.cutSettleSeconds;
  }
}

// --- load readout ------------------------------------------------------------------------------
const loadsEl = document.getElementById('loads');
function updateLoadPanel() {
  if (!sim) return;
  const rows = [];
  if (sim.frame) {
    const r = sim.frame.report();
    const cls = r.worstUtilization > 1 ? 'bad' : r.worstUtilization > 0.8 ? 'warn' : 'ok';
    rows.push('<h4>Structure</h4>');
    rows.push(`<div class="row"><span>columns standing</span><span>${r.standing}/${r.columns}</span></div>`);
    rows.push(`<div class="row"><span>worst utilization</span><span class="${cls}">${r.worstUtilization.toFixed(2)}</span></div>`);
    rows.push(`<div class="row"><span>dead + live / bay</span><span>${r.deadPerBay.toFixed(0)} + ${r.livePerBay.toFixed(0)} kN</span></div>`);
  }
  const ops = sim.rescue ? sim.rescue.report() : { bags: [], shores: [] };
  if (ops.bags.length) {
    rows.push('<h4>Lifting bags</h4>');
    for (const b of ops.bags) {
      const cls = b.stalled ? 'bad' : b.inflated ? 'ok' : 'warn';
      rows.push(`<div class="row"><span>${b.label}</span><span class="${cls}">` +
        `${b.load.toFixed(0)}/${b.capacity.toFixed(0)} kN</span></div>`);
      rows.push(`<div class="row muted"><span>lift</span><span>${(b.lift * 100).toFixed(0)} / ${(b.maxLift * 100).toFixed(0)} cm` +
        `${b.stalled ? ' — STALLED' : ''}</span></div>`);
    }
  }
  if (ops.shores.length) {
    rows.push('<h4>Shoring</h4>');
    for (const s of ops.shores) {
      const cls = s.failed ? 'bad' : s.utilization > 0.8 ? 'warn' : 'ok';
      rows.push(`<div class="row"><span>${s.label} (${s.governing})</span><span class="${cls}">` +
        `${s.carrying.toFixed(0)}/${s.capacity.toFixed(0)} kN${s.failed ? ' FAILED' : ''}</span></div>`);
    }
  }
  if (ops.ladders && ops.ladders.length) {
    rows.push('<h4>Ladders</h4>');
    rows.push(`<div class="row"><span>placed</span><span>${ops.ladders.length}</span></div>`);
  }
  if (voidMarkers.length) {
    rows.push('<h4>Voids</h4>');
    const cls = compromised > 0 ? 'bad' : 'ok';
    rows.push(`<div class="row"><span>detected</span><span>${voidMarkers.length}</span></div>`);
    rows.push(`<div class="row"><span>compromised</span><span class="${cls}">${compromised}</span></div>`);
  }
  if (rescuer) {
    rows.push('<h4>USAR</h4>');
    rows.push(`<div class="row"><span>rescuer</span><span class="ok">${params.rescuerMode ? 'CONTROL' : 'idle'}</span></div>`);
    rows.push(`<div class="row"><span>victims accessed</span><span class="ok">${victimsAccessed}</span></div>`);
  }
  loadsEl.innerHTML = rows.join('');
}

function rebuild() {
  // Clear the agent WHILE the Rapier world is still alive — disposing the world first
  // left removeCollider/removeRigidBody pointing at freed WASM memory and crashed rebuild.
  clearRescuer();
  clearMarkers();
  resetDust();
  clearSplinters();
  for (const [, mesh] of bagMeshes) { structureGroup.remove(mesh); disposeMesh(mesh); }
  bagMeshes.clear();
  for (const [, mesh] of ladderMeshes) { structureGroup.remove(mesh); disposeMesh(mesh); }
  ladderMeshes.clear();
  compromised = 0; voidEvents.length = 0;
  freezeQueued = false;
  if (sim) sim.dispose();
  sim = new RubbleSim(RAPIER, params, { onAdd, onRemove, onReshape, onExpose, onSplinter });
  const n = sim.build();
  phase = 'standing'; timer = 0;
  // Restore a sensible orbit view after first-person rescuer mode.
  controls.enabled = true;
  controls.target.set(0, 4, 0);
  camera.position.set(15, 12, 17);
  setStatus(`standing ${params.stories}-story building (${n} pieces) — collapse in ${params.standSeconds}s`);
}

function doCollapse() {
  if (!sim || phase !== 'standing') return;
  sim.collapse(); phase = 'collapsing'; timer = 0; settleDuration = params.settleSeconds;
  setStatus('collapsing…');
}

// Freeze must not call Rapier setBodyType while world.step() is in flight — that trips
// "recursive use of an object detected" in rapier-compat (Playwright doFreeze races the RAF).
let freezeQueued = false;
let stepping = false;

function doFreeze() {
  if (!sim || phase === 'frozen') return;
  if (stepping) { freezeQueued = true; return; }
  applyFreeze();
}

function applyFreeze() {
  if (!sim || phase === 'frozen') return;
  freezeQueued = false;
  sim.freeze();
  syncMeshes();
  const voids = sim.detectVoids();
  clearMarkers();
  // Void markers are a *hint* only: a very faint spherical wireframe grid so debris stays
  // readable. Intrusion / compromise still use the AABB from userData.void (radius × height),
  // not the sphere mesh. Toggle with V / showVoidMarkers.
  for (const v of voids) {
    // Bounding sphere that covers the detected pocket (horizontal radius × vertical half-height).
    const r = Math.max(v.radius, v.height / 2);
    // Low segment counts → coarse latitude/longitude grid, not a dense ball of lines.
    const sphereGeo = new THREE.SphereGeometry(r, 10, 6);
    const m = new THREE.LineSegments(
      new THREE.WireframeGeometry(sphereGeo),
      new THREE.LineBasicMaterial({
        color: 0x4fd6ff,
        transparent: true,
        opacity: 0.07,          // barely-there presence
        depthWrite: false,
        depthTest: false,       // still a hint through rubble without a solid fill
      }),
    );
    sphereGeo.dispose();        // WireframeGeometry copies the positions; free the source
    m.renderOrder = 990;
    m.position.set(v.x, v.y, v.z);
    m.visible = params.showVoidMarkers;
    m.userData.void = v;
    m.userData.compromised = false;
    m.layers.set(LAYER_VOID);   // never pickable by a tool
    markerGroup.add(m); voidMarkers.push(m);
  }
  compromised = 0;
  phase = 'frozen';
  updateStressMap();
  // Place prone victim figures at void centres (targets for VICTIM_ACCESSED).
  spawnVictimMeshes();
  // Equilibrium census of the frozen pile: pieces the physics says should still be moving, and
  // pieces whose only load path is a rebar tie (those are the ones that read as "floating").
  const eq = sim.equilibrium;
  const eqNote = eq
    ? ` • ${eq.failing} unstable, ${eq.hanging} on rebar`
    : '';
  setStatus(`frozen • ${sim.parts.length} pieces • ${sim.stats.cracks} cracks • ${sim.stats.snaps} snaps • ${sim.stats.cuts} cuts • ${voids.length} voids${eqNote} — press R to spawn rescuer`);
}

function spawnVictimMeshes() {
  for (const m of victimMeshes) { agentsGroup.remove(m); disposeRescuerMesh(m); }
  victimMeshes.length = 0;
  const maxV = Math.min(voidMarkers.length, 8);
  for (let i = 0; i < maxV; i++) {
    const marker = voidMarkers[i];
    const v = marker.userData.void;
    const mesh = createVictimMesh();
    mesh.position.set(v.x, v.y, v.z);
    mesh.userData.voidRef = v;
    agentsGroup.add(mesh);
    victimMeshes.push(mesh);
  }
  if (rescuer) {
    rescuer.setVictims(victimMeshes.map((m, i) => ({
      id: `v${i}`, x: m.position.x, y: m.position.y, z: m.position.z, voidRef: m.userData.voidRef,
    })));
  }
}

// --- specs.md §4C: SURVIVOR_COMPROMISED ------------------------------------------------------
// If debris shifts into a detected void, the survivable space is gone. Tested as an AABB overlap
// against the part's half-extents (ignoring its rotation, so it errs on the side of warning).
let compromised = 0;
function checkVoidIntrusion() {
  if (!sim) return;
  for (const marker of voidMarkers) {
    if (marker.userData.compromised) continue;
    const v = marker.userData.void;
    for (const part of sim.parts) {
      // Rescuers, victims, ladders, and shores must not alone fire SURVIVOR_COMPROMISED —
      // only debris intrusion destroys the pocket.
      if (part.dead || part.shore || part.ladder || part.agent || part.rescuer || part.victim) continue;
      const t = part.body.translation(), s = part.shape;
      if (Math.abs(t.x - v.x) < v.radius + s.hx &&
          Math.abs(t.z - v.z) < v.radius + s.hz &&
          Math.abs(t.y - v.y) < v.height / 2 + s.hy) {
        marker.userData.compromised = true;
        // Compromised voids stay faint but turn red so the count in the loads panel
        // matches a subtle on-scene cue without re-blocking the debris view.
        marker.material.color.set(0xff3344);
        marker.material.opacity = 0.14;
        compromised++;
        voidEvents.push({ type: 'SURVIVOR_COMPROMISED', x: v.x, y: v.y, z: v.z, by: part.kind });
        if (rescuer) rescuer.markVoidCompromised(v);
        // Paint matching victim red if present.
        for (let i = 0; i < victimMeshes.length; i++) {
          const vm = victimMeshes[i];
          if (Math.hypot(vm.position.x - v.x, vm.position.y - v.y, vm.position.z - v.z) < 0.2) {
            vm.traverse((o) => {
              if (o.isMesh) {
                o.material = o.material.clone();
                o.material.color.set(0xff3344);
              }
            });
          }
        }
        setStatus(`⚠ SURVIVOR_COMPROMISED — ${part.kind} shifted into the void at ` +
          `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`);
        break;
      }
    }
  }
}
const voidEvents = [];

// --- specs.md §4A: stress map ----------------------------------------------------------------
/**
 * Stress fraction for a part, 0..1.
 *  - A standing column reports its real code utilization (demand / capacity) from the FrameModel.
 *  - Debris reports contact force through it, normalised against a reference load — rapier 0.14
 *    exposes no joint-force readback, so the spec's "query Rapier joint forces" is served by the
 *    contact impulses plus the analytic model instead.
 */
function stressOf(part) {
  if (!sim) return 0;
  if (part.member && part.member.kind === 'column' && sim.frame) {
    const node = sim.frame.nodeForMember(part.member);
    if (node) return Math.min(1, node.utilization / 1.0);
  }
  if (sim.support) return Math.min(1, sim.support.contactForceThrough(part) / params.stressRefLoad);
  return 0;
}

function paintPart(part, mat) {
  const obj = part.mesh;
  if (!obj) return;
  if (obj.isMesh && !obj.userData.isRebar) obj.material = mat;
  for (const c of obj.children) if (c.isMesh && !c.userData.isRebar) c.material = mat;
}

function updateStressMap() {
  if (!sim) return;
  if (params.showStress && sim.support) sim.support.rebuild();
  for (const part of sim.parts) {
    if (!part.mesh) continue;
    paintPart(part, params.showStress ? stressMatFor(stressOf(part)) : part.baseMat);
  }
}

// ---------------------------------------------------------------------------
// Equipment — the rescuer carries the tool; the mouse only chooses where he uses it.
//   • hover a valid spot -> contact tick, and the marker goes green
//   • RIGHT-CLICK        -> the tool acts there (grinding sound, hole cut, joint severed, …)
//   left-drag still orbits the camera.
// ---------------------------------------------------------------------------
const cutFx = [];  // fading spark markers: { mesh, ttl }
function addCutMarks(points) {
  for (const p of points) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(0.16, 12, 8),
      new THREE.MeshBasicMaterial({ color: 0xffdd33, transparent: true, opacity: 0.95, depthTest: false }));
    m.position.set(p.x, p.y, p.z);
    markerGroup.add(m); cutFx.push({ mesh: m, ttl: 1.8 });
  }
}
function updateCutFx(dt) {
  for (let i = cutFx.length - 1; i >= 0; i--) {
    const fx = cutFx[i]; fx.ttl -= dt;
    if (fx.ttl <= 0) { markerGroup.remove(fx.mesh); fx.mesh.geometry.dispose(); cutFx.splice(i, 1); }
    else { fx.mesh.material.opacity = 0.95 * (fx.ttl / 1.8); fx.mesh.scale.setScalar(1 + (1.8 - fx.ttl)); }
  }
}

// --- where a square hole would actually land on a tile ----------------------------------------
// A unit square in the XY plane has normal +Z; a slab tile is bored through its own local Y. This
// quaternion is that 90° correction, applied once instead of being re-derived every frame.
const Q_PLANE_TO_TILE = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), -Math.PI / 2);
const _tileQuat = new THREE.Quaternion();
const _tileAxis = new THREE.Vector3();

/**
 * Work out the hole sim.cutHoleInSlab would cut if the tool fired at `worldPoint`.
 *
 * Every slab in src/sim.js is built as { hx: tileHalf, hy: thickness/2, hz: tileHalf }, so the
 * opening is bored along the tile's LOCAL Y and positioned in its local X/Z — which is why this
 * has to be computed in the tile's own frame rather than from the world-space surface normal.
 *
 * @returns null when this tile cannot take the hole at all, otherwise the clamped centre (on the
 *          face we are looking at), the half-extents actually used, and the face's world normal.
 */
function planHole(part, worldPoint, size) {
  if (!part || part.kind !== 'slab' || part.frame || !part.mesh) return null;
  part.mesh.updateWorldMatrix(true, false);
  const local = part.mesh.worldToLocal(worldPoint.clone());
  const s = part.shape;
  const border = 0.06;                       // sim.cutHoleInSlab keeps this much tile all round
  const rx = Math.min(size / 2, s.hx - border);
  const rz = Math.min(size / 2, s.hz - border);
  if (rx <= 0.02 || rz <= 0.02) return null; // nothing left of the tile once the border is kept
  const cx = Math.max(-s.hx + rx + border, Math.min(s.hx - rx - border, local.x));
  const cz = Math.max(-s.hz + rz + border, Math.min(s.hz - rz - border, local.z));

  // Sit the preview on whichever broad face the cursor is on, not on the tile's mid-plane.
  const faceSign = local.y >= 0 ? 1 : -1;
  const centre = part.mesh.localToWorld(new THREE.Vector3(cx, faceSign * s.hy, cz));
  part.mesh.getWorldQuaternion(_tileQuat);
  const normal = _tileAxis.set(0, faceSign, 0).applyQuaternion(_tileQuat).clone();
  return { cx, cz, rx, rz, centre, normal, quat: _tileQuat.clone().multiply(Q_PLANE_TO_TILE) };
}

/**
 * Lay the square on the tile exactly where the plug would come out.
 * `ok` is the eligibility tell: green if right-clicking cuts, amber if the tile is fine but
 * something else (usually the rescuer's reach) is stopping the tool.
 */
function showHolePreview(plan, ok) {
  cutSquare.visible = true;
  cutSquare.position.copy(plan.centre).addScaledVector(plan.normal, 0.02);
  cutSquare.quaternion.copy(plan.quat);
  cutSquare.scale.set(plan.rx * 2, plan.rz * 2, 1);
  const colour = ok ? MARK_OK : MARK_NO;
  squareFill.material.color.setHex(colour);
  squareOutline.material.color.setHex(colour);
}

// --- aim / engagement state ------------------------------------------------------------------
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
let engaged = false, wasEngaged = false, hitPart = null;
const hitPoint = new THREE.Vector3(), hitNormal = new THREE.Vector3(0, 1, 0);
const lastCutWorld = new THREE.Vector3();   // world position of the last cut (for camera framing/tests)
// specs.md §4B — ONE piece of global state for the active tool. Everything else (raycast layer,
// status text, HUD highlight, held prop) derives from it. There is no floating tool cursor.
let activeTool = null;                                   // an EQUIPMENT entry, or null for NONE
const toolKind = () => (activeTool ? activeTool.kind : null);
const toolActive = () => !!activeTool;

// --- rescuer ↔ tool coupling state (DEVLOG 2026-08-01) ---------------------------------------
let blockReason = '';        // why the spot is not eligible — reused verbatim as the HUD message
let aimPoint = null;         // world point the held tool is presented to, or null for a carry pose
let holePlanNow = null;      // planHole() for the tile under the cursor, or null
let heldProp = null;         // the prop clipped into the rescuer's right fist
let toolViewmodel = null;    // first-person forearm + tool, parented to the camera
let cutUntil = 0;            // performance.now() until which the saw is in the concrete
let equipCtrl = null;        // the lil-gui dropdown, so the gate can disable it
// The mouse does not move while the rescuer walks, but the reach envelope moves with him — so the
// aim has to be re-evaluated every frame from the last known pointer position, or a green square
// would sit there after he has walked away from the work face.
const lastPointer = { x: 0, y: 0, has: false };

/**
 * Point the raycaster at only what the current tool can legitimately grab.
 * A torch/pliers see reinforcement (layer 1); cutters and the hammer see concrete (layer 0);
 * bag/shore placement needs the concrete surfaces to find an interface against.
 */
function setRaycastLayers() {
  raycaster.layers.enableAll();
  raycaster.layers.disable(LAYER_VOID);                  // void volumes are never targets
  if (!activeTool) return;
  if (activeTool.picks === 'rebar') raycaster.layers.disable(LAYER_CONCRETE);
  else raycaster.layers.disable(LAYER_REBAR);
}

/**
 * Raycast from the mouse, decide whether right-click would fire, and (for the cutter) lay the
 * hole footprint on the tile. No floating tool cursor — the machine is in the rescuer's hand.
 */
function updateToolAim(clientX, clientY) {
  if (!toolActive() || !sim) return;
  lastPointer.x = clientX; lastPointer.y = clientY; lastPointer.has = true;
  const tool = activeTool;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(structureGroup.children, true);
  cutSquare.visible = false;
  holePlanNow = null;
  aimPoint = null;
  blockReason = '';

  if (!hits.length) {
    engaged = false;
    blockReason = `${tool.label}: nothing under the cursor`;
  } else {
    const h = hits[0];
    hitPoint.copy(h.point);
    if (h.face) hitNormal.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
    hitPart = h.object.userData.part || (h.object.parent && h.object.parent.userData.part) || null;
    const kind = tool.kind;

    // --- 1. does the TOOL have something it can act on here? ---------------------------------
    if (kind === 'rebar') {
      const near = sim.exposedRebarNear(hitPoint, params.cutReach);
      engaged = !!near;
      if (near) hitPoint.set(near.x, near.y, near.z);
      else blockReason = 'no exposed rebar in the mouth — hover a fracture between slab pieces';
    } else if (kind === 'torch') {
      engaged = !!sim.joints.find((rec) => !rec.broken && !rec.a.dead && !rec.b.dead &&
        (rec.type === 'tie' || rec.type === 'member') && jointNear(rec, hitPoint, tool.reach));
      if (!engaged) blockReason = 'no structural joint in torch range';
    } else if (kind === 'bag') {
      engaged = !!hitPart;
      if (!engaged) blockReason = 'no interface here — aim just under a slab edge';
    } else if (kind === 'shore') {
      engaged = shoreFits(hitPoint);
      if (!engaged) blockReason = 'no headroom for a shore here';
    } else if (kind === 'hole') {
      // The cutter bores THROUGH the thickness of one tile, so it needs an intact tile presented
      // face-on. Deciding eligibility here (not in applyEquipment) is what makes a green square
      // mean "right-click will cut".
      const plan = planHole(hitPart, hitPoint, params.holeSize);
      if (!plan) {
        engaged = false;
        blockReason = hitPart && hitPart.frame
          ? 'that tile already has a hole — pick intact concrete'
          : 'aim at an intact slab tile (not a beam, column or fragment)';
      } else if (!isBroadFace(hitNormal, plan.normal)) {
        engaged = false;
        blockReason = 'that is the thin edge of the tile — present the saw to its flat face';
      } else {
        engaged = true;
        holePlanNow = plan;
      }
    } else {
      engaged = true;
      if (kind === 'slice' && hitPart) holePlanNow = planHole(hitPart, hitPoint, params.holeSize);
    }

    // --- 2. can the RESCUER reach it? ---------------------------------------------------------
    // The arm reaches for anything inside the working envelope whatever the tool is, so you can
    // see him present the machine to the work. Only tools flagged `needsReach` are actually
    // REFUSED outside it — the rest keep free aim until they are converted in turn.
    if (rescuer) {
      const res = reachCheck(rescuer.stance(), hitPoint, tool.toolLength || 0);
      if (res.ok) aimPoint = hitPoint.clone();
      if (tool.needsReach && engaged && !res.ok) {
        engaged = false;
        blockReason = reachMessage(res, tool.label);
      }
    } else if (tool.needsReach) {
      engaged = false;
      blockReason = `${tool.label}: no rescuer on site`;
    }

    // Hole footprint only — amber when the tile is fine but he cannot reach it yet.
    if (holePlanNow) showHolePreview(holePlanNow, engaged);
  }

  if (engaged !== wasEngaged && engaged) playContact();   // audible tick as the spot goes live
  wasEngaged = engaged;
}

function jointNear(rec, point, reach) {
  const a = rec.a.body.translation(), b = rec.b.body.translation();
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, mz = (a.z + b.z) / 2;
  return Math.hypot(mx - point.x, my - point.y, mz - point.z) <= reach;
}
function shoreFits(point) {
  if (!sim || !sim.rescue) return false;
  const ray = new RAPIER.Ray({ x: point.x, y: 0.05, z: point.z }, { x: 0, y: 1, z: 0 });
  const hit = sim.world.castRay(ray, sim.opts.storyHeight * 2, true);
  return !!hit && hit.timeOfImpact > 0.55;
}

/**
 * Equipment is inert until somebody is on site to carry it (DEVLOG 2026-08-01). Tools used to be
 * usable with no rescuer at all, anywhere the camera could see — this is the gate that ends that.
 */
const equipmentUnlocked = () => !!rescuer;

/**
 * Put the selected tool into the rescuer's right hand, and build the matching first-person
 * viewmodel. Called on every selection change and whenever a rescuer appears or leaves.
 */
function equipTool(tool) {
  if (rescuerMesh) disposeToolProp(setHeldTool(rescuerMesh, tool ? createToolProp(tool.kind) : null));
  heldProp = rescuerMesh ? heldTool(rescuerMesh) : null;

  if (toolViewmodel) {
    camera.remove(toolViewmodel);
    disposeToolProp(toolViewmodel);
    toolViewmodel = null;
  }
  if (tool) {
    toolViewmodel = createToolViewmodel(tool.kind);
    // Only visible at the eyes: in third person you are looking at the real arm holding the prop.
    toolViewmodel.visible = !!rescuer && params.rescuerMode && params.rescuerView === 'first';
    camera.add(toolViewmodel);
  }
}

/** Grey out the tool ring / GUI dropdown when there is nobody to hold a tool, and vice versa. */
function refreshEquipmentGate() {
  const on = equipmentUnlocked();
  if (equipCtrl) { if (on) equipCtrl.enable(); else equipCtrl.disable(); }
  if (!on && activeTool) setEquipment('None');   // dropping the tool refreshes the ring for us
  else refreshToolRing();
}

function setEquipment(label) {
  const tool = equipmentByLabel(label);
  if (tool && !equipmentUnlocked()) {
    // Bounce the selection rather than half-applying it, so params.equipment and the ring stay
    // in step with `activeTool` no matter which of the three entry points asked for the change.
    params.equipment = activeTool ? activeTool.label : 'None';
    refreshToolRing();
    setStatus('equipment is locked until a rescuer is on site — press R to spawn one');
    return;
  }
  activeTool = tool || null;
  params.equipment = tool ? tool.label : 'None';
  cutSquare.visible = false;
  engaged = false; wasEngaged = false;
  aimPoint = null; holePlanNow = null; blockReason = '';
  setRaycastLayers();
  refreshToolRing();
  equipTool(tool);
  // left-drag still orbits; free the RIGHT button so right-click can cut / place
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  controls.mouseButtons.RIGHT = tool ? null : THREE.MOUSE.PAN;
  if (!tool) { setStatus('tool: none — left-drag orbits'); return; }
  setStatus(`${tool.label} in hand — ${tool.hint}` +
    (tool.needsReach ? ' Walk within arm\'s reach; RIGHT-CLICK an eligible spot to use.' : ' RIGHT-CLICK to use.'));
}

// Use the active tool at the aim point (right-click / Apply / Enter).
function applyEquipment() {
  if (!sim || !activeTool) return;
  const tool = activeTool;
  if (!engaged) {
    setStatus(blockReason || `${tool.label}: no eligible spot under the cursor`);
    return;
  }
  const point = { x: hitPoint.x, y: hitPoint.y, z: hitPoint.z };

  if (tool.kind === 'hole') {
    // `holePlanNow` is the same square the green preview is showing, so what you see is what the
    // physics core is asked to cut — including the clamping that keeps a border of tile intact.
    const plan = holePlanNow;
    if (!plan) { setStatus(blockReason || 'could not cut a hole there'); return; }

    // Square up to the work before the saw goes in. Aim already refused anything more than 60°
    // off his heading, so this is a small correction, not a spin.
    if (rescuer) rescuer.faceTowards(plan.centre.x, plan.centre.z);

    const res = sim.cutHoleInSlab(hitPart, plan.cx, plan.cz, plan.rx, plan.rz);
    if (!res) { setStatus('could not cut a hole there'); return; }
    grind(900);
    cutUntil = performance.now() + 900;       // saw spins and the viewmodel kicks for this long
    lastCutWorld.set(res.holeWorld.x, res.holeWorld.y, res.holeWorld.z);
    addCutMarks([res.holeWorld]);
    resume();
    // A tile lying flat is a floor and a tile on edge is a wall — the cut runs in the plane of
    // whichever face he presented the saw to.
    const plane = cutPlaneOf(plan.normal);
    setStatus(plane === 'horizontal'
      ? `✂ ${(plan.rx * 2).toFixed(2)} m square cut in a near-horizontal plane — plug dropping into the void below`
      : `✂ ${(plan.rx * 2).toFixed(2)} m square cut in a near-vertical plane — plug falling out of the wall face`);
    return;
  }

  if (tool.kind === 'slice') {
    if (!hitPart || hitPart.kind !== 'slab') { setStatus('the saw slices slab tiles — aim at one'); return; }
    hitPart.mesh.updateWorldMatrix(true, false);
    const local = hitPart.mesh.worldToLocal(hitPoint.clone());
    // slice across the shorter run so both halves stay substantial
    const axis = Math.abs(local.x) <= Math.abs(local.z) ? 'x' : 'z';
    const res = tool.apply(sim, { part: hitPart, local, axis });
    if (!res.severed) { setStatus('cannot slice there — too close to an edge, or the tile already has a hole'); return; }
    grind(500);
    lastCutWorld.set(res.points[0].x, res.points[0].y, res.points[0].z);
    addCutMarks(res.points);
    resume();
    setStatus('✂ slab sliced through — the piece split off keeps its momentum');
    return;
  }

  if (tool.kind === 'bag') {
    const res = tool.apply(sim, { point, bagId: params.bagSize });
    if (!res.bag) { setStatus('no interface here — aim just under a slab edge with something above it'); return; }
    const b = res.bag;
    resume();
    setStatus(b.stalled
      ? `⚠ bag STALLED — ${b.load.toFixed(0)} kN of debris vs a ${b.capacity.toFixed(0)} kN bag. Shore it or shed weight.`
      : `bag placed — ${b.load.toFixed(0)} kN on a ${b.capacity.toFixed(0)} kN bag, inflating…`);
    return;
  }

  if (tool.kind === 'shore') {
    const res = tool.apply(sim, { point, shoreId: params.shoreType });
    if (!res.shore) { setStatus('no headroom for a shore here — need ≥ 0.5 m of clear height above the floor'); return; }
    const s = res.shore;
    resume();
    setStatus(`${s.spec.label} erected — ${s.length.toFixed(2)} m post, capacity ${s.capacity.toFixed(0)} kN (${s.governing})`);
    return;
  }

  if (tool.kind === 'ladder') {
    const res = tool.apply(sim, { point });
    if (!res.ladder) { setStatus('no wall face nearby — aim at a near-vertical slab/wall within ~2 m'); return; }
    syncLadderMeshes();
    const L = res.ladder;
    setStatus(`ladder placed — ${L.length.toFixed(2)} m. Enter rescuer mode (R) and press E to climb.`);
    return;
  }

  // torch / pliers / hammer: all one-shot point tools
  if (tool.kind === 'rebar') tool.reach = params.cutReach;
  const res = tool.apply(sim, { point });
  if (!res.severed) {
    setStatus(tool.kind === 'rebar'
      ? 'no exposed rebar in the mouth — hover a fracture between slab pieces'
      : `${tool.label}: nothing to act on there`);
    return;
  }
  grind(300);
  if (res.points[0]) { lastCutWorld.set(res.points[0].x, res.points[0].y, res.points[0].z); addCutMarks(res.points); }
  resume();
  if (tool.kind === 'hammer') {
    setStatus(`hammer — concrete spalled${res.spalled ? ' (section lost: buckling capacity down)' : ''}` +
      `${res.exposed ? ', rebar exposed' : ''}`);
  } else {
    setStatus(`✂ ${tool.label} — joint severed, ${res.woken ?? 0} pieces re-settling`);
  }
}

// --- per-frame upkeep of everything that ties the tool to the man -----------------------------
const _camAim = new THREE.Vector3();
const _invCamQuat = new THREE.Quaternion();

/**
 * Direction from the eye to the work point, expressed in CAMERA space (-Z forward). The
 * first-person viewmodel leans this way so the tool visibly follows the cursor.
 */
function viewmodelAimDir() {
  const p = aimPoint || (engaged ? hitPoint : null);
  if (!p) return null;
  _invCamQuat.copy(camera.quaternion).invert();
  return _camAim.copy(p).sub(camera.position).normalize().applyQuaternion(_invCamQuat);
}

/**
 * Called once per frame before the rescuer steps.
 *
 * Three things have to happen every frame rather than on mouse events: the aim must be
 * re-tested (the reach envelope walks around with the rescuer even when the mouse is still), the
 * rescuer eases round to square up with valid work, and the held prop / viewmodel animate.
 */
function updateToolPose(dt) {
  const cutting = performance.now() < cutUntil ? 1 : 0;
  if (toolActive() && lastPointer.has) updateToolAim(lastPointer.x, lastPointer.y);

  // Turn toward the work — but only while standing still (walking owns the heading), and only
  // toward a point that ALREADY passed the working-cone test, so auto-turn can never be used to
  // creep round to something behind him.
  if (rescuer && aimPoint && rescuer.mode === 'idle') {
    rescuer.faceTowards(aimPoint.x, aimPoint.z, dt, 2.5);
  }

  spinToolProp(heldProp, dt, cutting);
  if (toolViewmodel && toolViewmodel.visible) {
    aimToolViewmodel(toolViewmodel, viewmodelAimDir(), dt, cutting);
  }
}

function grind(ms) { ensureAudio(); startGrind(); setTimeout(stopGrind, ms); }
function resume() { settleDuration = params.cutSettleSeconds; phase = 'collapsing'; timer = 0; }

renderer.domElement.addEventListener('contextmenu', (e) => { if (toolActive()) e.preventDefault(); });
renderer.domElement.addEventListener('pointermove', (e) => updateToolAim(e.clientX, e.clientY));
renderer.domElement.addEventListener('pointerdown', (e) => {
  // Right-click an eligible spot: the tool is already in his hand, so just cut / place.
  if (e.button === 2 && toolActive()) { e.preventDefault(); updateToolAim(e.clientX, e.clientY); applyEquipment(); }
});

// --- tool ring HUD (specs.md §4B) -----------------------------------------------------------
const TOOL_ICONS = {
  hole: '⬛', slice: '🪚', rebar: '✂', torch: '🔥', hammer: '🔨', bag: '🎈', shore: '🪵', ladder: '🪜',
};
const ringEl = document.getElementById('toolring');
function buildToolRing() {
  ringEl.innerHTML = '';
  const mk = (label, icon, key, tool) => {
    const b = document.createElement('button');
    b.innerHTML = `<span class="ic">${icon}</span><span>${label}</span><span class="kb">${key}</span>`;
    b.title = tool ? tool.hint : 'No tool — left-drag orbits';
    b.addEventListener('click', () => setEquipment(tool ? tool.label : 'None'));
    b.dataset.tool = tool ? tool.id : 'NONE';
    ringEl.appendChild(b);
  };
  mk('None', '✋', '0', null);
  for (const t of EQUIPMENT) mk(t.short || t.label, TOOL_ICONS[t.kind] || '•', t.key, t);
}
function refreshToolRing() {
  const on = equipmentUnlocked();
  for (const b of ringEl.children) {
    b.setAttribute('aria-pressed', String(b.dataset.tool === (activeTool ? activeTool.id : 'NONE')));
    // 'None' is always available — it is how you put a tool down, not a tool itself.
    b.disabled = !on && b.dataset.tool !== 'NONE';
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a'); a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}
function exportSTL() {
  download(`Collapse_seed${params.seed}.stl`, new STLExporter().parse(structureGroup, { binary: true }), 'application/octet-stream');
  setStatus('exported debris STL');
}
function exportVoids() {
  const voids = (sim && sim.voids) || [];
  download(`Voids_seed${params.seed}.json`, JSON.stringify({ seed: params.seed, voids }, null, 2), 'application/json');
  setStatus('exported voids JSON');
}

// ---------------------------------------------------------------------------
// GUI + input
// ---------------------------------------------------------------------------
const gui = new GUI({ title: 'RubbleSim Web — collapse' });
gui.add(params, 'seed', 0, 9999, 1);
const fB = gui.addFolder('Building');
fB.add(params, 'stories', 1, 8, 1);
fB.add(params, 'buildingSize', 3, 12, 0.5);
fB.add(params, 'grid', 2, 4, 1);
fB.add(params, 'furniturePerFloor', 0, 8, 1);
const fR = gui.addFolder('Rebar lattice');
fR.add(params, 'rebarLayers', 1, 6, 1).name('layers / slab');
fR.add(params, 'rebarSpacing', 0.15, 0.50, 0.05).name('grid spacing (m)');
fR.add(params, 'rebarThickness', 0.003, 0.015, 0.001).name('rod radius (m)');
fR.add(params, 'rebarCover', 0.02, 0.08, 0.005).name('cover from face (m)');
const fP = gui.addFolder('Physics');
fP.add(params, 'gravity', 9.81, 40, 0.5);
fP.add(params, 'restitution', 0, 0.4, 0.01);
fP.add(params, 'friction', 0.2, 1.2, 0.05);
const fF = gui.addFolder('Failure');
fF.add(params, 'failureProfile', ['softStory', 'pancake', 'progressive']).name('failure profile');
fF.add(params, 'beamSnapForce', 100, 4000, 50).name('column/beam snap force kN');
fF.add(params, 'beamSnapAngle', 0.002, 0.1, 0.002).name('column/beam snap angle');
fF.add(params, 'slabCrackForce', 200, 4000, 50).name('slab crack force kN');
fF.add(params, 'slabTearAngle', 0.3, 1.2, 0.05).name('slab rebar tear angle');
fF.add(params, 'maxBreaksPerMember', 0, 3, 1).name('max snaps / member');
// Structural design (specs.md §2B). designSafetyFactor is the interesting one: at ~1.8 (code
// compliant) the frame survives losing a single column; below ~1.3 that same loss cascades.
const fS = gui.addFolder('Structure (loads & capacity)');
fS.add(params, 'designSafetyFactor', 0.8, 3, 0.05).name('design safety factor');
fS.add(params, 'liveLoadFloor', 0, 8, 0.5).name('floor live load kPa');
fS.add(params, 'deadLoadSuper', 0, 5, 0.5).name('superimposed dead kPa');
fS.add(params, 'concreteFc', 10e3, 50e3, 1e3).name("f'c kPa (mix strength)");
fS.add(params, 'rescuerLoad', 0.5, 5, 0.1).name('rescuer live load kN');
const fT = gui.addFolder('Timing / voids');
fT.add(params, 'standSeconds', 0, 5, 0.2);
fT.add(params, 'settleSeconds', 3, 15, 0.5);
fT.add(params, 'cutSettleSeconds', 1, 8, 0.5).name('cut re-settle secs');
fT.add(params, 'minVoidHeight', 0.3, 1.5, 0.05);
fT.add(params, 'showVoidMarkers').onChange((v) => voidMarkers.forEach((m) => (m.visible = v)));
const fEq = gui.addFolder('Equipment');
// Held in a module-level `let` (declared with the tool state) so refreshEquipmentGate can grey the
// dropdown out while there is no rescuer to carry anything.
equipCtrl = fEq.add(params, 'equipment', TOOL_LABELS).onChange(setEquipment).listen();
equipCtrl.disable();          // nothing is on site yet at boot
fEq.add(params, 'holeSize', 0.3, 1.5, 0.1).name('hole size (concrete)');
fEq.add(params, 'cutReach', 0.2, 1.0, 0.05).name('rebar reach (mouth)');
fEq.add(params, 'bagSize', LIFT_BAGS.map((b) => b.id)).name('lifting bag');
fEq.add(params, 'shoreType', SHORE_TYPES.map((s) => s.id)).name('shore type');
fEq.add({ apply: () => applyEquipment() }, 'apply').name('Apply / use (Enter)');
const fV = gui.addFolder('Feedback');
fV.add(params, 'showStress').name('stress map (S)').onChange(() => updateStressMap());
fV.add(params, 'stressRefLoad', 25, 500, 5).name('stress ref load kN');
fV.add(params, 'stressEveryNFrames', 1, 30, 1).name('stress every N frames');
gui.add(params, 'rebuild').name('Rebuild (P)');
gui.add(params, 'collapseNow').name('Collapse (C)');
gui.add(params, 'freezeNow').name('Freeze now (F)');
gui.add(params, 'spawnRescuer').name('Spawn rescuer (R)');
gui.add(params, 'rescuerMode').name('Rescuer control').listen().onChange((v) => {
  if (v && !rescuer) spawnRescuer();
  if (v) {
    applyRescuerViewMode();
    setStatus('rescuer control ON — shoulder cam, drag to orbit, scroll zoom, WASD move');
  } else {
    controls.enabled = true;
    controls.enablePan = true;
    controls.minDistance = 1;
    controls.maxDistance = 200;
    if (rescuerMesh) rescuerMesh.visible = true;
    setStatus('rescuer control OFF — free orbit');
  }
});
gui.add(params, 'rescuerView', ['third', 'first']).name('Rescuer view').listen().onChange(() => {
  if (params.rescuerMode && rescuer) applyRescuerViewMode();
});
gui.add(params, 'exportSTL').name('Export debris STL');
gui.add(params, 'exportVoids').name('Export voids JSON');

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  // Track movement keys even when typing isn't the focus — rescuer mode needs them.
  keysDown.add(k);
  if (!e.repeat && (k === ' ' || k === 'spacebar')) { jumpEdge = true; e.preventDefault(); }
  if (!e.repeat && k === 'e' && params.rescuerMode) { interactEdge = true; e.preventDefault(); return; }

  if (k === 'p') rebuild();
  else if (k === 'c') doCollapse();
  else if (k === 'f') doFreeze();
  else if (k === 'r') {
    if (!rescuer) spawnRescuer();
    else {
      params.rescuerMode = !params.rescuerMode;
      if (params.rescuerMode) {
        applyRescuerViewMode();
        setStatus('rescuer control ON — shoulder cam · drag orbit · scroll zoom');
      } else {
        controls.enabled = true;
        controls.enablePan = true;
        controls.minDistance = 1;
        controls.maxDistance = 200;
        if (rescuerMesh) rescuerMesh.visible = true;
        setStatus('rescuer control OFF — free orbit');
      }
    }
  }
  else if (k === 't' && params.rescuerMode && rescuer) {
    // Toggle third-person shoulder ↔ first-person eyes (V is already void markers).
    params.rescuerView = params.rescuerView === 'first' ? 'third' : 'first';
    applyRescuerViewMode();
    setStatus(params.rescuerView === 'first'
      ? '1st-person eyes — drag look · scroll zoom'
      : '3rd-person shoulder — drag orbit · scroll zoom · pan');
  }
  else if (k === 'v') { params.showVoidMarkers = !params.showVoidMarkers; voidMarkers.forEach((m) => (m.visible = params.showVoidMarkers)); }
  else if (k === 's' && !params.rescuerMode) {
    params.showStress = !params.showStress; updateStressMap();
    setStatus(`stress map ${params.showStress ? 'ON — grey→red is utilization / contact load' : 'off'}`);
  }
  else if (k === 'enter') applyEquipment();
  else if (k === '0') setEquipment('None');
  else if (k >= '1' && k <= '8') {
    // 1..8 select a tool. setEquipment itself refuses when no rescuer is on site, so the keyboard
    // cannot be used to slip past the ring being greyed out.
    const tool = EQUIPMENT.find((t) => t.key === k);
    if (tool) setEquipment(tool.label);
  }
});
addEventListener('keyup', (e) => { keysDown.delete(e.key.toLowerCase()); });

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const _p = new THREE.Vector3(), _q = new THREE.Quaternion();
let last = performance.now();

function syncMeshes() {
  for (const part of sim.parts) {
    if (!part.mesh) continue;
    const t = part.body.translation(), r = part.body.rotation();
    part.mesh.position.copy(_p.set(t.x, t.y, t.z));
    part.mesh.quaternion.copy(_q.set(r.x, r.y, r.z, r.w));
  }
}

let frameNo = 0;
function tick() {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.05); last = now;
  frameNo++;

  // Apply any freeze that was requested while world.step() was running.
  if (freezeQueued) applyFreeze();

  if (phase === 'standing') {
    timer += dt;
    if (timer >= params.standSeconds) doCollapse();
  } else if (phase === 'collapsing') {
    stepping = true;
    try {
      sim.step();
    } finally {
      stepping = false;
    }
    syncMeshes();
    syncBagMeshes();
    syncLadderMeshes();
    ingestSimDust();
    checkVoidIntrusion();          // §4C — debris shifting into a survivable void
    timer += dt;
    // Freeze only once the pile has actually stopped — freezing on a stopwatch alone is what used
    // to catch pieces mid-fall and leave them hanging in the air. The cap keeps a pile that never
    // fully converges (a slab creeping on a slope) from blocking the run for ever.
    if (timer >= settleDuration && (sim.isSettled() || timer >= settleDuration * SETTLE_CAP)) {
      doFreeze();
    }
    if (freezeQueued) applyFreeze();
  }

  // Keep the aim, the arm and the held prop in step with where he is standing NOW.
  updateToolPose(dt);

  // Rescuer moves on frozen rubble (and during re-settle). Camera follow when control is on.
  if (rescuer && (phase === 'frozen' || phase === 'collapsing')) {
    if (params.rescuerMode) stepRescuer(dt);
    else if (rescuerMesh) {
      const t = rescuer.translation();
      syncRescuerMesh(rescuerMesh, t, rescuer.yaw, rescuer.walkPhase, rescuer.mode, aimPoint);
    }
    syncLadderMeshes();
  }
  if (params.rescuerMode && rescuer) updateRescuerCamera(dt);
  else if (!params.rescuerMode) controls.enabled = true;

  // §4A — the stress map is sampled every N frames, not every frame: rebuilding the support
  // graph means walking every contact manifold in the pile.
  if (params.showStress && phase === 'collapsing' && frameNo % params.stressEveryNFrames === 0) updateStressMap();
  if (frameNo % 10 === 0) updateLoadPanel();

  if (cutFx.length) updateCutFx(dt);
  updateDust(dt);
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

// Test hook (only with ?test in the URL) so Playwright can drive the tools headlessly.
if (location.search.includes('test')) {
  window.__app = {
    params, setEquipment, applyEquipment, doCollapse, doFreeze,
    phase: () => phase, sim: () => sim, camera, controls,
    holePreview: () => cutSquare.visible,
    lastCut: () => lastCutWorld,
    engaged: () => engaged,
    // structural / rescue state for the newer features
    frameReport: () => (sim.frame ? sim.frame.report() : null),
    rescueReport: () => (sim.rescue ? sim.rescue.report() : null),
    voids: () => voidMarkers.map((m) => m.userData.void),
    compromised: () => compromised,
    rescuer: () => rescuer,
    spawnRescuer,
    // Park the rescuer at a work face. `snap` false keeps the exact pose, which is what a reach
    // test wants — snapping would drop him onto whatever happens to be under that column.
    teleportRescuer: (pos, yaw = 0, snap = false) => {
      if (rescuer) rescuer.teleport(pos, yaw, snap);
    },
    // Everything the tool ↔ rescuer coupling decides, in one readable object.
    toolState: () => ({
      tool: activeTool ? activeTool.id : 'NONE',
      unlocked: equipmentUnlocked(),
      engaged,
      reason: blockReason,
      aiming: !!aimPoint,
      holdingProp: !!heldProp,
      viewmodel: !!toolViewmodel && toolViewmodel.visible,
      cutPlane: holePlanNow ? cutPlaneOf(holePlanNow.normal) : null,
    }),
    toolRingDisabled: () => [...ringEl.children].filter((b) => b.disabled).length,
    victimsAccessed: () => victimsAccessed,
    voidEvents: () => voidEvents.slice(),
    activeTool: () => (activeTool ? activeTool.id : 'NONE'),
    toolRing: () => [...ringEl.children].map((b) => ({ tool: b.dataset.tool, on: b.getAttribute('aria-pressed') === 'true' })),
    stressOf: (part) => stressOf(part),
    updateStressMap,
    hit: () => ({ x: hitPoint.x, y: hitPoint.y, z: hitPoint.z, part: hitPart ? hitPart.kind : null }),
    // world point of the first exposed rebar (cracked tie) — for tests
    firstRebar: () => {
      for (const r of sim.joints) if (r.type === 'tie' && r.cracked && !r.broken && !r.a.dead && !r.b.dead) {
        const a = r.a.body.translation(), b = r.b.body.translation();
        return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, z: (a.z + b.z) / 2 };
      }
      return null;
    },
    // project a world point to canvas pixel coords — for driving the mouse in tests
    project: (p) => { const v = new THREE.Vector3(p.x, p.y, p.z).project(camera);
      return { x: (v.x * 0.5 + 0.5) * innerWidth, y: (1 - (v.y * 0.5 + 0.5)) * innerHeight }; },
  };
}

await RAPIER.init();
buildToolRing();
setEquipment('None');
rebuild();
tick();
