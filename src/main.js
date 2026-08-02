// RubbleSim Web — renderer. Drives the framework-agnostic physics core (src/sim.js)
// and mirrors each physics part as a three.js mesh. See sim.js for the collapse model.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import GUI from 'lil-gui';
import RAPIER from '@dimforge/rapier3d-compat';
import { RubbleSim, DEFAULTS } from './sim.js';
import { AVAILABLE_EQUIPMENT, TOOL_LABELS, equipmentByLabel } from './equipment.js';
import { LIFT_BAGS, SHORE_TYPES } from './rescue.js';
import { ensureAudio, playContact, playBodyBump, startGrind, stopGrind, startHammer, stopHammer } from './audio.js';
import { RescuerAgent } from './rescuer.js';
import { CAPSULE_HALF, CAPSULE_RADIUS } from './rescuer-constants.js';
import {
  createRescuerMesh, createVictimMesh, createLadderMesh, createStretcherTrolley,
  syncRescuerMesh, disposeRescuerMesh, setHeldTool, heldTool,
} from './rescuer-mesh.js';
import {
  createToolProp, createToolViewmodel, aimToolViewmodel, spinToolProp, disposeToolProp,
} from './tool-mesh.js';
import {
  reachCheck, reachMessage, cutPlaneOf, isBroadFace,
} from './rescuer-reach.js';
import { victimsBurnedByCut } from './torch-heat.js';

const statusEl = document.getElementById('status');
/** Sticky success / fail toasts — locomotion spam must not overwrite them for a few seconds. */
let statusStickyUntil = 0;
const setStatus = (t, { stickyMs = 0 } = {}) => {
  const now = performance.now();
  if (stickyMs <= 0 && now < statusStickyUntil) return;
  statusEl.textContent = t;
  if (stickyMs > 0) statusStickyUntil = now + stickyMs;
};

