// RubbleSim Web — browser PoC: 4-story building collapse + confined-space void detection.
//
// Instead of raining random debris and pre-seeding floating voids, this models a real
// multi-story structure and collapses it:
//   build (columns + floor-slab tiles + furniture, standing as fixed bodies)
//     -> collapse (convert to dynamic, remove ground/random columns, gravity pancakes it)
//     -> settle -> freeze -> DETECT internal voids by ray-marching the settled geometry
//     -> export STL + voids JSON.
//
// Slabs pancaking onto furniture/columns leave lean-to and pancake voids UNDER the debris,
// exactly the survivable pockets USAR cares about. Voids are detected (not placed), so they
// are inside the rubble by construction.
//
// three.js for rendering, Rapier (WASM) for rigid-body physics.

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { STLExporter } from 'three/addons/exporters/STLExporter.js';
import GUI from 'lil-gui';
import RAPIER from '@dimforge/rapier3d-compat';
import { makeRng } from './rng.js';

const statusEl = document.getElementById('status');
const setStatus = (t) => { statusEl.textContent = t; };

// ---------------------------------------------------------------------------
// Parameters
// ---------------------------------------------------------------------------
const params = {
  seed: 1,
  stories: 4,
  storyHeight: 2.6,
  buildingSize: 6,       // footprint (x = z), metres
  grid: 3,               // slabs & columns are grid x grid per floor
  slabThickness: 0.22,
  columnSize: 0.34,
  furniturePerFloor: 3,  // void-preserving contents (desks/appliances)
  columnsRemoved: 0.45,  // fraction of columns deleted at collapse (higher = more total collapse)
  standSeconds: 1.2,     // show it standing before collapse
  settleSeconds: 7,      // collapse+settle time before auto-freeze
  // void detection
  voidGrid: 12,          // horizontal sampling resolution
  minVoidHeight: 0.45,   // shortest gap counted as a survivable void (m)
  showVoidMarkers: true,
  regenerate: () => generate(),
  collapseNow: () => collapse(),
  freezeNow: () => freezePile(),
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
scene.fog = new THREE.Fog(0x0b0d10, 30, 90);

const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.1, 500);
camera.position.set(14, 11, 16);

const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 4, 0);
controls.enableDamping = true;

scene.add(new THREE.HemisphereLight(0x9fbfff, 0x20160f, 0.75));
const sun = new THREE.DirectionalLight(0xfff2e0, 2.3);
sun.position.set(12, 22, 8);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.camera.near = 1; sun.shadow.camera.far = 80;
sun.shadow.camera.left = -22; sun.shadow.camera.right = 22;
sun.shadow.camera.top = 22; sun.shadow.camera.bottom = -22;
scene.add(sun);

const ground = new THREE.Mesh(
  new THREE.PlaneGeometry(200, 200),
  new THREE.MeshStandardMaterial({ color: 0x3a3f45, roughness: 1 })
);
ground.rotation.x = -Math.PI / 2;
ground.receiveShadow = true;
scene.add(ground);
scene.add(new THREE.GridHelper(48, 48, 0x223, 0x1a1f24));

addEventListener('resize', () => {
  camera.aspect = innerWidth / innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
});

// ---------------------------------------------------------------------------
// Physics world
// ---------------------------------------------------------------------------
await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
if ('numSolverIterations' in world.integrationParameters) {
  world.integrationParameters.numSolverIterations = 8; // steadier stacks (if supported)
}
world.createCollider(RAPIER.ColliderDesc.cuboid(100, 0.5, 100).setTranslation(0, -0.5, 0).setFriction(0.9));

// ---------------------------------------------------------------------------
// Materials
// ---------------------------------------------------------------------------
const MAT = {
  slab:      new THREE.MeshStandardMaterial({ color: 0x9a9c9f, roughness: 0.95 }),
  column:    new THREE.MeshStandardMaterial({ color: 0x6f7377, roughness: 0.95 }),
  furniture: new THREE.MeshStandardMaterial({ color: 0x9c6a3f, roughness: 0.9 }),
  rebar:     new THREE.MeshStandardMaterial({ color: 0x4a4a4a, roughness: 0.6, metalness: 0.4 }),
};

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------
let rng = makeRng(params.seed);
const parts = [];        // { mesh, body, kind } — all structural pieces
const voidMarkers = [];
let voidsGroundTruth = [];
let phase = 'idle';      // 'standing' | 'collapsing' | 'frozen'
let phaseTimer = 0;

