// RubbleSim Web — renderer. Drives the framework-agnostic physics core (src/sim.js)
// and mirrors each physics part as a three.js mesh. See sim.js for the collapse model.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import GUI from 'lil-gui';
import RAPIER from '@dimforge/rapier3d-compat';
import { RubbleSim, DEFAULTS } from './sim.js';

const statusEl = document.getElementById('status');
const setStatus = (t) => { statusEl.textContent = t; };

const params = {
  ...DEFAULTS,
  standSeconds: 1.2,
  settleSeconds: 8,
  showVoidMarkers: true,
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
// Colour code so rescuers can tell materials apart at a glance:
//   concrete (slabs/columns/fragments) = grey · steel beams = black · rebar = rust orange
const MAT = {
  slab:      new THREE.MeshStandardMaterial({ color: 0x9a9c9f, roughness: 0.95 }),           // concrete
  column:    new THREE.MeshStandardMaterial({ color: 0x6f7377, roughness: 0.9 }),             // concrete column (dark grey)
  beam:      new THREE.MeshStandardMaterial({ color: 0x141416, roughness: 0.5, metalness: 0.7 }), // steel beam (black)
  rebar:     new THREE.MeshStandardMaterial({ color: 0xc0602a, roughness: 0.55, metalness: 0.6 }), // exposed rebar (rust)
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

function onAdd(part) {
  const s = part.shape;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(s.hx * 2, s.hy * 2, s.hz * 2), MAT[part.matKind] || MAT.fragment);
  mesh.castShadow = true; mesh.receiveShadow = true;
  const t = part.body.translation(), r = part.body.rotation();
  mesh.position.set(t.x, t.y, t.z);
  mesh.quaternion.set(r.x, r.y, r.z, r.w);
  // embedded rebar: child meshes that ride with the concrete piece (exposed when it separates)
  if (part.rebars) {
    for (const d of part.rebars) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(d.hx * 2, d.hy * 2, d.hz * 2), MAT.rebar);
      bar.position.set(d.x, d.y, d.z);
      bar.castShadow = true;
      mesh.add(bar);
    }
  }
  part.mesh = mesh;
  structureGroup.add(mesh);
}
function onRemove(part) {
  if (part.mesh) { structureGroup.remove(part.mesh); part.mesh.geometry.dispose(); part.mesh = null; }
}

function clearMarkers() { for (const m of voidMarkers) markerGroup.remove(m); voidMarkers.length = 0; }

function rebuild() {
  if (sim) sim.dispose();
  clearMarkers();
  sim = new RubbleSim(RAPIER, params, { onAdd, onRemove });
  const n = sim.build();
  phase = 'standing'; timer = 0;
  setStatus(`standing ${params.stories}-story building (${n} pieces) — collapse in ${params.standSeconds}s`);
}

function doCollapse() {
  if (!sim || phase !== 'standing') return;
  sim.collapse(); phase = 'collapsing'; timer = 0;
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
  setStatus(`frozen • ${sim.parts.length} pieces • ${sim.stats.fractures} slabs fractured • ${sim.stats.snaps} snaps • ${voids.length} internal voids`);
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
fT.add(params, 'minVoidHeight', 0.3, 1.5, 0.05);
fT.add(params, 'showVoidMarkers').onChange((v) => voidMarkers.forEach((m) => (m.visible = v)));
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
    if (timer >= params.settleSeconds) doFreeze();
  }

  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

await RAPIER.init();
rebuild();
tick();
