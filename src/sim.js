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
//   - Beams are reinforced concrete too; they snap and get buried under the pancaking slabs.
//   - Heavy densities, low restitution, damping => a building collapse, not bouncy blocks.
//
// UNITS: length m, mass tonnes (Mg), time s  =>  force kN, stress kPa, E in kPa. Gravity is
// real (9.81); heaviness comes from restitution/damping/mass. Keeping real units is what lets
// src/structure.js evaluate genuine code checks (tributary load, crush, Euler buckling) in kN.
//
// The renderer supplies onAdd/onRemove callbacks to mirror parts as meshes. Each part
// carries a box `shape` {hx,hy,hz} and a `matKind` so the renderer knows what to draw.

import { makeRng } from './rng.js';
import { FrameModel, DebrisSupport } from './structure.js';
import { RescueOps } from './rescue.js';

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
  rebarThickness: 0.008,   // rebar rod RADIUS (~0.6 in dia) — thin
  rebarSpacing: 0.2,       // slab rebar grid spacing (m) — dense
  rebarFray: 0.05,         // how far cut rod ends protrude ("frayed ends") at holes/edges
  // physics — UNITS: length m, mass tonnes (Mg), time s  =>  force kN, stress kPa.
  // (Real g; the "heavy, non-bouncy" feel comes from restitution/damping/mass, not fake gravity.)
  gravity: 9.81,
  restitution: 0.10,       // concrete-on-concrete: dead thud, not a bounce
  friction: 0.9,
  linearDamping: 0.08,
  angularDamping: 0.30,
  densityConcrete: 2.4,    // Mg/m³ — plain concrete
  densityMember: 2.5,      // Mg/m³ — reinforced concrete (columns/beams: concrete + rebar)
  densitySteel: 7.85,      // Mg/m³ — steel (rebar area in the capacity checks)
  substeps: 3,
  // failure
  // Impact triggers are a NUMERICAL PROXY, not a code check: a rigid-body solver's peak contact
  // force over one dt is far spikier than a sustained flexural load, so these are calibrated off
  // the measured distribution (`node measure.mjs`) to reproduce SPARSE cracking — the top ~0.5%
  // of impacts. The dimensionally-meaningful capacity checks (cracking moment, crush, Euler
  // buckling) act on static tributary loads in src/structure.js.
  contactEventThreshold: 10,   // kN — below this is solver noise (p50 ≈ 1.5–4 kN)
  beamSnapForce: 1150,     // kN impact that snaps a member joint (≈5× p99 of member contacts)
  // Rigid-body members barely bend (measured max 0.9° at real g — see DEVLOG iter 4), so this is
  // a near-inert backstop for extreme kinks, NOT the main member-failure path. Real member
  // failure is beamSnapForce plus the axial crush/buckling check in src/structure.js.
  beamSnapAngle: 0.012,    // bend angle (rad) that snaps a member joint
  slabCrackForce: 1400,    // kN impact cracks one concrete seam -> rebar hinge (sparse = large pieces)
  slabTearAngle: 0.9,      // fold where the REBAR itself tears — p99.9 of measured hinge folds,
                           // so full separation stays RARE and panels remain coherent
  maxBreaksPerMember: 1,   // members snap into at most 2 pieces (never shatter)
  wakeRadius: 3.0,         // radius of pieces re-woken to re-settle after an equipment cut
  maxParts: 2500,
  // ---- structural evaluation (src/structure.js) — real code-level values ----
  concreteE: 25e6,         // kPa (25 GPa) — Young's modulus, normal-weight concrete
  concreteFc: 25e3,        // kPa (25 MPa) — characteristic cylinder strength f'c
  steelFy: 415e3,          // kPa (415 MPa) — rebar yield strength
  deadLoadSuper: 1.5,      // kPa — superimposed dead load (finishes, partitions, services)
  liveLoadFloor: 2.0,      // kPa — occupancy live load
  rescuerLoad: 1.2,        // kN — one rescuer + kit as a point live load
  // The stylized geometry (0.4 m columns on a 2 m grid) is ~20x over-designed for 4 storeys, so
  // raw geometric capacity would make buckling unreachable. Capacity is therefore sized to
  // designSafetyFactor x intact service demand, which is how real frames are proportioned.
  // Set 0 to use the raw geometric section instead.
  designSafetyFactor: 1.8,
  endFixityIntact: 0.5,    // Euler K — both ends restrained by floor framing
  endFixityPinned: 1.0,    // Euler K — framing at one end cracked/severed
  endFixityFree: 2.0,      // Euler K — top unrestrained (slab above gone) = cantilever
  failureProfile: 'softStory',  // 'softStory' | 'pancake' | 'progressive'
  spallOnCut: 0.35,        // fraction of a column's section lost when a tool cuts into it
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
export const relAngle = (qa, qb) => {
  const r = qMul(qConj(qa), qb);
  return 2 * Math.acos(Math.min(1, Math.abs(r.w)));
};
// Clip a slab's rebar rods against a rectangular hole (tile-local). Rods that cross the hole
// are split into pieces that stop at the hole edge, extended by `fray` so the cut ends stick
// slightly into the opening (frayed rebar). Rods that miss the hole pass through unchanged.
const clipRebarForHole = (rebars, cx, cz, rx, rz, fray) => {
  if (!rebars) return null;
  const out = [];
  for (const d of rebars) {
    if (d.axis === 'x') {
      if (Math.abs(d.z - cz) > rz) { out.push(d); continue; }
      const x0 = d.x - d.len / 2, x1 = d.x + d.len / 2, hL = cx - rx + fray, hR = cx + rx - fray;
      if (hL > x0) out.push({ ...d, x: (x0 + hL) / 2, len: hL - x0 });
      if (x1 > hR) out.push({ ...d, x: (hR + x1) / 2, len: x1 - hR });
    } else if (d.axis === 'z') {
      if (Math.abs(d.x - cx) > rx) { out.push(d); continue; }
      const z0 = d.z - d.len / 2, z1 = d.z + d.len / 2, hL = cz - rz + fray, hR = cz + rz - fray;
      if (hL > z0) out.push({ ...d, z: (z0 + hL) / 2, len: hL - z0 });
      if (z1 > hR) out.push({ ...d, z: (hR + z1) / 2, len: z1 - hR });
    } else out.push(d);
  }
  return out;
};

