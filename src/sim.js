// RubbleSim physics core — framework-agnostic (no three.js / DOM).
// Used by src/main.js (rendered) and verify.mjs (headless CI).
//
// Reinforced-concrete collapse model (informed by real USAR collapse photos):
//   - Floor slabs are grids of concrete tiles TIED TOGETHER by rebar (fixed joints).
//     They stay coherent panels that tilt/pancake — creating lean-to voids — rather than
//     shattering into loose cubes. A tie tears only under extreme bend, so panels stay
//     connected; rebar bars remain EMBEDDED and become EXPOSED at cracks (not falling off).
//   - Columns are reinforced concrete: stiff segment chains that SNAP at overload, with a
//     rebar cage that stays attached and protrudes from the break.
//   - Beams are steel members that snap; they get buried under the pancaking slabs.
//   - Heavy densities, moderate restitution, damping => a building collapse, not bouncy blocks.
//
// The renderer supplies onAdd/onRemove callbacks to mirror parts as meshes. Each part
// carries a box `shape` {hx,hy,hz} and a `matKind` so the renderer knows what to draw.

import { makeRng } from './rng.js';

export const DEFAULTS = {
  seed: 1,
  // building
  stories: 4,
  storyHeight: 2.6,
  buildingSize: 6,
  grid: 3,                 // grid x grid columns and slab tiles per floor
  columnSize: 0.4,
  beamSize: 0.34,
  slabThickness: 0.22,
  furniturePerFloor: 3,
  colSegments: 3,
  beamSegments: 3,
  rebarThickness: 0.035,
  // physics
  gravity: 40,
  restitution: 0.38,
  friction: 0.9,
  linearDamping: 0.12,
  angularDamping: 0.35,
  densityConcrete: 2.4,
  densitySteel: 3.1,
  substeps: 3,
  // failure
  columnsRemoved: 0.4,     // fraction of columns removed at collapse
  contactEventThreshold: 20,
  beamSnapForce: 3500,     // hard impact that snaps a member joint
  beamSnapAngle: 0.035,    // bend angle (rad) that snaps a member joint
  slabCrackForce: 2800,    // hard impact cracks one concrete seam -> rebar hinge (sparse cracks = large pieces)
  slabTearAngle: 0.7,      // extreme fold where the REBAR itself tears (rare, full separation)
  maxBreaksPerMember: 1,   // members snap into at most 2 pieces (never shatter)
  maxParts: 2500,
  // void detection
  voidGrid: 9,
  minVoidHeight: 0.9,      // only clearly survivable pockets
};

const qConj = (q) => ({ x: -q.x, y: -q.y, z: -q.z, w: q.w });
const qMul = (a, b) => ({
  w: a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z,
  x: a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
  y: a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
  z: a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
});
const relAngle = (qa, qb) => {
  const r = qMul(qConj(qa), qb);
  return 2 * Math.acos(Math.min(1, Math.abs(r.w)));
};

export class RubbleSim {
  constructor(RAPIER, opts = {}, callbacks = {}) {
    this.R = RAPIER;
    this.opts = { ...DEFAULTS, ...opts };
    this.onAdd = callbacks.onAdd || (() => {});
    this.onRemove = callbacks.onRemove || (() => {});
    this.phase = 'idle';
    this._init();
  }

  _init() {
    const R = this.R;
    this.world = new R.World({ x: 0, y: -this.opts.gravity, z: 0 });
    this.world.integrationParameters.dt = 1 / 120;
    if ('numSolverIterations' in this.world.integrationParameters) {
      this.world.integrationParameters.numSolverIterations = 12; // steadier joint networks
    }
    this.events = new R.EventQueue(true);
    this.world.createCollider(
      R.ColliderDesc.cuboid(100, 0.5, 100).setTranslation(0, -0.5, 0)
        .setRestitution(0).setFriction(this.opts.friction)
    );
    this.parts = [];
    this.members = [];
    this.joints = [];        // records: {joint, a, b, type:'member'|'tie', breakAngle, member?, broken}
    this.colliderToPart = new Map();
    this.rng = makeRng(this.opts.seed);
    this.stats = { snaps: 0, cracks: 0, tears: 0, maxForce: 0, maxBend: 0 };
  }

  clear() { for (const p of this.parts) this.onRemove(p); this.world.free(); this.events.free(); this._init(); }
  dispose() { for (const p of this.parts) this.onRemove(p); this.parts.length = 0; this.world.free(); this.events.free(); }