const debrisGroup = new THREE.Group(); // everything exported to STL
const markerGroup = new THREE.Group();
scene.add(debrisGroup, markerGroup);

function addBox(hx, hy, hz, pos, mat, kind, { fixed = true, friction = 0.85, density = 2.4 } = {}) {
  const bodyDesc = (fixed ? RAPIER.RigidBodyDesc.fixed() : RAPIER.RigidBodyDesc.dynamic())
    .setTranslation(pos.x, pos.y, pos.z);
  const body = world.createRigidBody(bodyDesc);
  world.createCollider(
    RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(friction).setDensity(density),
    body
  );
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(hx * 2, hy * 2, hz * 2), mat);
  mesh.castShadow = true; mesh.receiveShadow = true;
  mesh.position.set(pos.x, pos.y, pos.z);
  debrisGroup.add(mesh);
  const part = { mesh, body, kind, fixed };
  parts.push(part);
  return part;
}

// ---------------------------------------------------------------------------
// Build a standing multi-story building (all fixed until collapse)
// ---------------------------------------------------------------------------
function gridPositions(n, size) {
  // n cell centers spanning [-size/2, +size/2]
  const out = [];
  const cell = size / n;
  for (let i = 0; i < n; i++) out.push(-size / 2 + cell * (i + 0.5));
  return out;
}

function buildBuilding() {
  const { stories, storyHeight: sh, buildingSize: B, grid: g, slabThickness: st, columnSize: cs } = params;
  const colHalf = cs / 2;
  const tileSize = B / g;
  const tileHalf = tileSize / 2;
  const cellCenters = gridPositions(g, B);
  // column lines: g+1 positions along each axis (at tile edges) — use inner (g) lines to sit under tile joints
  const colLines = gridPositions(g, B);

  for (let s = 0; s < stories; s++) {
    const base = s * sh;                    // bottom of this story's columns
    const colCenterY = base + sh / 2;
    // columns
    for (const cx of colLines) for (const cz of colLines) {
      addBox(colHalf, sh / 2, colHalf, { x: cx, y: colCenterY, z: cz }, MAT.column, 'column');
    }
    // floor-slab tiles on top of the columns (ceiling of story s)
    const slabY = base + sh + st / 2;
    for (const tx of cellCenters) for (const tz of cellCenters) {
      addBox(tileHalf * 0.97, st / 2, tileHalf * 0.97, { x: tx, y: slabY, z: tz }, MAT.slab, 'slab');
    }
    // furniture / void-preservers resting on the slab below (or ground for s=0)
    for (let f = 0; f < params.furniturePerFloor; f++) {
      const fw = rng.float(0.35, 0.6), fh = rng.float(0.4, 0.9), fd = rng.float(0.35, 0.6);
      const restY = (s === 0 ? 0 : (s * sh + st / 2) + st / 2) + fh; // top of slab-below
      addBox(fw, fh, fd,
        { x: rng.float(-B / 2 + fw, B / 2 - fw), y: restY, z: rng.float(-B / 2 + fd, B / 2 - fd) },
        MAT.furniture, 'furniture');
    }
  }
  // top roof slab already added as ceiling of the top story.
}

