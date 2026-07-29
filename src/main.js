// RubbleSim Web — renderer. Drives the framework-agnostic physics core (src/sim.js)
// and mirrors each physics part as a three.js mesh. See sim.js for the collapse model.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import GUI from 'lil-gui';
import RAPIER from '@dimforge/rapier3d-compat';
import { RubbleSim, DEFAULTS } from './sim.js';
import { equipmentById, equipmentByLabel } from './equipment.js';
import { ensureAudio, playContact, startGrind, stopGrind } from './audio.js';

const statusEl = document.getElementById('status');
const setStatus = (t) => { statusEl.textContent = t; };

const params = {
  ...DEFAULTS,
  standSeconds: 1.2,
  settleSeconds: 8,
  showVoidMarkers: true,
  equipment: 'None',          // 'None' | 'Concrete cutter' | 'Rebar cutter'
  cutReach: 0.55,             // rebar-cutter mouth reach (m) — short (hydraulic pliers)
  holeSize: 0.6,             // concrete-cutter square side (m)
  cutSettleSeconds: 3,       // local re-settle time after a cut
  rebuild: () => rebuild(),
  collapseNow: () => doCollapse(),
  freezeNow: () => doFreeze(),
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
scene.fog = new THREE.Fog(0x0b0d10, 30, 95);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 500);
camera.position.set(15, 12, 17);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 4, 0);
controls.enableDamping = true;

// --- Equipment: a disc-cutter "blade" cursor you move over the rubble with the mouse ---
// A circle (the blade) + handle, drawn to a canvas sprite; it billboards to face the camera
// and sits where the mouse ray hits the rubble. Turns bright when touching a solid.
// `rim` colours the disc circumference — grey when free, green when touching a surface.
function makeBladeTexture(rim) {
  const s = 256, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, s, s);
  // handle
  g.strokeStyle = '#222'; g.lineWidth = 16; g.beginPath(); g.moveTo(s * 0.5, s * 0.52); g.lineTo(s * 0.86, s * 0.16); g.stroke();
  g.strokeStyle = '#4a90d9'; g.lineWidth = 8; g.beginPath(); g.moveTo(s * 0.5, s * 0.52); g.lineTo(s * 0.86, s * 0.16); g.stroke();
  // blade disc + circumference
  g.beginPath(); g.arc(s * 0.42, s * 0.58, s * 0.34, 0, Math.PI * 2);
  g.fillStyle = 'rgba(210,215,220,0.85)'; g.fill();
  g.lineWidth = 12; g.strokeStyle = rim; g.stroke();
  // arbor + teeth ticks
  g.fillStyle = '#333'; g.beginPath(); g.arc(s * 0.42, s * 0.58, s * 0.05, 0, Math.PI * 2); g.fill();
  g.strokeStyle = rim; g.lineWidth = 3;
  for (let i = 0; i < 24; i++) { const a = (i / 24) * Math.PI * 2, r0 = s * 0.30, r1 = s * 0.34, cx = s * 0.42, cy = s * 0.58;
    g.beginPath(); g.moveTo(cx + Math.cos(a) * r0, cy + Math.sin(a) * r0); g.lineTo(cx + Math.cos(a) * r1, cy + Math.sin(a) * r1); g.stroke(); }
  const tex = new THREE.CanvasTexture(cv); tex.anisotropy = 4; return tex;
}
// Hydraulic rebar cutter — long pliers with a short mouth; the mouth/jaws go green when a
// cuttable rebar is in reach. `jaw` colours the mouth.
function makePliersTexture(jaw) {
  const s = 256, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const g = cv.getContext('2d'); g.clearRect(0, 0, s, s); g.lineCap = 'round';
  const pivot = [s * 0.5, s * 0.42];
  // long handles
  g.strokeStyle = '#2b2f33'; g.lineWidth = 20;
  g.beginPath(); g.moveTo(s * 0.32, s * 0.96); g.lineTo(pivot[0], pivot[1]); g.stroke();
  g.beginPath(); g.moveTo(s * 0.68, s * 0.96); g.lineTo(pivot[0], pivot[1]); g.stroke();
  // hydraulic body
  g.fillStyle = '#4a90d9'; g.fillRect(s * 0.40, s * 0.34, s * 0.20, s * 0.14);
  // pivot bolt
  g.fillStyle = '#111'; g.beginPath(); g.arc(pivot[0], pivot[1], s * 0.035, 0, Math.PI * 2); g.fill();
  // SHORT mouth / jaws
  g.strokeStyle = jaw; g.lineWidth = 14;
  g.beginPath(); g.moveTo(pivot[0], pivot[1]); g.lineTo(s * 0.44, s * 0.20); g.stroke();
  g.beginPath(); g.moveTo(pivot[0], pivot[1]); g.lineTo(s * 0.56, s * 0.20); g.stroke();
  const tex = new THREE.CanvasTexture(cv); tex.anisotropy = 4; return tex;
}