const params = {
  ...DEFAULTS,
  standSeconds: 1.2,
  settleSeconds: 8,
  equipment: 'None',          // active tool label; the enum lives in src/equipment.js
  cutReach: 0.55,             // rebar-cutter mouth reach (m) — short (hydraulic pliers)
  holeSize: 0.6,             // concrete-cutter square side (m)
  hammerStartRadius: 0.10,   // demolition-hammer first bite (m)
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

// --- Cut / snip previews (concrete cutter + rebar cutter) --------------------------------------
//
// The old floating tool sprites are gone: the rescuer carries the real machine in his right hand
// (src/tool-mesh.js). Aim with the mouse, right-click an eligible spot, and the tool fires. The
// on-screen tells left are:
//   * cutter — the square footprint of the hole it would open
//   * rebar  — a small crosshair on the exposed bar the mouth would snip
// Green means right-click will fire; amber means the target is fine but something else (usually
// the rescuer's reach) is stopping him.
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

// Rebar snip mark: a small + crosshair sitting on the exposed bar. Built once as a unit cross and
// scaled in showRebarPreview so the mouth size (params.cutReach) can grow without rebuilding.
const rebarMark = new THREE.Group();
rebarMark.visible = false;
{
  const arm = 0.5;   // half-extent of the unit cross before scale
  const pts = [
    new THREE.Vector3(-arm, 0, 0), new THREE.Vector3(arm, 0, 0),
    new THREE.Vector3(0, -arm, 0), new THREE.Vector3(0, arm, 0),
    new THREE.Vector3(0, 0, -arm), new THREE.Vector3(0, 0, arm),
  ];
  const cross = new THREE.LineSegments(
    new THREE.BufferGeometry().setFromPoints(pts),
    new THREE.LineBasicMaterial({ color: MARK_OK, depthTest: false }),
  );
  cross.renderOrder = 998;
  // Soft fill sphere so the seam still reads when the cross is edge-on to the camera.
  const bead = new THREE.Mesh(
    new THREE.SphereGeometry(0.35, 10, 8),
    new THREE.MeshBasicMaterial({ color: MARK_OK, transparent: true, opacity: 0.45, depthTest: false, depthWrite: false }),
  );
  bead.renderOrder = 997;
  rebarMark.add(cross, bead);
  rebarMark.userData.cross = cross;
  rebarMark.userData.bead = bead;
}
scene.add(rebarMark);

// Demolition-hammer footprint: a unit circle in the XY plane (normal +Z), scaled to the current
// breach radius. Same green/amber language as the cutter square.
const hammerMark = new THREE.Group();
hammerMark.visible = false;
{
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.42, 0.5, 32),
    new THREE.MeshBasicMaterial({ color: MARK_OK, transparent: true, opacity: 0.85, side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
  );
  const fill = new THREE.Mesh(
    new THREE.CircleGeometry(0.45, 32),
    new THREE.MeshBasicMaterial({ color: MARK_OK, transparent: true, opacity: 0.28, side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
  );
  ring.renderOrder = 998; fill.renderOrder = 997;
  hammerMark.add(fill, ring);
  hammerMark.userData.ring = ring;
  hammerMark.userData.fill = fill;
}
scene.add(hammerMark);

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
/** Detected survivable pockets — data only (no wireframe meshes). Victims sit on floorY. */
const voidsList = [];
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
// tool can restrict what it is physically able to grab. Rebar cutter → layer 1 only; oxy
// torch → concrete (beam faces) so it can melt member joints, not snip cage rods.
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

/**
 * Rebuild ONLY the rebar child after a rod has been snipped. The concrete shell (box or hole
 * frame) stays put — we just tear out the old merged cylinder mesh and attach a fresh one from
 * the updated `part.rebars` descriptors.
 */
function onRebarChange(part) {
  if (!part?.mesh) return;
  const doomed = [];
  part.mesh.traverse((o) => { if (o.userData?.isRebar) doomed.push(o); });
  for (const o of doomed) {
    if (o.parent) o.parent.remove(o);
    disposeMesh(o);
  }
  attachRebar(part.mesh, part);
  if (part.rebarExposed) showRebar(part);
}

function clearVoids() { voidsList.length = 0; }

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
/** Stretchers parked outside the rubble — one bay, victims line up as they are reached. */
const stretchers = [];
const triageGroup = new THREE.Group();
triageGroup.name = 'triageBay';
scene.add(triageGroup);
/** In-flight “lift off the board” moves: { mesh, from, to, t, duration }. */
const evacuations = [];
let victimsAccessed = 0;
/** Compromises that score −1 (only after a rescue tool woke the pile). */
let rescuerCompromised = 0;
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
  for (const m of victimMeshes) {
    if (m.parent) m.parent.remove(m);
    disposeRescuerMesh(m);
  }
  victimMeshes.length = 0;
  clearTriageBay();
  victimsAccessed = 0;
  rescuerCompromised = 0;
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
 * Tear down every stretcher and cancel in-flight evacuations (regenerate / despawn).
 */
function clearTriageBay() {
  evacuations.length = 0;
  for (const s of stretchers) {
    triageGroup.remove(s);
    disposeRescuerMesh(s);
  }
  stretchers.length = 0;
  while (triageGroup.children.length) {
    const c = triageGroup.children[0];
    triageGroup.remove(c);
    disposeRescuerMesh(c);
  }
}

/**
 * World pose for stretcher slot `index` — lined up clearly outside the rubble footprint
 * on +X, like captured chess pieces along the side of the board.
 */
function stretcherSlotPose(index) {
  const edge = (params.buildingSize || 6) / 2 + 6.0;
  return {
    x: edge,
    y: 0,
    z: -4.0 + index * 1.5,
    yaw: Math.PI / 2, // bed long-axis along world X (radial from the pile)
  };
}

/**
 * Ensure stretcher `index` exists in the triage bay (lazy — only spawn as victims are reached).
 */
function ensureStretcher(index) {
  while (stretchers.length <= index) {
    const i = stretchers.length;
    const trolley = createStretcherTrolley();
    const pose = stretcherSlotPose(i);
    trolley.position.set(pose.x, pose.y, pose.z);
    trolley.rotation.y = pose.yaw;
    triageGroup.add(trolley);
    stretchers.push(trolley);
  }
  // Force a fresh world matrix — first-frame matrixWorld can be identity before the
  // renderer ticks, which parked survivors at the origin (looked like a vanish).
  stretchers[index].updateMatrixWorld(true);
  return stretchers[index];
}

/**
 * Resolve the mesh for a VICTIM_ACCESSED event. Prefer exact victimId — fuzzy position
 * matching was painting a neighbour green while evacuating (or losing) the wrong figure.
 */
function findVictimMeshForEvent(e) {
  if (e?.victimId != null) {
    const byId = victimMeshes.find(
      (m) => !m.userData.evacuated && m.userData.victimId === e.victimId,
    );
    if (byId) return byId;
  }
  // Fallback: nearest non-evacuated mesh to the event point (still prefer identity).
  let best = null;
  let bestD = 0.55;
  for (const m of victimMeshes) {
    if (m.userData.evacuated) continue;
    const d = Math.hypot(m.position.x - e.x, m.position.z - e.z);
    if (d < bestD) {
      bestD = d;
      best = m;
    }
  }
  return best;
}

/**
 * Chess-piece take: lift the survivor out of the void and park them on the next
 * stretcher outside the rubble. Short scripted hop in world space, then reparent.
 */
function evacuateVictimToStretcher(vm, slotIndex) {
  if (!vm || vm.userData.evacuated) return;
  vm.userData.evacuated = true;
  vm.visible = true;

  // High-vis “rescued” paint — only this mesh (never a neighbour).
  vm.traverse((o) => {
    if (o.isMesh && o.material) {
      o.material = o.material.clone();
      o.material.color.set(0x33cc66);
      o.material.needsUpdate = true;
    }
  });

  const trolley = ensureStretcher(slotIndex);
  const bedY = trolley.userData.bedY ?? 0.85;
  // World destination = trolley origin + up along bed (yaw does not tilt Y).
  const dest = new THREE.Vector3(
    trolley.position.x,
    bedY + 0.1,
    trolley.position.z,
  );
  // Capture world start in case the mesh was already nested somewhere unusual.
  const from = new THREE.Vector3();
  vm.getWorldPosition(from);

  // Keep the hop under agentsGroup in world space (avoids parent-matrix surprises mid-flight).
  if (vm.parent !== agentsGroup) {
    if (vm.parent) vm.parent.remove(vm);
    agentsGroup.add(vm);
    vm.position.copy(from);
  }

  evacuations.push({
    mesh: vm,
    from: from.clone(),
    to: dest.clone(),
    t: 0,
    duration: 0.55,
    trolley,
    bedLocalY: bedY + 0.1,
  });
}

/**
 * Advance in-flight evacuations — ease out of the pile, brief apex, settle onto the bed.
 */
function stepEvacuations(dt) {
  for (let i = evacuations.length - 1; i >= 0; i--) {
    const ev = evacuations[i];
    if (!ev.mesh) {
      evacuations.splice(i, 1);
      continue;
    }
    ev.t += dt;
    const u = Math.min(1, ev.t / ev.duration);
    const s = u * u * (3 - 2 * u);
    const lift = Math.sin(Math.PI * u) * 1.6;
    ev.mesh.position.set(
      ev.from.x + (ev.to.x - ev.from.x) * s,
      ev.from.y + (ev.to.y - ev.from.y) * s + lift,
      ev.from.z + (ev.to.z - ev.from.z) * s,
    );
    ev.mesh.visible = true;
    if (u >= 1) {
      const trolley = ev.trolley;
      if (trolley) {
        // attach() preserves world transform then we snap to bed-local — reliable reparent.
        trolley.attach(ev.mesh);
        ev.mesh.position.set(0, ev.bedLocalY, 0);
        // Lie along the bed (trolley local +Z is the long axis).
        ev.mesh.rotation.set(0, 0, 0);
        ev.mesh.visible = true;
        trolley.updateMatrixWorld(true);
      } else {
        ev.mesh.position.copy(ev.to);
      }
      evacuations.splice(i, 1);
    }
  }
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
  const eyeY = rescuer.feetY() + rescuerEyeHeight();
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
      id: m.userData.victimId || `v${i}`,
      x: m.position.x, y: m.position.y, z: m.position.z, voidRef: m.userData.voidRef,
    })));
  } else if (voidsList.length) {
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
const EYE_HEIGHT_CROUCH = 0.72;
const EYE_HEIGHT_PRONE = 0.28;

function rescuerEyeHeight() {
  if (!rescuer) return EYE_HEIGHT;
  if (rescuer.prone || rescuer.mode === 'commit') return EYE_HEIGHT_PRONE;
  if (rescuer.crouched) return EYE_HEIGHT_CROUCH;
  return EYE_HEIGHT;
}

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
    const eyeY = rescuer.feetY() + rescuerEyeHeight();
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
    // Shift or Z — hold to crouch, release to stand. (Ctrl steals Ctrl+W/A/S/D in the browser.)
    // C remains Collapse. X — hold for prone / elbow-crawl into low voids.
    crouch: keysDown.has('shift') || keysDown.has('z'),
    prone: keysDown.has('x'),
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
      const score = victimsAccessed - rescuerCompromised;
      setStatus(
        `✓ victim reached (+1) — evacuating to triage bay (+X) · score ${score}`,
        { stickyMs: 6000 },
      );
      // Chess-piece take: exact victimId only (fuzzy pos match was greening a neighbour).
      const vm = findVictimMeshForEvent(e);
      if (vm) {
        const slot = victimMeshes.filter((m) => m.userData.evacuated).length;
        evacuateVictimToStretcher(vm, slot);
      } else {
        setStatus(
          `✓ victim reached (+1) — score ${score} (mesh missing for ${e.victimId})`,
          { stickyMs: 6000 },
        );
      }
    } else if (e.type === 'INGRESS_UNLOCKED') {
      setStatus('entered cut opening — search the pocket for the survivor', { stickyMs: 2500 });
    } else if (e.type === 'HOLE_SLIDE') {
      setStatus('dropping through clear opening — crouch (Shift/Z) or prone (X) if the void is low');
    } else if (e.type === 'RESCUER_CROUCH_BLOCKED') {
      setStatus('cannot stand — overhead too low (stay crouched or crawl clear)');
    } else if (e.type === 'RESCUER_PRONE') {
      if (e.prone) setStatus('prone — elbow-crawl (WASD) into the pocket · E commits if clear');
      else if (e.pose === 'crouch') setStatus('rose to crouch — overhead still too low to stand');
      else setStatus('stood up from prone');
    } else if (e.type === 'RESCUER_PRONE_BLOCKED') {
      setStatus('cannot rise — void too tight (stay prone or crawl clear)');
    } else if (e.type === 'COMMIT_READY') {
      setStatus('pocket clear — press E to commit to survivor');
    } else if (e.type === 'COMMIT_START') {
      setStatus('committing through the void…', { stickyMs: 2000 });
    } else if (e.type === 'COMMIT_FAIL') {
      const why = e.reason === 'blocked' ? 'blocked by debris'
        : e.reason === 'too_tight' ? 'void too tight'
        : e.reason === 'no_ingress' ? 'enter a cut opening first'
        : e.reason === 'no_path' ? 'no connected floor path'
        : e.reason === 'lost' ? 'survivor compromised'
        : 'too far';
      setStatus(`${why} — cut another ingress or shore`, { stickyMs: 3500 });
    } else if (e.type === 'RESCUER_BUMP') {
      ensureAudio();
      playBodyBump();
    } else if (e.type === 'RESCUER_LAND') {
      if (!e.ok) {
        setStatus(e.reason === 'too_steep'
          ? 'landing too steep (>30°) — slid back'
          : e.reason === 'too_deep'
            ? 'drop too deep (>2.5 m) — need rappel (TODO) — slid back'
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
  if (rescuer || victimsAccessed > 0 || rescuerCompromised > 0 || voidsList.length) {
    const score = victimsAccessed - rescuerCompromised;
    const scoreCls = score > 0 ? 'ok' : score < 0 ? 'bad' : '';
    rows.push('<h4>USAR score</h4>');
    rows.push(`<div class="row"><span>score</span><span class="${scoreCls}">${score}</span></div>`);
    rows.push(`<div class="row"><span>victims reached</span><span class="ok">+${victimsAccessed}</span></div>`);
    const cCls = rescuerCompromised > 0 ? 'bad' : 'ok';
    rows.push(`<div class="row"><span>compromised by ops</span><span class="${cCls}">−${rescuerCompromised}</span></div>`);
    if (rescuer) {
      rows.push(`<div class="row"><span>rescuer</span><span class="ok">${params.rescuerMode ? 'CONTROL' : 'idle'}</span></div>`);
    }
  }
  loadsEl.innerHTML = rows.join('');
}

function rebuild() {
  // Clear the agent WHILE the Rapier world is still alive — disposing the world first
  // left removeCollider/removeRigidBody pointing at freed WASM memory and crashed rebuild.
  clearRescuer();
  clearVoids();
  resetDust();
  clearSplinters();
  for (const [, mesh] of bagMeshes) { structureGroup.remove(mesh); disposeMesh(mesh); }
  bagMeshes.clear();
  for (const [, mesh] of ladderMeshes) { structureGroup.remove(mesh); disposeMesh(mesh); }
  ladderMeshes.clear();
  compromised = 0; rescuerCompromised = 0; voidEvents.length = 0;
  freezeQueued = false;
  if (sim) sim.dispose();
  sim = new RubbleSim(RAPIER, params, { onAdd, onRemove, onReshape, onExpose, onRebarChange, onSplinter });
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
  clearVoids();
  // Voids are invisible search targets: victims sit on the pocket floor; intrusion still
  // uses the AABB (radius × height around centre y). No wireframe markers — the rescuer
  // finds survivors by cutting in and entering (telescopic probe camera is a later TODO).
  for (const v of voids) {
    voidsList.push({ ...v, compromised: false });
  }
  compromised = 0;
  phase = 'frozen';
  updateStressMap();
  // Place prone victim figures on confined void floors only (need tools to reach).
  spawnVictimMeshes();
  // Equilibrium census of the frozen pile: pieces the physics says should still be moving, and
  // pieces whose only load path is a rebar tie (those are the ones that read as "floating").
  const eq = sim.equilibrium;
  const eqNote = eq
    ? ` • ${eq.failing} unstable, ${eq.hanging} on rebar`
    : '';
  const confined = voids.filter((v) => v.confined).length;
  const victimNote = confined === 0
    ? ' • no trapped survivors this seed — regenerate (P)'
    : ` • ${Math.min(confined, 8)} trapped survivors`;
  setStatus(`frozen • ${sim.parts.length} pieces • ${sim.stats.cracks} cracks • ${sim.stats.snaps} snaps • ${sim.stats.cuts} cuts • ${voids.length} voids · ${confined} confined${eqNote}${victimNote} — press R to spawn rescuer`);
}

/** Half torso thickness of the prone victim mesh — sit them on the pocket floor. */
const VICTIM_FLOOR_OFFSET = 0.07;

function spawnVictimMeshes() {
  // Detach + dispose survivors first (some may be parented to stretchers after evacuation).
  evacuations.length = 0;
  for (const m of victimMeshes) {
    if (m.parent) m.parent.remove(m);
    disposeRescuerMesh(m);
  }
  victimMeshes.length = 0;
  clearTriageBay();
  // Only confined pockets get survivors — open/walkable voids stay for intrusion only.
  const confined = voidsList.filter((v) => v.confined);
  const maxV = Math.min(confined.length, 8);
  for (let i = 0; i < maxV; i++) {
    const v = confined[i];
    const mesh = createVictimMesh();
    const floorY = (v.floorY != null ? v.floorY : v.y - v.height / 2) + VICTIM_FLOOR_OFFSET;
    mesh.position.set(v.x, floorY, v.z);
    mesh.userData.voidRef = v;
    mesh.userData.victimId = `v${i}`;
    mesh.userData.evacuated = false;
    agentsGroup.add(mesh);
    victimMeshes.push(mesh);
  }
  if (rescuer) {
    rescuer.setVictims(victimMeshes.map((m, i) => ({
      id: m.userData.victimId || `v${i}`,
      x: m.position.x, y: m.position.y, z: m.position.z, voidRef: m.userData.voidRef,
    })));
  }
}

// --- specs.md §4C: SURVIVOR_COMPROMISED ------------------------------------------------------
// If debris shifts into a detected void, the survivable space is gone. Tested as an AABB overlap
// against the part's half-extents (ignoring its rotation, so it errs on the side of warning).
// Score −1 only when compromiseAttribution is set (a rescue tool woke the pile).
let compromised = 0;
function checkVoidIntrusion() {
  if (!sim) return;
  for (const entry of voidsList) {
    if (entry.compromised) continue;
    const v = entry;
    for (const part of sim.parts) {
      // Rescuers, victims, ladders, and shores must not alone fire SURVIVOR_COMPROMISED —
      // only debris intrusion destroys the pocket.
      if (part.dead || part.shore || part.ladder || part.agent || part.rescuer || part.victim) continue;
      const t = part.body.translation(), s = part.shape;
      if (Math.abs(t.x - v.x) < v.radius + s.hx &&
          Math.abs(t.z - v.z) < v.radius + s.hz &&
          Math.abs(t.y - v.y) < v.height / 2 + s.hy) {
        entry.compromised = true;
        compromised++;
        const opsCaused = !!sim.compromiseAttribution;
        if (opsCaused) rescuerCompromised++;
        voidEvents.push({
          type: 'SURVIVOR_COMPROMISED',
          x: v.x, y: v.y, z: v.z, by: part.kind,
          scored: opsCaused,
        });
        if (rescuer) rescuer.markVoidCompromised(v);
        // Paint matching victim red if present.
        for (let i = 0; i < victimMeshes.length; i++) {
          const vm = victimMeshes[i];
          if (vm.userData.evacuated) continue;
          if (vm.userData.voidRef === v ||
              Math.hypot(vm.position.x - v.x, vm.position.z - v.z) < 0.35) {
            vm.traverse((o) => {
              if (o.isMesh) {
                o.material = o.material.clone();
                o.material.color.set(0xff3344);
              }
            });
          }
        }
        if (opsCaused) {
          const score = victimsAccessed - rescuerCompromised;
          setStatus(`⚠ survivor compromised by ops (−1) — score ${score} · ${part.kind} into void at ` +
            `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`);
        } else {
          setStatus(`⚠ void crushed (no score — not from rescue tools) at ` +
            `(${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)})`);
        }
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
  // Accept THREE.Vector3 or a plain {x,y,z} — chipHammerOnce passes the latter.
  const wp = worldPoint.isVector3 ? worldPoint : _wv.set(worldPoint.x, worldPoint.y, worldPoint.z);
  const local = part.mesh.worldToLocal(wp.clone());
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
  rebarMark.visible = false;
  hammerMark.visible = false;
  cutSquare.visible = true;
  cutSquare.position.copy(plan.centre).addScaledVector(plan.normal, 0.02);
  cutSquare.quaternion.copy(plan.quat);
  cutSquare.scale.set(plan.rx * 2, plan.rz * 2, 1);
  const colour = ok ? MARK_OK : MARK_NO;
  squareFill.material.color.setHex(colour);
  squareOutline.material.color.setHex(colour);
}

/**
 * Circular breach footprint for the demolition hammer.
 * `radius` is the current (or starting) chip radius in metres.
 */
function showHammerPreview(centre, normal, quat, radius, ok) {
  cutSquare.visible = false;
  rebarMark.visible = false;
  hammerMark.visible = true;
  hammerMark.position.copy(centre).addScaledVector(normal, 0.025);
  hammerMark.quaternion.copy(quat);
  const d = Math.max(0.12, radius * 2);
  hammerMark.scale.set(d, d, 1);
  const colour = ok ? MARK_OK : MARK_NO;
  hammerMark.userData.ring.material.color.setHex(colour);
  hammerMark.userData.fill.material.color.setHex(colour);
}

function showRebarPreview(worldPoint, ok) {
  cutSquare.visible = false;
  hammerMark.visible = false;
  rebarMark.visible = true;
  rebarMark.position.set(worldPoint.x, worldPoint.y, worldPoint.z);
  const s = Math.max(0.12, (params.cutReach || 0.55) * 0.35);
  rebarMark.scale.setScalar(s);
  const colour = ok ? MARK_OK : MARK_NO;
  rebarMark.userData.cross.material.color.setHex(colour);
  rebarMark.userData.bead.material.color.setHex(colour);
}

/** Hide every tool footprint — called when the tool is put down or the cursor leaves a target. */
function clearToolPreviews() {
  cutSquare.visible = false;
  rebarMark.visible = false;
  hammerMark.visible = false;
}

/**
 * Plan where a demolition-hammer chip would land on a slab.
 * Reuses the cutter's face/orientation math; radius comes from an in-progress breach or the
 * starting bite. Returns null when this tile cannot be hammered (already a cutter hole).
 */
function planHammer(part, worldPoint) {
  if (!part || part.kind !== 'slab' || !part.mesh) return null;
  if (part.frame && !part.breach) return null;   // clean cutter opening — nothing to chip
  part.mesh.updateWorldMatrix(true, false);
  // Accept THREE.Vector3 or a plain {x,y,z} — chipHammerOnce passes the latter.
  const wp = worldPoint.isVector3 ? worldPoint : _wv.set(worldPoint.x, worldPoint.y, worldPoint.z);
  const local = part.mesh.worldToLocal(wp.clone());
  const s = part.shape;
  const border = 0.06;
  const b = part.breach;
  const r = b ? b.r : (params.hammerStartRadius || 0.10);
  const cx = b ? b.cx : Math.max(-s.hx + r + border, Math.min(s.hx - r - border, local.x));
  const cz = b ? b.cz : Math.max(-s.hz + r + border, Math.min(s.hz - r - border, local.z));
  const faceSign = b ? b.faceSign : (local.y >= 0 ? 1 : -1);
  const centre = part.mesh.localToWorld(new THREE.Vector3(cx, faceSign * s.hy, cz));
  part.mesh.getWorldQuaternion(_tileQuat);
  const normal = _tileAxis.set(0, faceSign, 0).applyQuaternion(_tileQuat).clone();
  return {
    cx, cz, r, centre, normal,
    quat: _tileQuat.clone().multiply(Q_PLANE_TO_TILE),
    depthFrac: b ? Math.min(1, b.depth / (s.hy * 2)) : 0,
    through: !!(b && b.through),
  };
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
let cutUntil = 0;            // performance.now() until which the tool is actively working
let equipCtrl = null;        // the lil-gui dropdown, so the gate can disable it
// The mouse does not move while the rescuer walks, but the reach envelope moves with him — so the
// aim has to be re-evaluated every frame from the last known pointer position, or a green square
// would sit there after he has walked away from the work face.
const lastPointer = { x: 0, y: 0, has: false };
// World point of the exposed rebar the pliers are aimed at (set during updateToolAim). Kept
// separately from hitPoint so an amber "out of reach" mark can still sit on the bar after the
// reach check has cleared engaged.
let rebarTarget = null;
// Demolition hammer hold-to-chip state. Sound runs for the whole mouse-down; chips only tick
// while the tip is on an eligible reachable spot.
let hammerHeld = false;
let hammerChipAcc = 0;
let hammerPlanNow = null;    // planHammer() under the cursor, or null
let hammerTargetPart = null; // slab locked for the duration of one RMB hold

/**
 * Point the raycaster at only what the current tool can legitimately grab.
 * Cutters, hammer, and oxy-acetylene see concrete (layer 0) — the torch aims at beam faces to
 * melt member joints. Bag/shore need concrete surfaces to find an interface. The REBAR CUTTER
 * sees only reinforcement (layer 1). Void volumes are never targets.
 */
function setRaycastLayers() {
  raycaster.layers.enableAll();
  raycaster.layers.disable(LAYER_VOID);                  // void volumes are never targets
  if (!activeTool) return;
  if (activeTool.kind === 'rebar') raycaster.layers.disable(LAYER_CONCRETE);
  else if (activeTool.picks !== 'rebar') raycaster.layers.disable(LAYER_REBAR);
}

/**
 * Raycast from the mouse, decide whether right-click would fire, and lay the matching footprint
 * (hole square or rebar crosshair) on the target. No floating tool cursor — the machine is in
 * the rescuer's hand.
 */
function updateToolAim(clientX, clientY) {
  if (!toolActive() || !sim) return;
  lastPointer.x = clientX; lastPointer.y = clientY; lastPointer.has = true;
  const tool = activeTool;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(structureGroup.children, true);
  clearToolPreviews();
  holePlanNow = null;
  hammerPlanNow = null;
  rebarTarget = null;
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
      // The snips bite any visible red rod under the cursor — cage in a cut hole, bars sticking
      // out of a fractured edge, lattice through skinned concrete. Raycast is restricted to the
      // rebar layer, so a hit here IS a rod. Snap the mark to the nearest rod axis so the
      // crosshair sits on the bar, not on a glancing hit off to one side.
      const onRod = !!(h.object.userData && h.object.userData.isRebar)
        || !!(h.object.parent && h.object.parent.userData && h.object.parent.userData.isRebar);
      if (!onRod) {
        engaged = false;
        blockReason = 'aim at an exposed red rod (in a hole, at a frayed edge, or through broken cover)';
      } else {
        const near = sim.exposedRodNear(hitPoint, params.cutReach);
        if (near) {
          engaged = true;
          hitPoint.set(near.world.x, near.world.y, near.world.z);
          hitPart = near.part;
          rebarTarget = { x: near.world.x, y: near.world.y, z: near.world.z };
        } else {
          // Ray hit the merged rebar mesh but no descriptor was within mouth reach — rare, but
          // still treat the hit point as workable so a direct hit on a stub is never refused.
          engaged = true;
          rebarTarget = { x: hitPoint.x, y: hitPoint.y, z: hitPoint.z };
        }
      }
    } else if (kind === 'torch') {
      // Oxy-acetylene melts steel BEAM joints only — not slab ties or column welds.
      engaged = !!sim.joints.find((rec) => !rec.broken && !rec.a.dead && !rec.b.dead &&
        rec.type === 'member' && rec.member && rec.member.kind === 'beam' &&
        jointNear(rec, hitPoint, tool.reach));
      if (!engaged) blockReason = 'aim at a beam joint to melt (oxy-acetylene cuts steel beams only)';
    } else if (kind === 'bag') {
      engaged = !!hitPart;
      if (!engaged) blockReason = 'no interface here — aim just under a slab edge';
    } else if (kind === 'shore') {
      engaged = shoreFits(hitPoint);
      if (!engaged) blockReason = 'no headroom for a shore here';
    } else if (kind === 'hammer') {
      // Electric breaker: slabs get a progressive circular breach; columns/beams take a spall.
      if (hitPart && hitPart.kind === 'slab') {
        const plan = planHammer(hitPart, hitPoint);
        if (!plan) {
          engaged = false;
          blockReason = hitPart.frame
            ? 'that opening was cut clean — use the rebar cutter on the cage'
            : 'aim at a slab tile to chip an ingress / camera hole';
        } else if (!isBroadFace(hitNormal, plan.normal)) {
          engaged = false;
          blockReason = 'present the bit to the flat face, not the thin edge';
        } else {
          engaged = true;
          hammerPlanNow = plan;
          hitPoint.copy(plan.centre);
        }
      } else if (hitPart) {
        engaged = true;   // column / beam — chipBreach falls back to spallAt
      } else {
        engaged = false;
        blockReason = 'aim at concrete to chip';
      }
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

    // Footprints: green when right-click will fire, amber when the target is fine but he cannot
    // reach it yet (or some other gate failed after the target was found).
    if (holePlanNow) showHolePreview(holePlanNow, engaged);
    else if (hammerPlanNow) showHammerPreview(
      hammerPlanNow.centre, hammerPlanNow.normal, hammerPlanNow.quat, hammerPlanNow.r, engaged);
    else if (rebarTarget) showRebarPreview(rebarTarget, engaged);
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
  // Vestiges (available: false) stay in EQUIPMENT for revive-later, but cannot be selected
  // through any path — ring, dropdown, hotkey, or the __app test API.
  if (tool && tool.available === false) {
    params.equipment = activeTool ? activeTool.label : 'None';
    refreshToolRing();
    setStatus(`${tool.label} is not on the roster (vestigial — kept in code only)`);
    return;
  }
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
  clearToolPreviews();
  engaged = false; wasEngaged = false;
  aimPoint = null; holePlanNow = null; hammerPlanNow = null; rebarTarget = null; blockReason = '';
  stopHammerHold();   // never leave the breaker running after a tool swap
  setRaycastLayers();
  refreshToolRing();
  equipTool(tool);
  // left-drag still orbits; free the RIGHT button so right-click can cut / place
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  controls.mouseButtons.RIGHT = tool ? null : THREE.MOUSE.PAN;
  if (!tool) { setStatus('tool: none — left-drag orbits'); return; }
  setStatus(`${tool.label} in hand — ${tool.hint}` +
    (tool.holdToUse
      ? ' HOLD right-click to keep chipping.'
      : (tool.needsReach ? ' Walk within arm\'s reach; RIGHT-CLICK an eligible spot to use.' : ' RIGHT-CLICK to use.')));
}

// Use the active tool at the aim point (right-click / Apply / Enter).
function applyEquipment() {
  if (!sim || !activeTool) return;
  const tool = activeTool;
  // Hold-to-use tools (demolition hammer) are driven by startHammerHold / updateToolPose, not
  // a single click — Enter still fires one chip so the GUI "Apply" button stays useful.
  if (tool.holdToUse && tool.kind === 'hammer') {
    chipHammerOnce();
    return;
  }
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

  // oxy torch / pliers: one-shot point tools (hammer is hold-to-chip above)
  if (tool.kind === 'rebar') {
    tool.reach = params.cutReach;
    // Square up to the seam before the jaws close — same small correction the cutter does.
    if (rescuer) rescuer.faceTowards(point.x, point.z);
  }
  const res = tool.apply(sim, { point });
  if (!res.severed) {
    setStatus(tool.kind === 'rebar'
      ? 'no exposed rod under the jaws — aim at a visible red bar'
      : tool.kind === 'torch'
        ? 'no beam joint in range — aim at a steel beam to melt'
        : `${tool.label}: nothing to act on there`);
    return;
  }
  grind(tool.kind === 'rebar' ? 450 : 300);
  if (tool.kind === 'rebar') cutUntil = performance.now() + 450;   // viewmodel kick while snipping
  if (res.points[0]) { lastCutWorld.set(res.points[0].x, res.points[0].y, res.points[0].z); addCutMarks(res.points); }
  resume();
  if (tool.kind === 'torch') {
    const burned = applyTorchHeatCompromise(res, tool);
    const score = victimsAccessed - rescuerCompromised;
    setStatus(burned
      ? `🔥 oxy-acetylene — beam melted · ${burned} survivor burn(s) along heat path (−${burned}) · score ${score}`
      : `🔥 oxy-acetylene — beam melted, ${res.woken ?? 0} pieces re-settling`);
  } else if (tool.kind === 'rebar') {
    setStatus(res.dropped
      ? `✂ rebar snipped — ${res.dropped} freed bar${res.dropped > 1 ? 's' : ''} falling`
      : (res.brokeTie
        ? `✂ rebar snipped — rod severed and fracture hinge broken, ${res.woken ?? 0} pieces re-settling`
        : `✂ rebar snipped — rod severed, ${res.woken ?? 0} pieces re-settling`));
  } else {
    setStatus(`✂ ${tool.label} — joint severed, ${res.woken ?? 0} pieces re-settling`);
  }
}

/**
 * After an oxy-acetylene cut: score ops-compromise for any survivor within ±heatAlong of the
 * cut along the beam axis and within heatClearance of the steel (torch-heat.js). Independent
 * of debris AABB intrusion.
 */
function applyTorchHeatCompromise(res, tool) {
  if (!res?.member || !res.cutPoint) return 0;
  const opts = {
    along: tool.heatAlong ?? 2.0,
    clearance: tool.heatClearance ?? 0.5,
  };
  // Use prone victim positions (void floor), not void centres mid-pocket.
  const candidates = [];
  for (const vm of victimMeshes) {
    const v = vm.userData.voidRef;
    if (!v || v.compromised) continue;
    candidates.push({
      x: vm.position.x, y: vm.position.y, z: vm.position.z,
      compromised: false,
      voidRef: v,
      mesh: vm,
    });
  }
  const burned = victimsBurnedByCut(res.cutPoint, res.member, candidates, opts);
  let n = 0;
  for (const c of burned) {
    const v = c.voidRef;
    if (!v || v.compromised) continue;
    v.compromised = true;
    compromised++;
    rescuerCompromised++;
    n++;
    voidEvents.push({
      type: 'SURVIVOR_COMPROMISED',
      x: v.x, y: v.y, z: v.z,
      by: 'torch-heat',
      scored: true,
    });
    if (rescuer) rescuer.markVoidCompromised(v);
    if (c.mesh) {
      c.mesh.traverse((o) => {
        if (o.isMesh) {
          o.material = o.material.clone();
          o.material.color.set(0xff3344);
        }
      });
    }
  }
  return n;
}

/**
 * One demolition-hammer chip at the current aim. Called on an interval while RMB is held, and
 * once from Apply/Enter. Returns true if a chip landed.
 *
 * While a hold is in progress we keep chipping the LOCKED tile even if the mouse ray falls
 * through the opening (otherwise break-through would immediately stop the breaker).
 */
function chipHammerOnce() {
  if (!sim || !activeTool || activeTool.kind !== 'hammer') return false;
  const part = hammerTargetPart || hitPart;
  if (!part) {
    setStatus(blockReason || 'Demolition hammer: no eligible concrete under the bit');
    return false;
  }

  // Work point: breach centre once planted, otherwise the live cursor hit.
  let point;
  if (part.breach && part.mesh) {
    part.mesh.updateWorldMatrix(true, false);
    const faceY = part.breach.faceSign * part.shape.hy;
    const w = part.mesh.localToWorld(new THREE.Vector3(part.breach.cx, faceY, part.breach.cz));
    point = { x: w.x, y: w.y, z: w.z };
  } else if (engaged) {
    point = { x: hitPoint.x, y: hitPoint.y, z: hitPoint.z };
  } else {
    setStatus(blockReason || 'Demolition hammer: no eligible concrete under the bit');
    return false;
  }

  // Reach gate against the work point (not whatever the ray hit through the hole).
  if (activeTool.needsReach) {
    if (!rescuer) {
      setStatus('Demolition hammer: no rescuer on site');
      return false;
    }
    const res = reachCheck(rescuer.stance(), point, activeTool.toolLength || 0);
    if (!res.ok) {
      setStatus(reachMessage(res, activeTool.label));
      return false;
    }
  }

  if (rescuer) rescuer.faceTowards(point.x, point.z);
  const res = sim.chipBreach(part, point);
  if (!res.chipped) {
    setStatus(res.reason === 'cutter_hole'
      ? 'that opening was cut clean — use the rebar cutter on the cage'
      : 'nothing to chip there');
    return false;
  }
  cutUntil = performance.now() + 140;   // short viewmodel kick per strike
  if (res.holeWorld) {
    lastCutWorld.set(res.holeWorld.x, res.holeWorld.y, res.holeWorld.z);
    addCutMarks([res.holeWorld]);
  }
  if (part.kind === 'slab') {
    const plan = planHammer(part, point);
    if (plan) {
      hammerPlanNow = plan;
      showHammerPreview(plan.centre, plan.normal, plan.quat, plan.r, true);
      hitPoint.copy(plan.centre);
      aimPoint = plan.centre.clone();
    }
  }
  if (res.justThrough) {
    resume();
    setStatus(`⚒ broke through — ⌀ ${(res.radius * 2).toFixed(2)} m opening, rebar still spanning. Keep holding to widen, or switch to Rebar to clear the cage.`);
  } else if (res.through) {
    setStatus(`⚒ widening — ⌀ ${(res.radius * 2).toFixed(2)} m through-hole, rebar intact`);
  } else {
    setStatus(`⚒ chipping — ${(res.depthFrac * 100).toFixed(0)}% through, ⌀ ${(res.radius * 2).toFixed(2)} m (rebar exposing)`);
  }
  return true;
}

/** Begin hold-to-chip: sound for the whole press; chips tick on the locked tile. */
function startHammerHold() {
  if (hammerHeld) return;
  hammerHeld = true;
  hammerChipAcc = 0;
  hammerTargetPart = (engaged && hitPart) ? hitPart : null;
  ensureAudio();
  startHammer(Math.round((params.hammerChipInterval || DEFAULTS.hammerChipInterval || 0.16) * 1000 * 0.8));
  chipHammerOnce();   // immediate first bite so the press is not a dead wait
}

/** End hold-to-chip and silence the breaker. */
function stopHammerHold() {
  hammerHeld = false;
  hammerChipAcc = 0;
  hammerTargetPart = null;
  stopHammer();
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

  // Demolition hammer: while RMB is held, chip at most ONCE per frame on the locked tile.
  // A while-burst of chipBreach→onReshape (full rebar merge) was freezing the tab on click.
  if (hammerHeld && activeTool && activeTool.kind === 'hammer') {
    const interval = Math.max(0.05, Number(params.hammerChipInterval) || DEFAULTS.hammerChipInterval || 0.16);
    if (hammerTargetPart || engaged) {
      if (!hammerTargetPart && engaged && hitPart) hammerTargetPart = hitPart;
      hammerChipAcc += dt;
      if (hammerChipAcc >= interval) {
        hammerChipAcc -= interval;
        // Cap backlog so a long GC pause cannot enqueue a dozen mesh rebuilds.
        if (hammerChipAcc > interval) hammerChipAcc = 0;
        chipHammerOnce();
      }
    } else {
      hammerChipAcc = 0;
    }
  }

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
  if (e.button !== 2 || !toolActive()) return;
  e.preventDefault();
  // Capture so pointerup still arrives if the cursor leaves the canvas mid-hold — otherwise
  // hammerHeld stays true and the breaker keeps rebuilding meshes forever (looks like a hang).
  try { renderer.domElement.setPointerCapture(e.pointerId); } catch (_) { /* older browsers */ }
  updateToolAim(e.clientX, e.clientY);
  if (activeTool && activeTool.holdToUse) startHammerHold();
  else applyEquipment();
});
renderer.domElement.addEventListener('pointerup', (e) => {
  if (e.button === 2) {
    stopHammerHold();
    try { renderer.domElement.releasePointerCapture(e.pointerId); } catch (_) { /* not capturing */ }
  }
});
renderer.domElement.addEventListener('pointercancel', () => stopHammerHold());
renderer.domElement.addEventListener('lostpointercapture', () => stopHammerHold());
addEventListener('blur', () => stopHammerHold());
document.addEventListener('visibilitychange', () => { if (document.hidden) stopHammerHold(); });

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
  // Only the available roster — vestiges (e.g. Concrete saw) stay out of the ring.
  for (const t of AVAILABLE_EQUIPMENT) mk(t.short || t.label, TOOL_ICONS[t.kind] || '•', t.key, t);
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
fT.add(params, 'voidConfineRadius', 0.5, 2.0, 0.1).name('confine radius (m)');
fT.add(params, 'voidConfineMinHits', 4, 8, 1).name('confine min side hits');
fT.add(params, 'voidRooftopMaxClear', 0.1, 1.0, 0.05).name('rooftop reject (m)');
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
  // Mirror Shift for hold-to-crouch (e.shiftKey survives lost keyups better than key alone).
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.key === 'Shift') {
    keysDown.add('shift');
  }
  if (!e.shiftKey) keysDown.delete('shift');
  if (!e.repeat && (k === ' ' || k === 'spacebar')) { jumpEdge = true; e.preventDefault(); }
  if (!e.repeat && k === 'e' && params.rescuerMode) { interactEdge = true; e.preventDefault(); return; }
  // Keep Shift/Z from scrolling / finding-in-page while rescuer is in control.
  if (params.rescuerMode && (k === 'shift' || e.key === 'Shift' || k === 'z' || k === 'x')) e.preventDefault();

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
    // Toggle third-person shoulder ↔ first-person eyes.
    params.rescuerView = params.rescuerView === 'first' ? 'third' : 'first';
    applyRescuerViewMode();
    setStatus(params.rescuerView === 'first'
      ? '1st-person eyes — drag look · scroll zoom'
      : '3rd-person shoulder — drag orbit · scroll zoom · pan');
  }
  else if (k === 's' && !params.rescuerMode) {
    params.showStress = !params.showStress; updateStressMap();
    setStatus(`stress map ${params.showStress ? 'ON — grey→red is utilization / contact load' : 'off'}`);
  }
  else if (k === 'enter') applyEquipment();
  else if (k === '0') setEquipment('None');
  else if (k >= '1' && k <= '7') {
    // 1..7 select a tool from the available roster. setEquipment itself refuses when no rescuer
    // is on site, so the keyboard cannot be used to slip past the ring being greyed out.
    // (Key 8 used to be the ladder when the saw was still on the roster; keys were renumbered
    // when the saw became a vestige — see equipment.js.)
    const tool = AVAILABLE_EQUIPMENT.find((t) => t.key === k);
    if (tool) setEquipment(tool.label);
  }
});
addEventListener('keyup', (e) => {
  const k = e.key.toLowerCase();
  keysDown.delete(k);
  if (e.code === 'ShiftLeft' || e.code === 'ShiftRight' || e.key === 'Shift' || k === 'shift') {
    keysDown.delete('shift');
  }
  if (!e.shiftKey) keysDown.delete('shift');
});
// Focus loss often drops keyup for modifiers — never leave crouch latched.
addEventListener('blur', () => { keysDown.delete('shift'); keysDown.delete('z'); keysDown.delete('x'); });
window.addEventListener('blur', () => { keysDown.delete('shift'); keysDown.delete('z'); keysDown.delete('x'); });

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
  // Stretcher evacuations keep running even if rescuer control is toggled off mid-hop.
  stepEvacuations(dt);
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
    voids: () => voidsList.slice(),
    compromised: () => compromised,
    rescuerCompromised: () => rescuerCompromised,
    score: () => victimsAccessed - rescuerCompromised,
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
    // World point on a VISIBLE exposed rod. Prefer cage left in a cut hole (part.frame) and
    // rods that sit well above the floor — those are what the player actually aims at.
    firstRebar: () => {
      const cands = [];
      for (const p of sim.parts) {
        if (p.dead || !p.rebarExposed || !p.rebars?.length || !p.mesh) continue;
        for (const d of p.rebars) {
          if (!d || d.len < 0.08) continue;
          p.mesh.updateWorldMatrix(true, false);
          const w = p.mesh.localToWorld(new THREE.Vector3(d.x, d.y, d.z));
          if (w.y < 0.15) continue;   // skip bars buried against the ground plane
          cands.push({
            x: w.x, y: w.y, z: w.z,
            score: (p.frame ? 10 : 0) + w.y + d.len * 0.1,
          });
        }
      }
      cands.sort((a, b) => b.score - a.score);
      if (!cands.length) return null;
      const pt = { x: cands[0].x, y: cands[0].y, z: cands[0].z };
      return { ...pt, aim: pt };
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