// Clip a slab's rebar rods against a STRAIGHT cut at `axis = at`, keeping the rods on `side`
// (-1 = below the cut, +1 = above). Rods running along the cut axis are severed and their cut end
// protrudes by `fray`; rods running across it are kept whole or dropped depending on which side
// they sit. `recentre` shifts the survivors into the new body's local frame (0 = same origin).
const clipRebarForSlice = (rebars, axis, at, side, fray, recentre) => {
  if (!rebars) return null;
  const out = [];
  for (const d of rebars) {
    if (d.axis === axis) {
      // rod runs across the cut -> sever it, keeping the piece on `side`, with the cut end
      // protruding `fray` past the cut line so it reads as frayed rebar
      const c = d[axis], lo = c - d.len / 2, hi = c + d.len / 2;
      const start = side < 0 ? lo : Math.max(lo, at - fray);
      const end = side < 0 ? Math.min(hi, at + fray) : hi;
      const len = end - start;
      if (len > 0.02) out.push({ ...d, [axis]: (start + end) / 2 - recentre, len });
    } else {
      // rod runs parallel to the cut -> keep it only if it lies on `side`
      const pos = d[axis];
      if (side < 0 ? pos <= at : pos >= at) out.push({ ...d, [axis]: pos - recentre });
    }
  }
  return out;
};

// rotate a vector by a unit quaternion
const rotateVec = (q, v) => {
  const tx = 2 * (q.y * v.z - q.z * v.y), ty = 2 * (q.z * v.x - q.x * v.z), tz = 2 * (q.x * v.y - q.y * v.x);
  return {
    x: v.x + q.w * tx + (q.y * tz - q.z * ty),
    y: v.y + q.w * ty + (q.z * tx - q.x * tz),
    z: v.z + q.w * tz + (q.x * ty - q.y * tx),
  };
};