const discFree = makeBladeTexture('#3a3f45');
const discOn = makeBladeTexture('#33ff88');       // green rim = touching a surface
const pliersFree = makePliersTexture('#9aa0a6');
const pliersOn = makePliersTexture('#33ff88');    // green jaws = rebar in reach
const blade = new THREE.Sprite(new THREE.SpriteMaterial({ map: discFree, depthTest: false, transparent: true }));
blade.scale.set(1.0, 1.0, 1);
blade.visible = false;
blade.renderOrder = 999;
scene.add(blade);
let activeFreeTex = discFree, activeOnTex = discOn;   // set per tool in setEquipment

// Concrete cutter: a square footprint (translucent green fill + outline) marking the hole to
// be cut, laid on the slab under the blade.
const cutSquare = new THREE.Group();
cutSquare.visible = false;
const squareFill = new THREE.Mesh(new THREE.PlaneGeometry(1, 1),
  new THREE.MeshBasicMaterial({ color: 0x33ff88, transparent: true, opacity: 0.35, side: THREE.DoubleSide, depthTest: false, depthWrite: false }));
const squareOutline = new THREE.LineSegments(new THREE.BufferGeometry(),
  new THREE.LineBasicMaterial({ color: 0x33ff88, depthTest: false }));
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
  rebar:     new THREE.MeshStandardMaterial({ color: 0xb04a24, roughness: 0.6, metalness: 0.5 }), // rust-red rebar
  furniture: new THREE.MeshStandardMaterial({ color: 0x9c6a3f, roughness: 0.9 }),             // contents
  fragment:  new THREE.MeshStandardMaterial({ color: 0x8a8d90, roughness: 1 }),               // broken concrete
};

const structureGroup = new THREE.Group();  // exported to STL
const markerGroup = new THREE.Group();
scene.add(structureGroup, markerGroup);

// ---------------------------------------------------------------------------
// Sim wiring — a mesh per physics part
// ---------------------------------------------------------------------------
let sim;
const voidMarkers = [];
let phase = 'idle';
let timer = 0;
let settleDuration = 8;   // seconds of re-settling before auto-freeze (collapse vs cut)

// merge a part's rebar rod descriptors {x,y,z,len,r,axis} into one thin-cylinder mesh
function buildRebarMesh(rebars) {
  if (!rebars || !rebars.length) return null;
  const geoms = [];
  for (const d of rebars) {
    const g = new THREE.CylinderGeometry(d.r, d.r, d.len, 8, 1);   // cylinder is along +Y
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

function onAdd(part) {
  const s = part.shape;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(s.hx * 2, s.hy * 2, s.hz * 2), MAT[part.matKind] || MAT.fragment);
  mesh.castShadow = true; mesh.receiveShadow = true;
  const t = part.body.translation(), r = part.body.rotation();
  mesh.position.set(t.x, t.y, t.z);
  mesh.quaternion.set(r.x, r.y, r.z, r.w);
  // reinforcement: thin cylindrical rods (a grid in slabs; corner bars in columns/beams),
  // merged into one child mesh that rides with the concrete piece.
  const rb = buildRebarMesh(part.rebars);
  if (rb) mesh.add(rb);
  part.mesh = mesh;
  mesh.userData.part = part;   // back-reference for picking
  structureGroup.add(mesh);
}
function disposeMesh(obj) { obj.traverse((o) => { if (o.geometry) o.geometry.dispose(); }); }
function onRemove(part) {
  if (part.mesh) { structureGroup.remove(part.mesh); disposeMesh(part.mesh); part.mesh = null; }
}
// after a hole is cut, rebuild the tile's mesh as a group of frame boxes (with the hole)
function onReshape(part) {
  if (part.mesh) { structureGroup.remove(part.mesh); disposeMesh(part.mesh); }
  const g = new THREE.Group();
  for (const b of part.frame) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(b.hx * 2, b.hy * 2, b.hz * 2), MAT[part.matKind] || MAT.slab);
    box.position.set(b.x, b.y, b.z); box.castShadow = true; box.receiveShadow = true;
    g.add(box);
  }
  const t = part.body.translation(), r = part.body.rotation();
  g.position.set(t.x, t.y, t.z); g.quaternion.set(r.x, r.y, r.z, r.w);
  g.userData.part = part; part.mesh = g;
  structureGroup.add(g);
}