  // ---- primitives ----
  // `rebars` is an array of local-frame box descriptors {hx,hy,hz,x,y,z}; the renderer draws
  // them as child meshes embedded in this concrete piece (visual reinforcement, no physics).
  _addBox(shape, pos, rot, matKind, { fixed, density, events = false, member = null, rebars = null }) {
    if (this.parts.length >= this.opts.maxParts) return null;
    const R = this.R;
    const bd = (fixed ? R.RigidBodyDesc.fixed() : R.RigidBodyDesc.dynamic())
      .setTranslation(pos.x, pos.y, pos.z)
      .setLinearDamping(this.opts.linearDamping)
      .setAngularDamping(this.opts.angularDamping)
      .setCcdEnabled(true);
    if (rot) bd.setRotation(rot);
    const body = this.world.createRigidBody(bd);
    let cd = R.ColliderDesc.cuboid(shape.hx, shape.hy, shape.hz)
      .setRestitution(this.opts.restitution).setFriction(this.opts.friction).setDensity(density);
    if (events) cd = cd.setActiveEvents(R.ActiveEvents.CONTACT_FORCE_EVENTS).setContactForceEventThreshold(this.opts.contactEventThreshold);
    const col = this.world.createCollider(cd, body);
    const part = { body, col, shape, matKind, kind: matKind, fixed, member, rebars };
    this.parts.push(part);
    this.colliderToPart.set(col.handle, part);
    this.onAdd(part);
    return part;
  }

  // fixed joint welding two bodies; type controls how/when it tears
  _weld(a, b, anchorA, anchorB, type, breakAngle, member = null) {
    const id = { x: 0, y: 0, z: 0, w: 1 };
    const joint = this.world.createImpulseJoint(this.R.JointData.fixed(anchorA, id, anchorB, id), a.body, b.body, true);
    const rec = { joint, a, b, anchorA, anchorB, type, breakAngle, member, broken: false, cracked: false };
    this.joints.push(rec);
    if (member) member.joints.push(rec);
    return rec;
  }

  // concrete cracks: replace a rigid tie with a revolute HINGE along the crack line, so the
  // slab pieces fold but stay connected by "rebar" (removed only if later torn).
  _crackTie(rec) {
    this.world.removeImpulseJoint(rec.joint, true);
    const jd = this.R.JointData.revolute(rec.anchorA, rec.anchorB, rec.hingeAxis);
    rec.joint = this.world.createImpulseJoint(jd, rec.a.body, rec.b.body, true);
    rec.cracked = true;
    this.stats.cracks++;
  }

  // stiff linear member (column/beam): chain of box segments held by snap-able fixed joints
  _member(kind, from, to, cross, nSeg, density, withRebar) {
    const member = { kind, segments: [], joints: [], breaks: 0 };
    this.members.push(member);
    const dir = { x: to.x - from.x, y: to.y - from.y, z: to.z - from.z };
    const seg = Math.hypot(dir.x, dir.y, dir.z) / nSeg;
    const axis = Math.abs(dir.y) > Math.max(Math.abs(dir.x), Math.abs(dir.z)) ? 'y' : Math.abs(dir.x) >= Math.abs(dir.z) ? 'x' : 'z';
    const half = { x: cross / 2, y: cross / 2, z: cross / 2 }; half[axis] = seg / 2;
    const anchor = { x: 0, y: 0, z: 0 }; anchor[axis] = seg / 2;
    const th = this.opts.rebarThickness;
    const crossAxes = ['x', 'y', 'z'].filter((a) => a !== axis);
    // reinforced-concrete columns carry a rebar cage: per-segment bars slightly longer than
    // the segment so they protrude (and stay attached) where the concrete snaps. Visual only.
    const segRebars = () => {
      if (!withRebar) return null;
      const bars = [];
      for (const [s1, s2] of [[-1, -1], [1, 1]]) {
        const d = { hx: th, hy: th, hz: th, x: 0, y: 0, z: 0 };
        d['h' + axis] = seg / 2 * 1.2;
        d[crossAxes[0]] = s1 * cross * 0.3;
        d[crossAxes[1]] = s2 * cross * 0.3;
        bars.push(d);
      }
      return bars;
    };
    let prev = null;
    for (let i = 0; i < nSeg; i++) {
      const t = (i + 0.5) / nSeg;
      const pos = { x: from.x + dir.x * t, y: from.y + dir.y * t, z: from.z + dir.z * t };
      const part = this._addBox({ hx: half.x, hy: half.y, hz: half.z }, pos, null, kind,
        { fixed: true, density, events: true, member, rebars: segRebars() });
      if (!part) break;
      member.segments.push(part);
      if (prev) this._weld(prev, part, { ...anchor }, { x: -anchor.x, y: -anchor.y, z: -anchor.z }, 'member', this.opts.beamSnapAngle, member);
      prev = part;
    }
    return member;
  }