export class RubbleSim {
  constructor(RAPIER, opts = {}, callbacks = {}) {
    this.R = RAPIER;
    this.opts = { ...DEFAULTS, ...opts };
    this.onAdd = callbacks.onAdd || (() => {});
    this.onRemove = callbacks.onRemove || (() => {});
    this.onReshape = callbacks.onReshape || (() => {}); // renderer rebuilds a part's mesh after a hole is cut
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
    this.floors = [];        // per storey: {story, tiles[i][j], slabY, tileHalf}
    this.joints = [];        // records: {joint, a, b, type:'member'|'tie', breakAngle, member?, broken}
    this.colliderToPart = new Map();
    this.rng = makeRng(this.opts.seed);
    this.stats = { snaps: 0, cracks: 0, tears: 0, cuts: 0, maxForce: 0, maxBend: 0 };
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
    const part = { body, col, colliders: [col], shape, matKind, kind: matKind, fixed, member, rebars };
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

  // concrete cracks: replace a rigid weld with a revolute HINGE along `hingeAxis`, so the
  // pieces fold but stay connected by "rebar" (removed only if later torn/cut through).
  _crackJoint(rec, hingeAxis) {
    if (rec.cracked || rec.broken) return;
    this.world.removeImpulseJoint(rec.joint, true);
    const jd = this.R.JointData.revolute(rec.anchorA, rec.anchorB, hingeAxis);
    rec.joint = this.world.createImpulseJoint(jd, rec.a.body, rec.b.body, true);
    rec.hingeAxis = hingeAxis;
    rec.cracked = true;
    this.stats.cracks++;
  }

  _crackTie(rec) { this._crackJoint(rec, rec.hingeAxis); }

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
    // 4 thin longitudinal rebar rods at the corners, running the segment length.
    const segRebars = () => {
      if (!withRebar) return null;
      const bars = [];
      for (const [s1, s2] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
        const d = { x: 0, y: 0, z: 0, len: seg * 1.15, r: th, axis };
        d[crossAxes[0]] = s1 * cross * 0.5;
        d[crossAxes[1]] = s2 * cross * 0.5;
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
      // Columns are tagged with their storey + grid cell so src/structure.js can build the
      // tributary load path (which column carries which floor area, and what sits above it).
      for (let i = 0; i < g; i++) for (let j = 0; j < g; j++) {
        const m = this._member('column', { x: lines[i], y: base, z: lines[j] },
          { x: lines[i], y: topY, z: lines[j] }, o.columnSize, o.colSegments, o.densityMember, true);
        m.story = s; m.gi = i; m.gj = j; m.x = lines[i]; m.z = lines[j];
      }
      const lo = lines[0], hi = lines[g - 1];
      for (const z of [lo, hi]) { const m = this._member('beam', { x: lo, y: topY, z }, { x: hi, y: topY, z }, o.beamSize, o.beamSegments, o.densityMember, true); m.story = s; }
      for (const x of [lo, hi]) { const m = this._member('beam', { x, y: topY, z: lo }, { x, y: topY, z: hi }, o.beamSize, o.beamSegments, o.densityMember, true); m.story = s; }

      // floor = grid of concrete tiles tied edge-to-edge by rebar (a coherent panel)
      const slabY = topY + o.beamSize / 2 + st / 2;
      const tiles = [];
      for (let i = 0; i < g; i++) {
        tiles[i] = [];
        for (let j = 0; j < g; j++) {
          // reinforcement skeleton: a dense grid of thin cylindrical rods EMBEDDED at the
          // slab's mid-plane (hidden in intact concrete; exposed as frayed ends at breaks/cuts).
          // Rods run slightly past the tile so their ends protrude at fractures/edges.
          const tileRebars = [];
          const n = Math.max(2, Math.round((tileHalf * 2) / o.rebarSpacing));
          const len = tileHalf * 2 + 2 * o.rebarFray;
          for (let k = 0; k <= n; k++) {
            const u = -tileHalf + (tileHalf * 2) * (k / n);
            tileRebars.push({ x: 0, y: 0, z: u, len, r: th, axis: 'x' });
            tileRebars.push({ x: u, y: 0, z: 0, len, r: th, axis: 'z' });
          }
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

      // record the floor so the structural model knows what load each storey carries, and so
      // tools can find the slab above a given column
      this.floors.push({ story: s, tiles, slabY, tileHalf });

      for (let f = 0; f < o.furniturePerFloor; f++) {
        const fw = this.rng.float(0.35, 0.6), fh = this.rng.float(0.4, 0.9), fd = this.rng.float(0.35, 0.6);
        this._addBox({ hx: fw, hy: fh, hz: fd },
          { x: this.rng.float(-B / 2 + fw, B / 2 - fw), y: (s === 0 ? 0 : base + st) + fh, z: this.rng.float(-B / 2 + fd, B / 2 - fd) },
          null, 'furniture', { fixed: true, density: o.densityConcrete });
      }
    }
    // structural evaluation layer over the finished frame (specs.md §2)
    this.frame = new FrameModel(this);
    this.frame.build();
    this.support = new DebrisSupport(this);
    this.rescue = new RescueOps(this);

    this.phase = 'standing';
    return this.parts.length;
  }

  /**
   * Initiate the collapse via a real failure mechanism (specs.md §2A) rather than deleting
   * columns at random. Each profile applies an INITIATING DAMAGE, then the structural model
   * decides what actually fails: over-utilised columns are found by capacity check, their load
   * redistributes to neighbours, and the cascade repeats. So which columns go, and in what
   * order, is an outcome of the load path — not a coin flip.
   *
   *   softStory   — ground-storey columns are gutted (vehicle impact / blast / weak first floor);
   *                 they buckle under the whole upper-tier weight.
   *   pancake     — an interior column line is lost mid-height, so floors lose support and stack.
   *   progressive — ONE column is destroyed; everything after that is pure redistribution, which
   *                 may or may not take the building down.
   */
  collapse() {
    if (this.phase === 'collapsing' || this.phase === 'frozen') return;
    const R = this.R, o = this.opts, frame = this.frame;
    const profile = o.failureProfile || 'softStory';
    this.collapseReport = { profile, initiators: [], cascade: 0 };

    if (frame) {
      const mid = Math.max(0, Math.min(o.stories - 1, Math.floor(o.stories / 2)));
      const initiate = (nodes, spall, fixity) => {
        for (const c of nodes) {
          frame.damageColumn(c, spall);
          if (fixity) frame.degradeFixity(c, fixity);
          this.collapseReport.initiators.push(`storey ${c.story} col (${c.gi},${c.gj})`);
        }
      };
      if (profile === 'softStory') {
        // gut the ground storey: heavy section loss + the top framing gone (K -> free) so the
        // Euler capacity of the remaining stubs collapses quadratically
        initiate(frame.columnsOfStory(0), 0.92, 'free');
      } else if (profile === 'pancake') {
        // A pancake needs vertical support lost across a whole LEVEL, so the floor above drops
        // flat onto the floor below and they stack. Gutting only the interior columns is not
        // enough (on a 3x3 grid that is a single column, which barely moves anything).
        initiate(frame.columnsOfStory(mid), 0.95, 'free');
      } else {
        // a single destroyed column; the cascade is entirely load redistribution
        const one = frame.columnsOfStory(0)[0];
        if (one) initiate([one], 0.98, 'free');
      }

      // Cascade: capacity checks decide the rest. Every column the model fails is physically
      // removed, which is what actually drops the loads above it.
      const failures = frame.evaluate();
      this.collapseReport.cascade = failures.length;
      this.collapseReport.log = frame.log.slice(-24);
      for (const c of failures) {
        if (c.member.removed) continue;
        for (const s of c.member.segments) this._removePart(s);
        c.member.removed = true;
      }
      // Columns the model kept but which now carry no floor above (orphaned storeys) are still
      // standing; leave them — a partially standing frame over a rubble pile is the realistic
      // and more interesting outcome for void formation.
      this.collapseReport.standing = frame.report().standing;
    }

    for (const p of [...this.parts]) {
      if (p.dead) continue;
      p.body.setBodyType(R.RigidBodyType.Dynamic, true); p.body.wakeUp(); p.fixed = false;
      p.body.setLinvel({ x: this.rng.float(-0.5, 0.5), y: 0, z: this.rng.float(-0.5, 0.5) }, true);
    }
    this.phase = 'collapsing';
  }

  _removePart(p) {
    if (p.dead) return;
    p.dead = true;
    for (const c of (p.colliders || [])) this.colliderToPart.delete(c.handle);
    this.world.removeRigidBody(p.body);
    const i = this.parts.indexOf(p); if (i >= 0) this.parts.splice(i, 1);
    this.onRemove(p);
  }

  step() {
    if (this.phase !== 'collapsing') return;
    for (let i = 0; i < this.opts.substeps; i++) {
      // Rapier clears the force accumulator on every step, so lifting-bag forces must be
      // re-applied per SUBSTEP — doing it once per frame would apply only 1/substeps of the lift.
      if (this.rescue) this.rescue.applyForces();
      this.world.step(this.events);
      this._processContacts();
    }
    this._processSnaps();
    if (this.rescue) this.rescue.postStep();
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

  /**
   * Settle the pile.
   *
   * By default this is a SOFT freeze: bodies stay Dynamic and are put to SLEEP. Sleeping bodies
   * cost almost nothing to simulate but keep their contact manifolds and normal impulses alive,
   * so the settled rubble still has real load paths that DebrisSupport / the stress map / lifting
   * bags / shoring can read. Converting everything to Fixed — which this used to do — zeroes
   * every contact force and makes the settled pile kinematically fake: no weight bears on
   * anything, so "how much is on top of this slab?" has no answer.
   *
   * Pass {hard:true} for a genuinely immovable pile.
   */
  freeze({ hard = false } = {}) {
    if (this.phase === 'frozen') return;
    const R = this.R;
    const zero = { x: 0, y: 0, z: 0 };
    for (const p of [...this.parts]) {
      if (p.dead) continue;
      if (p.body.translation().y < -0.5) { this._removePart(p); continue; }
      if (hard) { p.body.setBodyType(R.RigidBodyType.Fixed, true); p.fixed = true; }
      else {
        p.body.setLinvel(zero, false);
        p.body.setAngvel(zero, false);
        p.body.sleep();
      }
    }
    this.hardFrozen = hard;
    this.phase = 'frozen';
    if (this.support && !hard) this.support.rebuild();
  }

  // Plane cut used by equipment. mode 'concrete' cracks rigid CONCRETE joints (slab ties + RC
  // column welds) into rebar hinges (pieces fold but stay attached; steel beams untouched).
  // mode 'rebar' fully BREAKS every joint crossing the plane (ties, hinges, steel members) —
  // the rebar/steel cutter that frees pieces so they drop. Then re-wake the local region so
  // gravity re-settles it. Returns {severed, woken, points}.
  cut(point, normal, radius, opts = {}) {
    const R = this.R;
    const mode = opts.mode || 'concrete';
    const wake = Math.max(radius, opts.wakeRadius ?? this.opts.wakeRadius);
    const nl = Math.hypot(normal.x, normal.y, normal.z) || 1;
    const n = { x: normal.x / nl, y: normal.y / nl, z: normal.z / nl };
    const side = (p) => (p.x - point.x) * n.x + (p.y - point.y) * n.y + (p.z - point.z) * n.z;
    const dist = (p) => Math.hypot(p.x - point.x, p.y - point.y, p.z - point.z);

    let severed = 0;
    const points = [];                                     // world positions of cut joints (UI feedback)
    for (const rec of this.joints) {
      if (rec.broken || rec.a.dead || rec.b.dead) continue;
      if (mode === 'concrete') {
        if (rec.cracked) continue;
        const isConcrete = rec.type === 'tie' || (rec.type === 'member' && rec.member && rec.member.kind === 'column');
        if (!isConcrete) continue;
      } else if (rec.type !== 'tie' && rec.type !== 'member') continue; // rebar: any structural joint
      const pa = rec.a.body.translation(), pb = rec.b.body.translation();
      const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2, z: (pa.z + pb.z) / 2 };
      if (dist(mid) > radius) continue;
      const sa = side(pa), sb = side(pb);
      if (sa > 0 === sb > 0) continue;                     // must straddle the cut plane
      if (mode === 'concrete') {
        let axis = rec.hingeAxis;
        if (rec.type === 'member') {                        // column fold axis in the cut plane
          const ax = { x: pb.x - pa.x, y: pb.y - pa.y, z: pb.z - pa.z };
          const hx = ax.y * n.z - ax.z * n.y, hy = ax.z * n.x - ax.x * n.z, hz = ax.x * n.y - ax.y * n.x;
          const hl = Math.hypot(hx, hy, hz);
          axis = hl > 1e-6 ? { x: hx / hl, y: hy / hl, z: hz / hl } : { x: 1, y: 0, z: 0 };
        }
        this._crackJoint(rec, axis);
      } else {
        this._breakJoint(rec);
      }
      points.push(mid);
      severed++;
    }

    let woken = 0;
    for (const p of this.parts) {
      if (p.dead) continue;
      if (dist(p.body.translation()) <= wake) {
        p.body.setBodyType(R.RigidBodyType.Dynamic, true); p.body.wakeUp();
        p.fixed = false;
        woken++;
      }
    }
    if (severed > 0 || woken > 0) { this.stats.cuts++; this.phase = 'collapsing'; }
    return { severed, woken, points };
  }

  // Exposed rebar = a cracked tie hinge (the rebar bridging a fracture between two slab
  // pieces). Return the nearest one to `point` within `reach`, or null.
  exposedRebarNear(point, reach) {
    let best = null, bd = reach * reach;
    for (const rec of this.joints) {
      if (rec.type !== 'tie' || !rec.cracked || rec.broken || rec.a.dead || rec.b.dead) continue;
      // the fracture/rebar sits at the shared seam = tile A centre + its anchor, in world space
      const t = rec.a.body.translation(), o = rotateVec(rec.a.body.rotation(), rec.anchorA);
      const x = t.x + o.x, y = t.y + o.y, z = t.z + o.z;
      const d2 = (x - point.x) ** 2 + (y - point.y) ** 2 + (z - point.z) ** 2;
      if (d2 <= bd) { bd = d2; best = { rec, x, y, z }; }
    }
    return best;
  }

  // Hydraulic rebar cutter: snip the exposed rebar nearest `point` — breaks that hinge so the
  // two slab pieces separate — then wake the local region so they shift. Returns {severed,points,woken}.
  cutRebar(point, reach) {
    const near = this.exposedRebarNear(point, reach);
    if (!near) return { severed: 0, points: [], woken: 0 };
    this._breakJoint(near.rec);
    const R = this.R, wake = Math.max(reach * 3, 1.5);
    let woken = 0;
    for (const p of this.parts) {
      if (p.dead) continue;
      const t = p.body.translation();
      if (Math.hypot(t.x - near.x, t.y - near.y, t.z - near.z) <= wake) {
        p.body.setBodyType(R.RigidBodyType.Dynamic, true); p.body.wakeUp(); p.fixed = false; woken++;
      }
    }
    this.stats.cuts++; this.phase = 'collapsing';
    return { severed: 1, points: [{ x: near.x, y: near.y, z: near.z }], woken };
  }

  // ---- momentum-preserving severing (specs.md §3.1.3) ---------------------

  /**
   * Give a newly spawned fragment the motion it should already have. A point of a rigid body
   * moves at v + ω × r, so a fragment must inherit the parent's spin AND the linear velocity of
   * its own centroid — not just the parent's centre-of-mass velocity. Without this, pieces
   * severed out of falling debris stop dead in mid-air, which reads as obviously fake.
   */
  _inheritMomentum(parentBody, childBody, worldPos) {
    const v = parentBody.linvel(), w = parentBody.angvel(), t = parentBody.translation();
    const r = { x: worldPos.x - t.x, y: worldPos.y - t.y, z: worldPos.z - t.z };
    childBody.setLinvel({
      x: v.x + (w.y * r.z - w.z * r.y),
      y: v.y + (w.z * r.x - w.x * r.z),
      z: v.z + (w.x * r.y - w.y * r.x),
    }, true);
    childBody.setAngvel({ x: w.x, y: w.y, z: w.z }, true);
  }

  /** Wake every live part within `radius` of a world point. Returns the count. */
  _wakeNear(point, radius) {
    const R = this.R;
    let woken = 0;
    for (const p of this.parts) {
      if (p.dead) continue;
      // Never wake shoring: a shore that gets converted to a falling body is not shoring. It
      // stays Fixed until it is overloaded, which is RescueOps.measureShores's call to make.
      if (p.shore) continue;
      const t = p.body.translation();
      if (Math.hypot(t.x - point.x, t.y - point.y, t.z - point.z) <= radius) {
        p.body.setBodyType(R.RigidBodyType.Dynamic, true); p.body.wakeUp(); p.fixed = false; woken++;
      }
    }
    return woken;
  }

  /**
   * Re-point one end of an existing joint onto a different body, preserving the record's state
   * (a cracked hinge stays a hinge). `delta` is the shift from the old body's origin to the new
   * one's, in the shared local frame, so the anchor keeps pointing at the same physical seam.
   */
  _movePartInJoint(rec, from, to, delta) {
    const id = { x: 0, y: 0, z: 0, w: 1 };
    this.world.removeImpulseJoint(rec.joint, true);
    const shift = (a) => ({ x: a.x - delta.x, y: a.y - delta.y, z: a.z - delta.z });
    if (rec.a === from) { rec.a = to; rec.anchorA = shift(rec.anchorA); }
    else { rec.b = to; rec.anchorB = shift(rec.anchorB); }
    const jd = rec.cracked && rec.hingeAxis
      ? this.R.JointData.revolute(rec.anchorA, rec.anchorB, rec.hingeAxis)
      : this.R.JointData.fixed(rec.anchorA, id, rec.anchorB, id);
    rec.joint = this.world.createImpulseJoint(jd, rec.a.body, rec.b.body, true);
  }

  /**
   * Cutting torch / saw — specs.md §3.1.2 verbatim: find the structural joint intersecting the
   * cut and remove it with `world.removeImpulseJoint`. Unlike the hydraulic pliers (which only
   * reach rebar ALREADY exposed at a fracture), a torch cuts any joint within reach, including
   * still-embedded slab ties and member welds. Returns {severed, points, woken}.
   */
  cutJointNear(point, reach, { types = ['tie', 'member'] } = {}) {
    let best = null, bd = reach * reach;
    for (const rec of this.joints) {
      if (rec.broken || rec.a.dead || rec.b.dead) continue;
      if (!types.includes(rec.type)) continue;
      const pa = rec.a.body.translation(), pb = rec.b.body.translation();
      const mid = { x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2, z: (pa.z + pb.z) / 2 };
      const d2 = (mid.x - point.x) ** 2 + (mid.y - point.y) ** 2 + (mid.z - point.z) ** 2;
      if (d2 <= bd) { bd = d2; best = { rec, ...mid }; }
    }
    if (!best) return { severed: 0, points: [], woken: 0 };
    this._breakJoint(best.rec);
    const woken = this._wakeNear(best, Math.max(reach * 3, 1.5));
    this.stats.cuts++;
    this.phase = 'collapsing';
    return { severed: 1, points: [{ x: best.x, y: best.y, z: best.z }], woken };
  }

  /**
   * Breaching hammer: spall the concrete at a point. Physically this removes section rather than
   * severing anything, so its real consequence is structural, not visual — a spalled column has
   * less area AND (because I ∝ A² for a square section) far less buckling capacity, which the
   * FrameModel picks up on its next evaluation. It also cracks the nearest seam, exposing rebar
   * for the pliers. Returns {spalled, exposed, part}.
   */
  spallAt(point, radius) {
    let target = null, bd = radius * radius;
    for (const p of this.parts) {
      if (p.dead) continue;
      const t = p.body.translation();
      const d2 = (t.x - point.x) ** 2 + (t.y - point.y) ** 2 + (t.z - point.z) ** 2;
      if (d2 <= bd) { bd = d2; target = p; }
    }
    if (!target) return { spalled: false, exposed: false, part: null };
    let spalled = false;
    if (this.frame && target.member && target.member.kind === 'column') {
      const node = this.frame.nodeForMember(target.member);
      if (node) {
        this.frame.damageColumn(node, this.opts.spallOnCut);
        this.frame.degradeFixity(node, 'pinned');
        spalled = true;
      }
    }
    // expose rebar at the nearest intact seam so the crew has something to cut
    const rec = this.joints.find((r) => r.type === 'tie' && !r.cracked && !r.broken &&
      !r.a.dead && !r.b.dead && (r.a === target || r.b === target));
    if (rec) this._crackTie(rec);
    this._wakeNear(point, this.opts.wakeRadius);
    this.stats.cuts++;
    this.phase = 'collapsing';
    return { spalled, exposed: !!rec, part: target };
  }

  /**
   * Slice a slab tile clean through along a local axis, splitting ONE rigid body into TWO
   * (specs.md §3.1.3, "split the parent rigid body into distinct child bodies, copying over the
   * existing linearVelocity and angularVelocity").
   *
   * The LARGER piece keeps the original body, so its rebar ties survive untouched; the smaller is
   * spawned as a new body inheriting the parent's momentum. Ties anchored on the spawned side are
   * re-pointed onto the new body, so the panel keeps the right reinforcement topology instead of
   * silently dropping a tie. `axis` is 'x' or 'z' and `at` is the cut position in tile-local
   * coordinates. Returns {kept, spawned} or null if the cut is not feasible.
   */
  sliceSlab(slab, axis = 'x', at = 0) {
    if (!slab || slab.dead || slab.frame) return null;      // already holed: geometry too complex
    const o = this.opts, s = slab.shape, R = this.R;
    const half = axis === 'x' ? s.hx : s.hz;
    const minPiece = 0.08;
    if (at <= -half + minPiece || at >= half - minPiece) return null;

    const rebars0 = slab.rebars;                            // capture BEFORE clipping the kept side
    const loLen = at + half, hiLen = half - at;             // extents either side of the cut
    const keepLow = loLen >= hiLen;                         // keep the larger side on this body
    const keepLen = keepLow ? loLen : hiLen, dropLen = keepLow ? hiLen : loLen;
    const keepCentre = keepLow ? at - keepLen / 2 : at + keepLen / 2;
    const dropCentre = keepLow ? at + dropLen / 2 : at - dropLen / 2;

    // 1. shrink the kept side: same body/origin (ties keep their anchors), offset collider
    const box = { hx: s.hx, hy: s.hy, hz: s.hz, x: 0, y: 0, z: 0 };
    if (axis === 'x') { box.hx = keepLen / 2; box.x = keepCentre; } else { box.hz = keepLen / 2; box.z = keepCentre; }
    for (const c of slab.colliders) { this.colliderToPart.delete(c.handle); this.world.removeCollider(c, true); }
    slab.colliders = [];
    const cd = R.ColliderDesc.cuboid(box.hx, box.hy, box.hz).setTranslation(box.x, box.y, box.z)
      .setRestitution(o.restitution).setFriction(o.friction).setDensity(o.densityConcrete);
    const kc = this.world.createCollider(cd, slab.body);
    slab.colliders.push(kc);
    this.colliderToPart.set(kc.handle, slab);
    slab.col = kc;
    slab.frame = [box];                                     // renderer rebuilds from this
    slab.rebars = clipRebarForSlice(rebars0, axis, at, keepLow ? -1 : 1, o.rebarFray, 0);
    this.onReshape(slab);

    // 2. spawn the smaller side as its own body at the world position of its centroid
    const localOff = { x: 0, y: 0, z: 0 }; localOff[axis] = dropCentre;
    const t = slab.body.translation(), q = slab.body.rotation();
    const woff = rotateVec(q, localOff);
    const wpos = { x: t.x + woff.x, y: t.y + woff.y, z: t.z + woff.z };
    const dropShape = { hx: s.hx, hy: s.hy, hz: s.hz };
    if (axis === 'x') dropShape.hx = dropLen / 2; else dropShape.hz = dropLen / 2;
    const spawned = this._addBox(dropShape, wpos, q, 'slab',
      { fixed: false, density: o.densityConcrete, events: true,
        rebars: clipRebarForSlice(rebars0, axis, at, keepLow ? 1 : -1, o.rebarFray, dropCentre) });
    if (!spawned) return { kept: slab, spawned: null };
    this._inheritMomentum(slab.body, spawned.body, wpos);

    // 3. hand over any tie anchored on the side that just became a separate body
    const delta = { x: 0, y: 0, z: 0 }; delta[axis] = dropCentre;
    for (const rec of [...this.joints]) {
      if (rec.broken || rec.type !== 'tie') continue;
      const isA = rec.a === slab, isB = rec.b === slab;
      if (!isA && !isB) continue;
      const anchor = isA ? rec.anchorA : rec.anchorB;
      const onDropSide = keepLow ? anchor[axis] > at : anchor[axis] < at;
      if (onDropSide) this._movePartInJoint(rec, slab, spawned, delta);
    }

    this.stats.cuts++;
    this.phase = 'collapsing';
    this._wakeNear(wpos, o.wakeRadius);
    return { kept: slab, spawned };
  }

  // Concrete cutter: a completed square cut removes a plug from a slab tile, leaving a hole.
  // The tile keeps its rigid body (and all its rebar ties) — we just swap its single box
  // collider for a 4-box FRAME around the hole, and spawn the cut-out plug as a falling piece.
  // holeCx/holeCz = hole centre in the tile's LOCAL frame; rx/rz = hole half-sizes.
  cutHoleInSlab(slab, holeCx, holeCz, rx, rz) {
    if (!slab || slab.dead || slab.frame) return null;
    const R = this.R, o = this.opts, s = slab.shape;
    const m = 0.06;                                        // keep a minimum frame border
    rx = Math.min(rx, s.hx - m); rz = Math.min(rz, s.hz - m);
    holeCx = Math.max(-s.hx + rx + m, Math.min(s.hx - rx - m, holeCx));
    holeCz = Math.max(-s.hz + rz + m, Math.min(s.hz - rz - m, holeCz));

    // 4 frame boxes (left/right full-depth in Z; front/back only across the hole's X span)
    const frame = [
      { hx: (holeCx - rx + s.hx) / 2, hy: s.hy, hz: s.hz, x: (-s.hx + holeCx - rx) / 2, y: 0, z: 0 },
      { hx: (s.hx - holeCx - rx) / 2, hy: s.hy, hz: s.hz, x: (s.hx + holeCx + rx) / 2, y: 0, z: 0 },
      { hx: rx, hy: s.hy, hz: (holeCz - rz + s.hz) / 2, x: holeCx, y: 0, z: (-s.hz + holeCz - rz) / 2 },
      { hx: rx, hy: s.hy, hz: (s.hz - holeCz - rz) / 2, x: holeCx, y: 0, z: (s.hz + holeCz + rz) / 2 },
    ].filter((b) => b.hx > 0.02 && b.hz > 0.02);

    // swap colliders on the SAME body (joints/ties preserved)
    for (const c of slab.colliders) { this.colliderToPart.delete(c.handle); this.world.removeCollider(c, true); }
    slab.colliders = [];
    for (const b of frame) {
      const cd = R.ColliderDesc.cuboid(b.hx, b.hy, b.hz).setTranslation(b.x, b.y, b.z)
        .setRestitution(o.restitution).setFriction(o.friction).setDensity(o.densityConcrete);
      const c = this.world.createCollider(cd, slab.body);
      slab.colliders.push(c);
      this.colliderToPart.set(c.handle, slab);
    }
    slab.col = slab.colliders[0] || null;
    slab.frame = frame;                                    // renderer rebuilds mesh from this
    // keep the rebar but trim it to the hole -> frayed ends stick into the opening
    slab.rebars = clipRebarForHole(slab.rebars, holeCx, holeCz, rx, rz, this.opts.rebarFray);
    this.onReshape(slab);

    // spawn the plug at the hole location (tile local -> world), a touch smaller than the hole
    // so it isn't wedged against the frame edges, as a falling piece
    const t = slab.body.translation(), q = slab.body.rotation();
    const off = rotateVec(q, { x: holeCx, y: 0, z: holeCz });
    const plug = this._addBox({ hx: rx * 0.9, hy: s.hy * 0.95, hz: rz * 0.9 },
      { x: t.x + off.x, y: t.y + off.y, z: t.z + off.z }, q, 'fragment',
      { fixed: false, density: o.densityConcrete });

    // the plug must leave with the momentum it already had (specs.md §3.1.3) — a plug cut out of
    // a slab that is itself falling or tilting should keep moving with it
    const wc = { x: t.x + off.x, y: t.y + off.y, z: t.z + off.z };
    if (plug) this._inheritMomentum(slab.body, plug.body, wc);

    // wake the local region so the plug and nearby debris re-settle
    this._wakeNear(wc, this.opts.wakeRadius);
    this.stats.cuts++;
    this.phase = 'collapsing';
    return { plug, holeWorld: wc };
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