function clearMarkers() { for (const m of voidMarkers) markerGroup.remove(m); voidMarkers.length = 0; }

function rebuild() {
  if (sim) sim.dispose();
  clearMarkers();
  sim = new RubbleSim(RAPIER, params, { onAdd, onRemove, onReshape });
  const n = sim.build();
  phase = 'standing'; timer = 0;
  setStatus(`standing ${params.stories}-story building (${n} pieces) — collapse in ${params.standSeconds}s`);
}

function doCollapse() {
  if (!sim || phase !== 'standing') return;
  sim.collapse(); phase = 'collapsing'; timer = 0; settleDuration = params.settleSeconds;
  setStatus('collapsing…');
}

function doFreeze() {
  if (!sim || phase === 'frozen') return;
  sim.freeze();
  syncMeshes();
  const voids = sim.detectVoids();
  clearMarkers();
  for (const v of voids) {
    const m = new THREE.Mesh(new THREE.SphereGeometry(v.radius, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0x4fd6ff, wireframe: true }));
    m.position.set(v.x, v.y, v.z);
    m.visible = params.showVoidMarkers;
    markerGroup.add(m); voidMarkers.push(m);
  }
  phase = 'frozen';
  setStatus(`frozen • ${sim.parts.length} pieces • ${sim.stats.cracks} slab cracks • ${sim.stats.snaps} snaps • ${sim.stats.cuts} cuts • ${voids.length} voids`);
}

// ---------------------------------------------------------------------------
// Equipment — a disc-cutter "blade" you move over the rubble with the mouse.
//   • touch a solid   -> contact tick + the blade brightens
//   • HOLD left mouse  -> grinding sound; concrete cutter grinds a square hole (plug drops
//                          into the void), rebar cutter severs the joints under the blade.
//   right-drag still orbits the camera.
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

// square footprint marking the hole to be cut (green fill + outline)
function refreshSquare() {
  const h = params.holeSize / 2;
  const c = [[-h, -h], [h, -h], [h, h], [-h, h], [-h, -h]], edges = [];
  for (let i = 0; i < 4; i++) edges.push(new THREE.Vector3(c[i][0], c[i][1], 0), new THREE.Vector3(c[i + 1][0], c[i + 1][1], 0));
  squareOutline.geometry.setFromPoints(edges);
  squareFill.scale.set(params.holeSize, params.holeSize, 1);
}

// --- blade cursor + engagement state ---
const raycaster = new THREE.Raycaster();
const ndc = new THREE.Vector2();
const _zAxis = new THREE.Vector3(0, 0, 1);
let engaged = false, wasEngaged = false, hitPart = null;
const hitPoint = new THREE.Vector3(), hitNormal = new THREE.Vector3(0, 1, 0);
const lastCutWorld = new THREE.Vector3();   // world position of the last cut (for camera framing/tests)
const toolKind = () => { const t = equipmentByLabel(params.equipment); return t ? t.kind : null; };
const toolActive = () => params.equipment !== 'None';