// ---------------------------------------------------------------------------
// Collapse: convert to dynamic, remove supporting columns, nudge for asymmetry
// ---------------------------------------------------------------------------
function collapse() {
  if (phase === 'collapsing' || phase === 'frozen') return;
  phase = 'collapsing';
  phaseTimer = 0;

  const columns = parts.filter((p) => p.kind === 'column');
  for (const p of parts) {
    // remove ground-floor columns + a random fraction of the rest to trigger failure
    const isGround = p.kind === 'column' && p.body.translation().y < params.storyHeight;
    const kill = p.kind === 'column' && (isGround || rng.float(0, 1) < params.columnsRemoved);
    if (kill) {
      world.removeRigidBody(p.body);
      debrisGroup.remove(p.mesh);
      p.dead = true;
      continue;
    }
    p.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
    p.fixed = false;
    // small random horizontal kick so it collapses messily rather than straight down
    p.body.setLinvel({ x: rng.float(-0.4, 0.4), y: 0, z: rng.float(-0.4, 0.4) }, true);
  }
  for (let i = parts.length - 1; i >= 0; i--) if (parts[i].dead) parts.splice(i, 1);
  setStatus(`collapsing • ${parts.length} pieces (seed ${params.seed})`);
}

// ---------------------------------------------------------------------------
// Freeze + detect voids
// ---------------------------------------------------------------------------
function freezePile() {
  if (phase === 'frozen') return;
  phase = 'frozen';

  for (let i = parts.length - 1; i >= 0; i--) {
    const p = parts[i];
    if (p.body.translation().y < -0.5) {
      world.removeRigidBody(p.body); debrisGroup.remove(p.mesh); parts.splice(i, 1);
    } else {
      p.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);
    }
  }
  syncMeshes();
  detectVoids();
  setStatus(`frozen • ${parts.length} pieces • ${voidsGroundTruth.length} internal voids detected`);
}