  build() {
    this.clear();
    this.rng = makeRng(this.opts.seed);
    const o = this.opts, B = o.buildingSize, g = o.grid, sh = o.storyHeight, st = o.slabThickness;
    const spacing = B / g, tileHalf = spacing / 2 * 0.98, th = o.rebarThickness;
    const lines = Array.from({ length: g }, (_, i) => -B / 2 + spacing * (i + 0.5));

    for (let s = 0; s < o.stories; s++) {
      const base = s * sh, topY = base + sh;
      for (const cx of lines) for (const cz of lines)
        this._member('column', { x: cx, y: base, z: cz }, { x: cx, y: topY, z: cz }, o.columnSize, o.colSegments, o.densitySteel, true);
      const lo = lines[0], hi = lines[g - 1];
      for (const z of [lo, hi]) this._member('beam', { x: lo, y: topY, z }, { x: hi, y: topY, z }, o.beamSize, o.beamSegments, o.densitySteel, false);
      for (const x of [lo, hi]) this._member('beam', { x, y: topY, z: lo }, { x, y: topY, z: hi }, o.beamSize, o.beamSegments, o.densitySteel, false);

      // floor = grid of concrete tiles tied edge-to-edge by rebar (a coherent panel)
      const slabY = topY + o.beamSize / 2 + st / 2;
      const tiles = [];
      for (let i = 0; i < g; i++) {
        tiles[i] = [];
        for (let j = 0; j < g; j++) {
          // top-surface rebar cross (reinforcement mesh), slightly oversized so it meets the
          // neighbours / protrudes at a tear. Visual child descriptors, no physics.
          const tileRebars = [
            { hx: tileHalf * 1.05, hy: th, hz: th, x: 0, y: st / 2 + th, z: 0 },
            { hx: th, hy: th, hz: tileHalf * 1.05, x: 0, y: st / 2 + th, z: 0 },
          ];
          tiles[i][j] = this._addBox({ hx: tileHalf, hy: st / 2, hz: tileHalf },
            { x: lines[i], y: slabY, z: lines[j] }, null, 'slab',
            { fixed: true, density: o.densityConcrete, events: true, rebars: tileRebars });
        }
      }
      // Tie tiles into a coherent panel as a SPANNING TREE (no joint loops — a full grid of
      // fixed joints is cyclic and blows up the solver). Row chains + one column linking rows.
      const A = spacing / 2;
      for (let i = 0; i < g; i++)
        for (let j = 0; j + 1 < g; j++) {
          const rec = this._weld(tiles[i][j], tiles[i][j + 1], { x: 0, y: 0, z: A }, { x: 0, y: 0, z: -A }, 'tie', o.slabTearAngle);
          rec.hingeAxis = { x: 1, y: 0, z: 0 };   // crack line runs along x
        }
      for (let i = 0; i + 1 < g; i++) {
        const rec = this._weld(tiles[i][0], tiles[i + 1][0], { x: A, y: 0, z: 0 }, { x: -A, y: 0, z: 0 }, 'tie', o.slabTearAngle);
        rec.hingeAxis = { x: 0, y: 0, z: 1 };      // crack line runs along z
      }

      for (let f = 0; f < o.furniturePerFloor; f++) {
        const fw = this.rng.float(0.35, 0.6), fh = this.rng.float(0.4, 0.9), fd = this.rng.float(0.35, 0.6);
        this._addBox({ hx: fw, hy: fh, hz: fd },
          { x: this.rng.float(-B / 2 + fw, B / 2 - fw), y: (s === 0 ? 0 : base + st) + fh, z: this.rng.float(-B / 2 + fd, B / 2 - fd) },
          null, 'furniture', { fixed: true, density: o.densityConcrete });
      }
    }
    this.phase = 'standing';
    return this.parts.length;
  }

  collapse() {
    if (this.phase === 'collapsing' || this.phase === 'frozen') return;
    const R = this.R, o = this.opts, sh = o.storyHeight;
    for (const m of this.members) {
      if (m.kind !== 'column') continue;
      const lowY = Math.min(...m.segments.map((s) => s.body.translation().y));
      if (lowY < sh * 0.9 || this.rng.float(0, 1) < o.columnsRemoved) { for (const s of m.segments) this._removePart(s); m.removed = true; }
    }
    for (const p of [...this.parts]) {
      if (p.dead) continue;
      p.body.setBodyType(R.RigidBodyType.Dynamic, true); p.fixed = false;
      p.body.setLinvel({ x: this.rng.float(-0.5, 0.5), y: 0, z: this.rng.float(-0.5, 0.5) }, true);
    }
    this.phase = 'collapsing';
  }

  _removePart(p) {
    if (p.dead) return;
    p.dead = true;
    if (p.col) this.colliderToPart.delete(p.col.handle);
    this.world.removeRigidBody(p.body);
    const i = this.parts.indexOf(p); if (i >= 0) this.parts.splice(i, 1);
    this.onRemove(p);
  }