function updateBlade(clientX, clientY) {
  if (!toolActive() || !sim) return;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(structureGroup.children, true);
  if (hits.length) {
    const h = hits[0];
    hitPoint.copy(h.point);
    if (h.face) hitNormal.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
    hitPart = h.object.userData.part || (h.object.parent && h.object.parent.userData.part) || null;
    blade.material.opacity = 1;
    if (toolKind() === 'rebar') {
      // engaged only when an exposed rebar (cracked fracture between slabs) is within the short mouth
      const near = sim.exposedRebarNear(hitPoint, params.cutReach);
      engaged = !!near;
      const p = near || hitPoint;                       // snap the pliers to the rebar if found
      blade.position.set(p.x, p.y, p.z).addScaledVector(hitNormal, 0.05);
    } else {
      engaged = true;
      blade.position.copy(hitPoint).addScaledVector(hitNormal, 0.05);
      cutSquare.visible = true;
      cutSquare.position.copy(hitPoint).addScaledVector(hitNormal, 0.02);
      cutSquare.quaternion.setFromUnitVectors(_zAxis, hitNormal);
    }
  } else {
    engaged = false; blade.material.opacity = 0.35; cutSquare.visible = false;
  }
  if (engaged !== wasEngaged) {
    blade.material.map = engaged ? activeOnTex : activeFreeTex;   // green = ready to cut
    blade.material.needsUpdate = true;
    if (engaged) playContact();
  }
  wasEngaged = engaged;
}

function setEquipment(label) {
  const tool = equipmentByLabel(label);
  blade.visible = !!tool; cutSquare.visible = false;
  engaged = false; wasEngaged = false;
  activeFreeTex = tool && tool.kind === 'rebar' ? pliersFree : discFree;
  activeOnTex = tool && tool.kind === 'rebar' ? pliersOn : discOn;
  blade.material.map = activeFreeTex; blade.material.needsUpdate = true;
  // left-drag still orbits; free the RIGHT button so right-click can cut
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  controls.mouseButtons.RIGHT = tool ? null : THREE.MOUSE.PAN;
  if (!tool) { setStatus('equipment: none'); return; }
  if (tool.kind === 'hole') refreshSquare();
  setStatus(tool.kind === 'hole'
    ? 'Concrete cutter — move the blade onto a slab (rim turns GREEN); RIGHT-CLICK to cut the marked square. Left-drag orbits.'
    : 'Rebar cutter — hover the exposed rebar in a fracture between slabs (jaws turn GREEN); RIGHT-CLICK to snip it. Left-drag orbits.');
}

// Cut now, at the blade (right-click / Apply / Enter): concrete = square hole (plug drops),
// rebar = sever every joint under the blade (pieces drop).
function applyEquipment() {
  if (!sim) return;
  const tool = equipmentByLabel(params.equipment);
  if (!tool) return;
  if (!engaged) { setStatus('move the blade onto the rubble (rim turns GREEN), then right-click'); return; }
  if (tool.kind === 'hole') {
    // Cut only where the blade actually is — an intact grey slab. No silent fallback.
    if (!hitPart || hitPart.kind !== 'slab' || hitPart.frame) {
      setStatus('aim at an intact grey slab (not a beam or an already-cut hole)');
      return;
    }
    const slab = hitPart;
    slab.mesh.updateWorldMatrix(true, false);
    const local = slab.mesh.worldToLocal(hitPoint.clone());
    const res = sim.cutHoleInSlab(slab, local.x, local.z, params.holeSize / 2, params.holeSize / 2);
    if (!res) { setStatus('could not cut a hole there'); return; }
    ensureAudio(); startGrind(); setTimeout(stopGrind, 400);
    lastCutWorld.set(res.holeWorld.x, res.holeWorld.y, res.holeWorld.z);
    addCutMarks([res.holeWorld]);
    settleDuration = params.cutSettleSeconds; phase = 'collapsing'; timer = 0;
    setStatus('✂ square hole cut — plug dropping into the void below');
  } else {
    tool.reach = params.cutReach;
    const res = tool.apply(sim, { point: { x: hitPoint.x, y: hitPoint.y, z: hitPoint.z } });
    if (res.severed === 0) { setStatus('no exposed rebar in the mouth — hover a fracture between slab pieces (jaws go green)'); return; }
    ensureAudio(); startGrind(); setTimeout(stopGrind, 300);
    lastCutWorld.set(res.points[0].x, res.points[0].y, res.points[0].z);
    addCutMarks(res.points);
    settleDuration = params.cutSettleSeconds; phase = 'collapsing'; timer = 0;
    setStatus(`✂ rebar snipped · ${res.woken} pieces separating & re-settling`);
  }
}

