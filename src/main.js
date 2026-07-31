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
import { ensureAudio, playContact, startGrind, stopGrind } from './audio.js';

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
  showStress: false,         // §4A stress map (grey -> red)
  stressRefLoad: 150,        // kN that reads as "fully stressed" for debris contact force
  stressEveryNFrames: 6,     // §4A "query every N frames" — the map is not free
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
// Layers gate RENDERING as well as raycasting, and a camera only renders layer 0 by default.
// Rebar (layer 1) and void volumes (layer 2) are on their own layers purely so the active tool
// can filter what it picks (specs.md §4B) — the camera must still draw them, or reinforcement and
// void markers silently vanish from the scene.
camera.layers.enable(1);
camera.layers.enable(2);
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

// Generic cursor for the tools added after the disc/pliers: a glyph on a ringed puck. The ring is
// the engagement tell, same as the disc's rim and the pliers' jaws — grey when there is no valid
// target, green when the tool can act.
function makeGlyphTexture(glyph, ring, tint) {
  const s = 256, cv = document.createElement('canvas'); cv.width = cv.height = s;
  const g = cv.getContext('2d');
  g.clearRect(0, 0, s, s);
  g.beginPath(); g.arc(s * 0.5, s * 0.5, s * 0.33, 0, Math.PI * 2);
  g.fillStyle = 'rgba(18,22,27,0.82)'; g.fill();
  g.lineWidth = 12; g.strokeStyle = ring; g.stroke();
  g.font = `${Math.round(s * 0.34)}px system-ui, sans-serif`;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = tint;
  g.fillText(glyph, s * 0.5, s * 0.54);
  const tex = new THREE.CanvasTexture(cv); tex.anisotropy = 4; return tex;
}

const discFree = makeBladeTexture('#3a3f45');
const discOn = makeBladeTexture('#33ff88');       // green rim = touching a surface
const pliersFree = makePliersTexture('#9aa0a6');
const pliersOn = makePliersTexture('#33ff88');    // green jaws = rebar in reach

// Per-tool cursor pair, built once and cached.
const GLYPHS = { slice: ['⇥', '#7fd4ff'], torch: ['🔥', '#ffb347'], hammer: ['🔨', '#dfe6ee'],
                 bag: ['◓', '#ffd76a'], shore: ['⌶', '#c79a5b'] };
const texCache = new Map();
function toolTextures(tool) {
  if (!tool) return { free: discFree, on: discOn };
  if (tool.kind === 'hole') return { free: discFree, on: discOn };
  if (tool.kind === 'rebar') return { free: pliersFree, on: pliersOn };
  if (!texCache.has(tool.kind)) {
    const [glyph, tint] = GLYPHS[tool.kind] || ['•', '#dfe6ee'];
    texCache.set(tool.kind, {
      free: makeGlyphTexture(glyph, '#3a3f45', tint),
      on: makeGlyphTexture(glyph, '#33ff88', tint),
    });
  }
  return texCache.get(tool.kind);
}
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

// ---------------------------------------------------------------------------
// Sim wiring — a mesh per physics part
// ---------------------------------------------------------------------------
let sim;
const voidMarkers = [];
let phase = 'idle';
let timer = 0;
let settleDuration = 8;   // seconds of re-settling before auto-freeze (collapse vs cut)

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
  if (voidMarkers.length) {
    rows.push('<h4>Voids</h4>');
    const cls = compromised > 0 ? 'bad' : 'ok';
    rows.push(`<div class="row"><span>detected</span><span>${voidMarkers.length}</span></div>`);
    rows.push(`<div class="row"><span>compromised</span><span class="${cls}">${compromised}</span></div>`);
  }
  loadsEl.innerHTML = rows.join('');
}