  step() {
    if (this.phase !== 'collapsing') return;
    for (let i = 0; i < this.opts.substeps; i++) { this.world.step(this.events); this._processContacts(); }
    this._processSnaps();
  }

  _processContacts() {
    const o = this.opts;
    this.events.drainContactForceEvents((e) => {
      const mag = e.maxForceMagnitude();
      if (mag > this.stats.maxForce) this.stats.maxForce = mag;
      const p = this.colliderToPart.get(e.collider1()) || this.colliderToPart.get(e.collider2());
      if (!p || p.dead) return;
      if ((p.kind === 'beam' || p.kind === 'column') && p.member && mag > o.beamSnapForce) this._snapMember(p.member);
      else if (p.kind === 'slab' && mag > o.slabCrackForce) this._crackTilesOf(p);
    });
  }

  // a hard impact on a tile cracks the concrete at ONE seam: that rigid tie -> rebar hinge.
  // Sparse cracks (one per hard hit) leave large multi-tile pieces connected at the cracks.
  _crackTilesOf(tile) {
    const rec = this.joints.find((r) => r.type === 'tie' && !r.cracked && !r.broken && (r.a === tile || r.b === tile));
    if (rec) this._crackTie(rec);
  }

  _processSnaps() {
    const o = this.opts;
    for (const rec of this.joints) {
      if (rec.broken || rec.a.dead || rec.b.dead || rec.type === 'rebar') continue;
      if (rec.type === 'member' && rec.member.breaks >= o.maxBreaksPerMember) continue;
      const ang = relAngle(rec.a.body.rotation(), rec.b.body.rotation());
      if (ang > this.stats.maxBend) this.stats.maxBend = ang;
      if (rec.type === 'tie') {
        // ties crack on impact (see _crackTilesOf); once hinged, extreme folding tears the rebar
        if (rec.cracked && ang > o.slabTearAngle) this._breakJoint(rec);
      } else if (ang > rec.breakAngle) {
        this._breakJoint(rec);
      }
    }
  }

  _snapMember(member) {
    if (member.breaks >= this.opts.maxBreaksPerMember) return;
    const rec = member.joints.find((j) => !j.broken && j.type === 'member');
    if (rec) this._breakJoint(rec);
  }

  _breakJoint(rec) {
    if (rec.broken) return;
    rec.broken = true;
    this.world.removeImpulseJoint(rec.joint, true);
    if (rec.type === 'member') { rec.member.breaks++; this.stats.snaps++; }
    else this.stats.tears++;
  }

  freeze() {
    if (this.phase === 'frozen') return;
    const R = this.R;
    for (const p of [...this.parts]) {
      if (p.dead) continue;
      if (p.body.translation().y < -0.5) this._removePart(p);
      else p.body.setBodyType(R.RigidBodyType.Fixed, true);
    }
    this.phase = 'frozen';
  }

  // ray-march vertical lines; enclosed empty gaps (solid above) are internal voids
  detectVoids() {
    const R = this.R, o = this.opts;
    let top = 0; for (const p of this.parts) top = Math.max(top, p.body.translation().y); top += 0.5;
    const probe = new R.Ball(0.06), rot = { x: 0, y: 0, z: 0, w: 1 };
    const isSolid = (x, y, z) => this.world.intersectionWithShape({ x, y, z }, rot, probe) !== null;
    const ext = o.buildingSize / 2 + 1.5, n = o.voidGrid, cell = (ext * 2) / n, yStep = 0.15, cand = [];
    for (let ix = 0; ix < n; ix++) for (let iz = 0; iz < n; iz++) {
      const x = -ext + cell * (ix + 0.5), z = -ext + cell * (iz + 0.5), occ = [];
      for (let y = 0.1; y <= top; y += yStep) occ.push([y, isSolid(x, y, z)]);
      let topSolid = -1; for (let k = occ.length - 1; k >= 0; k--) if (occ[k][1]) { topSolid = occ[k][0]; break; }
      if (topSolid < 0) continue;
      let k = 0;
      while (k < occ.length) {
        if (!occ[k][1]) { let j = k; while (j < occ.length && !occ[j][1]) j++;
          const y0 = occ[k][0], y1 = occ[j - 1][0], h = y1 - y0 + yStep;
          if (y1 < topSolid - 1e-3 && h >= o.minVoidHeight) cand.push({ x, y: (y0 + y1) / 2, z, h });
          k = j; } else k++;
      }
    }
    cand.sort((a, b) => b.h - a.h);
    const kept = [], md = cell * 0.9;
    for (const c of cand) {
      if (kept.some((v) => Math.hypot(v.x - c.x, v.z - c.z) < md && Math.abs(v.y - c.y) < c.h)) continue;
      kept.push({ x: c.x, y: c.y, z: c.z, height: c.h, radius: Math.min(c.h, cell) / 2 });
    }
    this.voids = kept;
    return kept;
  }
}