renderer.domElement.addEventListener('contextmenu', (e) => { if (toolActive()) e.preventDefault(); });
renderer.domElement.addEventListener('pointermove', (e) => updateBlade(e.clientX, e.clientY));
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button === 2 && toolActive()) { e.preventDefault(); updateBlade(e.clientX, e.clientY); applyEquipment(); }
});

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
const fP = gui.addFolder('Physics');
fP.add(params, 'gravity', 9.81, 40, 0.5);
fP.add(params, 'restitution', 0, 0.4, 0.01);
fP.add(params, 'friction', 0.2, 1.2, 0.05);
const fF = gui.addFolder('Failure');
fF.add(params, 'columnsRemoved', 0, 1, 0.05);
fF.add(params, 'beamSnapForce', 1000, 8000, 100).name('column/beam snap force');
fF.add(params, 'beamSnapAngle', 0.02, 0.4, 0.005).name('column/beam snap angle');
fF.add(params, 'slabCrackForce', 400, 6000, 100).name('slab crack force');
fF.add(params, 'slabTearAngle', 0.3, 1.2, 0.05).name('slab rebar tear angle');
fF.add(params, 'maxBreaksPerMember', 0, 3, 1).name('max snaps / member');
const fT = gui.addFolder('Timing / voids');
fT.add(params, 'standSeconds', 0, 5, 0.2);
fT.add(params, 'settleSeconds', 3, 15, 0.5);
fT.add(params, 'cutSettleSeconds', 1, 8, 0.5).name('cut re-settle secs');
fT.add(params, 'minVoidHeight', 0.3, 1.5, 0.05);
fT.add(params, 'showVoidMarkers').onChange((v) => voidMarkers.forEach((m) => (m.visible = v)));
const fEq = gui.addFolder('Equipment');
fEq.add(params, 'equipment', ['None', 'Concrete cutter', 'Rebar cutter']).onChange(setEquipment);
fEq.add(params, 'holeSize', 0.3, 1.5, 0.1).name('hole size (concrete)').onChange(() => refreshSquare());
fEq.add(params, 'cutReach', 0.2, 1.0, 0.05).name('rebar reach (mouth)');
fEq.add({ apply: () => applyEquipment() }, 'apply').name('Apply / cut (Enter)');
gui.add(params, 'rebuild').name('Rebuild (P)');
gui.add(params, 'collapseNow').name('Collapse (C)');
gui.add(params, 'freezeNow').name('Freeze now (F)');
gui.add(params, 'exportSTL').name('Export debris STL');
gui.add(params, 'exportVoids').name('Export voids JSON');

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'p') rebuild();
  else if (k === 'c') doCollapse();
  else if (k === 'f') doFreeze();
  else if (k === 'v') { params.showVoidMarkers = !params.showVoidMarkers; voidMarkers.forEach((m) => (m.visible = params.showVoidMarkers)); }
  else if (k === 'enter') applyEquipment();
});

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

function tick() {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.05); last = now;

  if (phase === 'standing') {
    timer += dt;
    if (timer >= params.standSeconds) doCollapse();
  } else if (phase === 'collapsing') {
    sim.step();
    syncMeshes();
    timer += dt;
    if (timer >= settleDuration) doFreeze();
  }

  if (cutFx.length) updateCutFx(dt);
  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

// Test hook (only with ?test in the URL) so Playwright can drive the tools headlessly.
if (location.search.includes('test')) {
  window.__app = {
    params, setEquipment, applyEquipment, doCollapse, doFreeze,
    phase: () => phase, sim: () => sim, blade, camera, controls,
    lastCut: () => lastCutWorld,
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
rebuild();
tick();