// Ray-march a grid of vertical lines through the settled pile. An empty gap that has
// solid debris above it (covered) and is tall enough is an enclosed, survivable void.
function detectVoids() {
  for (const m of voidMarkers) markerGroup.remove(m);
  voidMarkers.length = 0;
  voidsGroundTruth = [];

  // pile extent
  let top = 0, ext = params.buildingSize / 2 + 1;
  for (const p of parts) top = Math.max(top, p.body.translation().y);
  top += 0.5;

  const probe = new RAPIER.Ball(0.06);
  const rot = { x: 0, y: 0, z: 0, w: 1 };
  const isSolid = (x, y, z) => world.intersectionWithShape({ x, y, z }, rot, probe) !== null;

  const n = params.voidGrid;
  const cell = (ext * 2) / n;
  const yStep = 0.15;
  const candidates = [];

  for (let ix = 0; ix < n; ix++) {
    for (let iz = 0; iz < n; iz++) {
      const x = -ext + cell * (ix + 0.5);
      const z = -ext + cell * (iz + 0.5);

      // sample occupancy from the ground up
      const occ = [];
      for (let y = 0.1; y <= top; y += yStep) occ.push([y, isSolid(x, y, z)]);

      // topmost solid in this column
      let topSolid = -1;
      for (let k = occ.length - 1; k >= 0; k--) if (occ[k][1]) { topSolid = occ[k][0]; break; }
      if (topSolid < 0) continue;

      // find empty runs that are covered (below topSolid) and tall enough
      let k = 0;
      while (k < occ.length) {
        if (!occ[k][1]) {
          let j = k;
          while (j < occ.length && !occ[j][1]) j++;
          const y0 = occ[k][0], y1 = occ[j - 1][0];
          const height = y1 - y0 + yStep;
          const covered = y1 < topSolid - 1e-3;          // solid exists above the gap
          if (covered && height >= params.minVoidHeight) {
            candidates.push({ x, y: (y0 + y1) / 2, z, height, radius: Math.min(height, cell) / 2 });
          }
          k = j;
        } else k++;
      }
    }
  }

  // greedy spatial dedup so overlapping samples don't produce a cloud of markers
  candidates.sort((a, b) => b.height - a.height);
  const kept = [];
  const mergeDist = cell * 0.9;
  for (const c of candidates) {
    if (kept.some((v) => Math.hypot(v.x - c.x, v.z - c.z) < mergeDist && Math.abs(v.y - c.y) < c.height)) continue;
    kept.push(c);
  }

  for (const v of kept) {
    voidsGroundTruth.push({ x: v.x, y: v.y, z: v.z, radius: +v.radius.toFixed(3), height: +v.height.toFixed(3), shape: 'detected' });
    const m = new THREE.Mesh(
      new THREE.SphereGeometry(v.radius, 14, 10),
      new THREE.MeshBasicMaterial({ color: 0x4fd6ff, wireframe: true })
    );
    m.position.set(v.x, v.y, v.z);
    m.visible = params.showVoidMarkers;
    markerGroup.add(m);
    voidMarkers.push(m);
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------
function clearAll() {
  for (const p of parts) { world.removeRigidBody(p.body); debrisGroup.remove(p.mesh); p.mesh.geometry.dispose?.(); }
  for (const m of voidMarkers) markerGroup.remove(m);
  parts.length = 0; voidMarkers.length = 0; voidsGroundTruth = [];
}

function generate() {
  clearAll();
  rng = makeRng(params.seed);
  buildBuilding();
  phase = 'standing';
  phaseTimer = 0;
  setStatus(`standing ${params.stories}-story building • collapse in ${params.standSeconds}s (C to force)`);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
function download(name, data, type) {
  const url = URL.createObjectURL(new Blob([data], { type }));
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  URL.revokeObjectURL(url);
}
function exportSTL() {
  download(`Collapse_seed${params.seed}.stl`, new STLExporter().parse(debrisGroup, { binary: true }), 'application/octet-stream');
  setStatus('exported debris STL');
}
function exportVoids() {
  download(`Voids_seed${params.seed}.json`, JSON.stringify({ seed: params.seed, voids: voidsGroundTruth }, null, 2), 'application/json');
  setStatus('exported voids JSON');
}

// ---------------------------------------------------------------------------
// GUI + input
// ---------------------------------------------------------------------------
const gui = new GUI({ title: 'RubbleSim Web — collapse' });
gui.add(params, 'seed', 0, 9999, 1);
const fB = gui.addFolder('Building');
fB.add(params, 'stories', 1, 8, 1);
fB.add(params, 'storyHeight', 1.5, 4, 0.1);
fB.add(params, 'buildingSize', 3, 12, 0.5);
fB.add(params, 'grid', 2, 5, 1);
fB.add(params, 'furniturePerFloor', 0, 8, 1);
const fC = gui.addFolder('Collapse');
fC.add(params, 'columnsRemoved', 0, 1, 0.05);
fC.add(params, 'standSeconds', 0, 5, 0.2);
fC.add(params, 'settleSeconds', 2, 15, 0.5);
const fV = gui.addFolder('Voids');
fV.add(params, 'voidGrid', 6, 20, 1);
fV.add(params, 'minVoidHeight', 0.2, 1.5, 0.05);
fV.add(params, 'showVoidMarkers').onChange((v) => voidMarkers.forEach((m) => (m.visible = v)));
gui.add(params, 'regenerate').name('Rebuild (P)');
gui.add(params, 'collapseNow').name('Collapse (C)');
gui.add(params, 'freezeNow').name('Freeze now (F)');
gui.add(params, 'exportSTL').name('Export debris STL');
gui.add(params, 'exportVoids').name('Export voids JSON');

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'p') generate();
  else if (k === 'c') collapse();
  else if (k === 'f') freezePile();
  else if (k === 'v') { params.showVoidMarkers = !params.showVoidMarkers; voidMarkers.forEach((m) => (m.visible = params.showVoidMarkers)); }
});

// ---------------------------------------------------------------------------
// Main loop
// ---------------------------------------------------------------------------
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
let last = performance.now();

function syncMeshes() {
  for (const p of parts) {
    const t = p.body.translation();
    const r = p.body.rotation();
    p.mesh.position.copy(_p.set(t.x, t.y, t.z));
    p.mesh.quaternion.copy(_q.set(r.x, r.y, r.z, r.w));
  }
}

function tick() {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.05);
  last = now;

  if (phase === 'standing') {
    phaseTimer += dt;
    if (phaseTimer >= params.standSeconds) collapse();
  } else if (phase === 'collapsing') {
    for (let s = 0; s < 3; s++) world.step();
    syncMeshes();
    phaseTimer += dt;
    if (phaseTimer >= params.settleSeconds) freezePile();
  }

  controls.update();
  renderer.render(scene, camera);
  requestAnimationFrame(tick);
}

generate();
tick();