function rebuild() {
  if (sim) sim.dispose();
  clearMarkers();
  for (const [, mesh] of bagMeshes) { structureGroup.remove(mesh); disposeMesh(mesh); }
  bagMeshes.clear();
  compromised = 0; voidEvents.length = 0;
  sim = new RubbleSim(RAPIER, params, { onAdd, onRemove, onReshape, onExpose });
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
  // specs.md §4C — render the ray-marched void bounds as transparent VOLUMES (opacity 0.3), not
  // wireframe spheres: the survivable space is a box-ish pocket and its extent is what matters.
  for (const v of voids) {
    const geo = new THREE.BoxGeometry(v.radius * 2, v.height, v.radius * 2);
    const m = new THREE.Mesh(geo,
      new THREE.MeshBasicMaterial({ color: 0x4fd6ff, transparent: true, opacity: 0.3,
        depthWrite: false, side: THREE.DoubleSide }));
    // A void is buried by definition, so a depth-tested fill alone is invisible from outside the
    // pile. The edges are drawn with depthTest:false so the pocket's extent always reads, while
    // the translucent fill still gives the volume when the camera is inside or looking through.
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo),
      new THREE.LineBasicMaterial({ color: 0x4fd6ff, transparent: true, opacity: 0.55, depthTest: false }));
    edges.renderOrder = 990;
    edges.layers.set(LAYER_VOID);
    m.add(edges);
    m.position.set(v.x, v.y, v.z);
    m.visible = params.showVoidMarkers;
    m.userData.void = v;
    m.userData.compromised = false;
    m.userData.edges = edges;
    m.layers.set(LAYER_VOID);            // never pickable by a tool
    markerGroup.add(m); voidMarkers.push(m);
  }
  compromised = 0;
  phase = 'frozen';
  updateStressMap();
  setStatus(`frozen • ${sim.parts.length} pieces • ${sim.stats.cracks} cracks • ${sim.stats.snaps} snaps • ${sim.stats.cuts} cuts • ${voids.length} voids`);
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
      if (part.dead || part.shore) continue;
      const t = part.body.translation(), s = part.shape;
      if (Math.abs(t.x - v.x) < v.radius + s.hx &&
          Math.abs(t.z - v.z) < v.radius + s.hz &&
          Math.abs(t.y - v.y) < v.height / 2 + s.hy) {
        marker.userData.compromised = true;
        marker.material.color.set(0xff3344);
        marker.material.opacity = 0.45;
        if (marker.userData.edges) marker.userData.edges.material.color.set(0xff3344);
        compromised++;
        voidEvents.push({ type: 'SURVIVOR_COMPROMISED', x: v.x, y: v.y, z: v.z, by: part.kind });
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
// specs.md §4B — ONE piece of global state for the active tool. Everything else (cursor art,
// raycast layer, status text, HUD highlight) derives from it.
let activeTool = null;                                   // an EQUIPMENT entry, or null for NONE
const toolKind = () => (activeTool ? activeTool.kind : null);
const toolActive = () => !!activeTool;

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

function updateBlade(clientX, clientY) {
  if (!toolActive() || !sim) return;
  const r = renderer.domElement.getBoundingClientRect();
  ndc.set(((clientX - r.left) / r.width) * 2 - 1, -((clientY - r.top) / r.height) * 2 + 1);
  raycaster.setFromCamera(ndc, camera);
  const hits = raycaster.intersectObjects(structureGroup.children, true);
  cutSquare.visible = false;
  if (hits.length) {
    const h = hits[0];
    hitPoint.copy(h.point);
    if (h.face) hitNormal.copy(h.face.normal).transformDirection(h.object.matrixWorld).normalize();
    hitPart = h.object.userData.part || (h.object.parent && h.object.parent.userData.part) || null;
    blade.material.opacity = 1;
    const kind = toolKind();
    if (kind === 'rebar') {
      // engaged only when an exposed rebar (a cracked fracture) is within the short mouth
      const near = sim.exposedRebarNear(hitPoint, params.cutReach);
      engaged = !!near;
      const p = near || hitPoint;                        // snap the pliers to the rebar if found
      blade.position.set(p.x, p.y, p.z).addScaledVector(hitNormal, 0.05);
    } else if (kind === 'torch') {
      engaged = !!sim.joints.find((rec) => !rec.broken && !rec.a.dead && !rec.b.dead &&
        (rec.type === 'tie' || rec.type === 'member') && jointNear(rec, hitPoint, activeTool.reach));
      blade.position.copy(hitPoint).addScaledVector(hitNormal, 0.05);
    } else if (kind === 'bag') {
      // a bag needs something overhead to push against
      engaged = !!hitPart;
      blade.position.copy(hitPoint).addScaledVector(hitNormal, 0.05);
    } else if (kind === 'shore') {
      // a shore needs headroom at the ground position under the cursor
      engaged = shoreFits(hitPoint);
      blade.position.copy(hitPoint).addScaledVector(hitNormal, 0.05);
    } else {
      engaged = true;
      blade.position.copy(hitPoint).addScaledVector(hitNormal, 0.05);
      if (kind === 'hole' || kind === 'slice') {
        cutSquare.visible = true;
        cutSquare.position.copy(hitPoint).addScaledVector(hitNormal, 0.02);
        cutSquare.quaternion.setFromUnitVectors(_zAxis, hitNormal);
      }
    }
  } else {
    engaged = false; blade.material.opacity = 0.35;
  }
  if (engaged !== wasEngaged) {
    blade.material.map = engaged ? activeOnTex : activeFreeTex;   // green = ready to act
    blade.material.needsUpdate = true;
    if (engaged) playContact();
  }
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

function setEquipment(label) {
  const tool = equipmentByLabel(label);
  activeTool = tool || null;
  params.equipment = tool ? tool.label : 'None';
  blade.visible = !!tool; cutSquare.visible = false;
  engaged = false; wasEngaged = false;
  const tex = toolTextures(tool);
  activeFreeTex = tex.free; activeOnTex = tex.on;
  blade.material.map = activeFreeTex; blade.material.needsUpdate = true;
  setRaycastLayers();
  refreshToolRing();
  // left-drag still orbits; free the RIGHT button so right-click can act
  controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
  controls.mouseButtons.RIGHT = tool ? null : THREE.MOUSE.PAN;
  if (!tool) { setStatus('tool: none — left-drag orbits'); return; }
  if (tool.kind === 'hole' || tool.kind === 'slice') refreshSquare();
  setStatus(`${tool.label} — ${tool.hint} RIGHT-CLICK to use.`);
}

// Use the active tool at the cursor (right-click / Apply / Enter).
function applyEquipment() {
  if (!sim || !activeTool) return;
  const tool = activeTool;
  if (!engaged) { setStatus(`${tool.label}: no valid target under the cursor (indicator turns GREEN when ready)`); return; }
  const point = { x: hitPoint.x, y: hitPoint.y, z: hitPoint.z };

  if (tool.kind === 'hole') {
    // Cut only where the blade actually is — an intact slab. No silent fallback.
    if (!hitPart || hitPart.kind !== 'slab' || hitPart.frame) {
      setStatus('aim at an intact grey slab (not a beam or an already-cut hole)');
      return;
    }
    hitPart.mesh.updateWorldMatrix(true, false);
    const local = hitPart.mesh.worldToLocal(hitPoint.clone());
    const res = sim.cutHoleInSlab(hitPart, local.x, local.z, params.holeSize / 2, params.holeSize / 2);
    if (!res) { setStatus('could not cut a hole there'); return; }
    grind(400);
    lastCutWorld.set(res.holeWorld.x, res.holeWorld.y, res.holeWorld.z);
    addCutMarks([res.holeWorld]);
    resume();
    setStatus('✂ square hole cut — plug dropping into the void below');
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

function grind(ms) { ensureAudio(); startGrind(); setTimeout(stopGrind, ms); }
function resume() { settleDuration = params.cutSettleSeconds; phase = 'collapsing'; timer = 0; }

renderer.domElement.addEventListener('contextmenu', (e) => { if (toolActive()) e.preventDefault(); });
renderer.domElement.addEventListener('pointermove', (e) => updateBlade(e.clientX, e.clientY));
renderer.domElement.addEventListener('pointerdown', (e) => {
  if (e.button === 2 && toolActive()) { e.preventDefault(); updateBlade(e.clientX, e.clientY); applyEquipment(); }
});

// --- tool ring HUD (specs.md §4B) -----------------------------------------------------------
const TOOL_ICONS = {
  hole: '⬛', slice: '🪚', rebar: '✂', torch: '🔥', hammer: '🔨', bag: '🎈', shore: '🪵',
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
  for (const b of ringEl.children) {
    b.setAttribute('aria-pressed', String(b.dataset.tool === (activeTool ? activeTool.id : 'NONE')));
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
fR.add(params, 'rebarSpacing', 0.05, 0.25, 0.01).name('grid spacing (m)');
fR.add(params, 'rebarThickness', 0.003, 0.015, 0.001).name('rod radius (m)');
fR.add(params, 'rebarCover', 0.01, 0.06, 0.005).name('cover (m)');
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
fS.add(params, 'concreteFc', 15e3, 50e3, 1e3).name("f'c kPa");
fS.add(params, 'rescuerLoad', 0.5, 5, 0.1).name('rescuer live load kN');
const fT = gui.addFolder('Timing / voids');
fT.add(params, 'standSeconds', 0, 5, 0.2);
fT.add(params, 'settleSeconds', 3, 15, 0.5);
fT.add(params, 'cutSettleSeconds', 1, 8, 0.5).name('cut re-settle secs');
fT.add(params, 'minVoidHeight', 0.3, 1.5, 0.05);
fT.add(params, 'showVoidMarkers').onChange((v) => voidMarkers.forEach((m) => (m.visible = v)));
const fEq = gui.addFolder('Equipment');
fEq.add(params, 'equipment', TOOL_LABELS).onChange(setEquipment).listen();
fEq.add(params, 'holeSize', 0.3, 1.5, 0.1).name('hole size (concrete)').onChange(() => refreshSquare());
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
gui.add(params, 'exportSTL').name('Export debris STL');
gui.add(params, 'exportVoids').name('Export voids JSON');

addEventListener('keydown', (e) => {
  const k = e.key.toLowerCase();
  if (k === 'p') rebuild();
  else if (k === 'c') doCollapse();
  else if (k === 'f') doFreeze();
  else if (k === 'v') { params.showVoidMarkers = !params.showVoidMarkers; voidMarkers.forEach((m) => (m.visible = params.showVoidMarkers)); }
  else if (k === 's') { params.showStress = !params.showStress; updateStressMap(); setStatus(`stress map ${params.showStress ? 'ON — grey→red is utilization / contact load' : 'off'}`); }
  else if (k === 'enter') applyEquipment();
  else if (k === '0') setEquipment('None');
  else {
    // 1..7 select a tool straight off the ring (specs.md §4B)
    const tool = EQUIPMENT.find((t) => t.key === k);
    if (tool) setEquipment(tool.label);
  }
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

let frameNo = 0;
function tick() {
  const now = performance.now();
  const dt = Math.min((now - last) / 1000, 0.05); last = now;
  frameNo++;

  if (phase === 'standing') {
    timer += dt;
    if (timer >= params.standSeconds) doCollapse();
  } else if (phase === 'collapsing') {
    sim.step();
    syncMeshes();
    syncBagMeshes();
    checkVoidIntrusion();          // §4C — debris shifting into a survivable void
    timer += dt;
    if (timer >= settleDuration) doFreeze();
  }

  // §4A — the stress map is sampled every N frames, not every frame: rebuilding the support
  // graph means walking every contact manifold in the pile.
  if (params.showStress && phase === 'collapsing' && frameNo % params.stressEveryNFrames === 0) updateStressMap();
  if (frameNo % 10 === 0) updateLoadPanel();

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
    engaged: () => engaged,
    // structural / rescue state for the newer features
    frameReport: () => (sim.frame ? sim.frame.report() : null),
    rescueReport: () => (sim.rescue ? sim.rescue.report() : null),
    voids: () => voidMarkers.map((m) => m.userData.void),
    compromised: () => compromised,
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
