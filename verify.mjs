// Headless verification of the collapse + void-detection pipeline (no three.js / WebGL).
// Mirrors src/main.js's physics logic so we can confirm the Rapier API calls work and
// that voids are detected INSIDE the settled rubble. Run: `node verify.mjs`.

import RAPIER from '@dimforge/rapier3d-compat';
import { makeRng } from './src/rng.js';

const P = {
  seed: 1, stories: 4, storyHeight: 2.6, buildingSize: 6, grid: 3,
  slabThickness: 0.22, columnSize: 0.34, furniturePerFloor: 3,
  columnsRemoved: 0.45, settleSteps: 900, voidGrid: 12, minVoidHeight: 0.45,
};

await RAPIER.init();
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
world.createCollider(RAPIER.ColliderDesc.cuboid(100, 0.5, 100).setTranslation(0, -0.5, 0).setFriction(0.9));
const rng = makeRng(P.seed);
const parts = [];

const addBox = (hx, hy, hz, pos, kind) => {
  const body = world.createRigidBody(RAPIER.RigidBodyDesc.fixed().setTranslation(pos.x, pos.y, pos.z));
  world.createCollider(RAPIER.ColliderDesc.cuboid(hx, hy, hz).setFriction(0.85).setDensity(2.4), body);
  parts.push({ body, kind });
};
const grid = (n, size) => Array.from({ length: n }, (_, i) => -size / 2 + (size / n) * (i + 0.5));

// build
const { stories, storyHeight: sh, buildingSize: B, grid: g, slabThickness: st, columnSize: cs } = P;
const tileHalf = B / g / 2, cells = grid(g, B), lines = grid(g, B);
for (let s = 0; s < stories; s++) {
  for (const cx of lines) for (const cz of lines) addBox(cs/2, sh/2, cs/2, { x: cx, y: s*sh + sh/2, z: cz }, 'column');
  for (const tx of cells) for (const tz of cells) addBox(tileHalf*0.97, st/2, tileHalf*0.97, { x: tx, y: s*sh + sh + st/2, z: tz }, 'slab');
  for (let f = 0; f < P.furniturePerFloor; f++) {
    const fw = rng.float(0.35,0.6), fh = rng.float(0.4,0.9), fd = rng.float(0.35,0.6);
    addBox(fw, fh, fd, { x: rng.float(-B/2+fw,B/2-fw), y: (s===0?0:(s*sh+st/2)+st/2)+fh, z: rng.float(-B/2+fd,B/2-fd) }, 'furniture');
  }
}
const built = parts.length;

// collapse
for (const p of parts) {
  const isGround = p.kind === 'column' && p.body.translation().y < sh;
  if (p.kind === 'column' && (isGround || rng.float(0,1) < P.columnsRemoved)) { world.removeRigidBody(p.body); p.dead = true; continue; }
  p.body.setBodyType(RAPIER.RigidBodyType.Dynamic, true);
  p.body.setLinvel({ x: rng.float(-0.4,0.4), y: 0, z: rng.float(-0.4,0.4) }, true);
}
for (let i = parts.length-1; i>=0; i--) if (parts[i].dead) parts.splice(i,1);

// settle
for (let i = 0; i < P.settleSteps; i++) world.step();
for (let i = parts.length-1; i>=0; i--) if (parts[i].body.translation().y < -0.5) { world.removeRigidBody(parts[i].body); parts.splice(i,1); }
for (const p of parts) p.body.setBodyType(RAPIER.RigidBodyType.Fixed, true);

// detect voids (same algorithm as main.js)
let top = 0; for (const p of parts) top = Math.max(top, p.body.translation().y); top += 0.5;
const probe = new RAPIER.Ball(0.06), rot = { x:0,y:0,z:0,w:1 };
const isSolid = (x,y,z) => world.intersectionWithShape({x,y,z}, rot, probe) !== null;
const ext = B/2 + 1, n = P.voidGrid, cell = (ext*2)/n, yStep = 0.15, cand = [];
for (let ix=0; ix<n; ix++) for (let iz=0; iz<n; iz++) {
  const x = -ext + cell*(ix+0.5), z = -ext + cell*(iz+0.5), occ = [];
  for (let y=0.1; y<=top; y+=yStep) occ.push([y, isSolid(x,y,z)]);
  let topSolid = -1; for (let k=occ.length-1;k>=0;k--) if (occ[k][1]) { topSolid = occ[k][0]; break; }
  if (topSolid < 0) continue;
  let k=0; while (k<occ.length) {
    if (!occ[k][1]) { let j=k; while (j<occ.length && !occ[j][1]) j++;
      const y0=occ[k][0], y1=occ[j-1][0], h=y1-y0+yStep;
      if (y1 < topSolid-1e-3 && h >= P.minVoidHeight) cand.push({ x, y:(y0+y1)/2, z, h });
      k=j; } else k++;
  }
}
cand.sort((a,b)=>b.h-a.h);
const kept=[], md=cell*0.9;
for (const c of cand) { if (kept.some(v=>Math.hypot(v.x-c.x,v.z-c.z)<md && Math.abs(v.y-c.y)<c.h)) continue; kept.push(c); }

// report
const pileTop = top - 0.5;
const buried = kept.filter(v => v.y < pileTop - 0.3).length;
console.log(`built pieces:        ${built}`);
console.log(`after collapse+drop: ${parts.length}`);
console.log(`pile top height:     ${pileTop.toFixed(2)} m`);
console.log(`voids detected:      ${kept.length}`);
console.log(`  of which buried (>0.3m below pile top): ${buried}`);
for (const v of kept.slice(0, 8)) console.log(`   void @ (${v.x.toFixed(2)}, ${v.y.toFixed(2)}, ${v.z.toFixed(2)})  gap ${v.h.toFixed(2)} m`);
const ok = parts.length > 0 && kept.length > 0 && buried > 0;
console.log(ok ? '\nPASS: collapse produced settled debris with internal (buried) voids.' : '\nFAIL: no internal voids detected.');
process.exit(ok ? 0 : 1);
