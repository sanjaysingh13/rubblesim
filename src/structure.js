// RubbleSim structural engineering layer — framework-agnostic (no three.js / DOM).
// Implements specs.md §2 on top of the rigid-body model in src/sim.js.
//
// UNITS (inherited from sim.js): length m, mass tonnes (Mg), time s
//   => force kN, stress/modulus kPa, area m², second moment m⁴.
// Every number below is a real engineering quantity; nothing is scaled for "feel".
//
// WHY THIS MODULE EXISTS, AND WHY IT IS SEPARATE FROM THE CONTACT PHYSICS
// ----------------------------------------------------------------------
// Rapier gives us contact forces, but a rigid-body solver's peak contact force over one dt is a
// spiky numerical quantity — it is not a sustained flexural or axial load, and thresholds set
// against it are calibration, not engineering (see the note on the impact triggers in sim.js).
// The code checks that civil engineers actually use — tributary load accumulation, axial crush,
// Euler buckling — are STATIC evaluations. They belong here, where loads are in kN and the
// answers mean something.
//
// Two models live here, because a standing frame and a rubble pile are different problems:
//
//   FrameModel   — the INTACT building. Tributary-area load matrix W = ∫(D_L + L_L) dA, per-column
//                  axial crush + Euler buckling capacity, and progressive load redistribution
//                  when a column is lost. Drives collapse initiation and the pancake /
//                  soft-story / progressive failure profiles of specs.md §2A.
//   DebrisSupport — the SETTLED pile. Once the frame is rubble the tributary model is meaningless
//                   (there are no storeys any more), so load paths are read from the actual
//                   contact graph: who rests on whom, and how much weight sits above a point.
//                   This is what lifting bags and shoring need.

// ---------------------------------------------------------------------------
// FrameModel — specs.md §2
// ---------------------------------------------------------------------------
export class FrameModel {
  constructor(sim) {
    this.sim = sim;
    this.opts = sim.opts;
    this.columns = [];      // one node per (storey, grid cell)
    this.byStory = [];      // byStory[s] = column nodes of storey s
    this.liveLoads = [];    // {x, z, story, kN, tag} — rescuers, equipment, lifting bags
    this.orphanedStories = new Set();  // storeys with no surviving column: everything above drops
    this.log = [];          // human-readable evaluation trail, for the HUD / headless tests
  }

  // ---- geometry & load bookkeeping ----------------------------------------

  /**
   * Per-storey load contributions, in kN, for ONE column's tributary area.
   * This is the discrete form of specs.md §2B:  W = ∫_A (D_L + L_L) dA
   * The grid places exactly one slab tile over each column, so the tributary area of every
   * column is the full bay area (spacing²) — no edge/interior special-casing is needed.
   */
  loadMatrix() {
    const o = this.opts, g = o.grid, spacing = o.buildingSize / g;
    const tribArea = spacing * spacing;                                    // m² — A in the integral
    const slabSelf = o.slabThickness * o.densityConcrete * o.gravity;      // kPa — slab dead load
    const dead = (slabSelf + o.deadLoadSuper) * tribArea;                  // kN — D_L · A
    const live = o.liveLoadFloor * tribArea;                               // kN — L_L · A
    // framing self-weight, spread over the columns of the storey
    const beamVol = 4 * spacing * (g - 1) * o.beamSize * o.beamSize;       // m³ of beam per storey
    const beamLoad = (beamVol * o.densityMember * o.gravity) / (g * g);    // kN per column
    const colLoad = o.columnSize ** 2 * o.storyHeight * o.densityMember * o.gravity;  // kN
    return { tribArea, spacing, slabSelf, dead, live, beamLoad, colLoad, perFloor: dead + live + beamLoad };
  }

  build() {
    const o = this.opts;
    this.columns = [];
    this.byStory = Array.from({ length: o.stories }, () => []);
    this.liveLoads = [];
    this.orphanedStories.clear();
    for (const m of this.sim.members) {
      if (m.kind !== 'column' || m.story === undefined) continue;
      const node = {
        member: m, story: m.story, gi: m.gi, gj: m.gj, key: `${m.gi},${m.gj}`,
        x: m.x, z: m.z,
        L: o.storyHeight,          // unbraced length (shoring reduces this)
        K: o.endFixityIntact,      // Euler end-fixity factor
        spall: 1,                  // fraction of gross section remaining (1 = undamaged)
        failed: false, demand: 0, capacity: 0, utilization: 0, governing: 'crush',
      };
      this.columns.push(node);
      this.byStory[m.story].push(node);
    }
    // Size capacity against the intact service demand (see designSafetyFactor in sim.js DEFAULTS).
    this._computeDemands();
    for (const c of this.columns) {
      const geom = this._geomCapacity(c);
      c.capScale = o.designSafetyFactor > 0 && c.demand > 0 && geom.capacity > 0
        ? (o.designSafetyFactor * c.demand) / geom.capacity
        : 1;
      c.designDemand = c.demand;
    }
    this._refreshCapacities();
    return this.columns.length;
  }

  // ---- capacity ------------------------------------------------------------

  /**
   * Raw geometric capacity of a column, from its (possibly damaged) section.
   * Crush:   P = 0.85 f'c A_g + f_y A_s        (axial compression capacity)
   * Euler:   P_cr = π² E I / (K L)²            (specs.md §2B, verbatim)
   * A square section that spalls stays square, so A = A₀·s and I = A²/12 = I₀·s² — the "damaged
   * inertia moment" the spec calls for falls out of the section loss quadratically, which is why
   * spalling collapses buckling capacity so much faster than crush capacity.
   */
  _geomCapacity(c) {
    const o = this.opts, s = Math.max(1e-4, c.spall);
    const Ag = o.columnSize ** 2 * s;                       // m²
    const I = (o.columnSize ** 4 / 12) * s * s;             // m⁴ — damaged inertia moment
    const As = 4 * Math.PI * o.rebarThickness ** 2 * s;     // m² — 4-bar cage, exposed bars lost
    const crush = 0.85 * o.concreteFc * Ag + o.steelFy * As;          // kN
    const KL = Math.max(1e-6, c.K * c.L);
    const euler = (Math.PI ** 2 * o.concreteE * I) / (KL * KL);       // kN
    return { crush, euler, capacity: Math.min(crush, euler), governing: euler < crush ? 'buckling' : 'crush' };
  }

  capacityOf(c) {
    const geom = this._geomCapacity(c);
    const scale = c.capScale ?? 1;
    return { crush: geom.crush * scale, euler: geom.euler * scale, capacity: geom.capacity * scale, governing: geom.governing };
  }

  _refreshCapacities() {
    for (const c of this.columns) {
      const cap = this.capacityOf(c);
      c.capacity = cap.capacity; c.governing = cap.governing;
      c.crushCapacity = cap.crush; c.eulerCapacity = cap.euler;
      c.utilization = c.failed ? Infinity : (cap.capacity > 0 ? c.demand / cap.capacity : Infinity);
    }
  }

  // ---- load path -----------------------------------------------------------

  liveLoadOn(c) {
    const half = this.loadMatrix().spacing / 2;
    let sum = 0;
    for (const l of this.liveLoads) {
      if (l.story !== undefined && l.story !== c.story) continue;
      if (Math.abs(l.x - c.x) <= half && Math.abs(l.z - c.z) <= half) sum += l.kN;
    }
    return sum;
  }

  /**
   * Accumulate axial demand top-down. Each storey's floor load plus everything delivered from
   * above must be carried by that storey's SURVIVING columns; a lost column's share spreads to
   * the survivors by inverse-square distance (nearest neighbours pick up the most), which is the
   * load redistribution that makes progressive collapse progressive.
   */
  _computeDemands() {
    const o = this.opts, Ld = this.loadMatrix();
    for (const c of this.columns) c.demand = 0;
    this.orphanedStories.clear();

    let incoming = new Map();          // grid key -> axial load arriving from the storey above
    let orphanLoad = 0;                // load from above with no column to land on

    for (let s = o.stories - 1; s >= 0; s--) {
      const cols = this.byStory[s] || [];
      const alive = cols.filter((c) => !c.failed);
      const cell = new Map();
      for (const c of cols) {
        cell.set(c, (incoming.get(c.key) || 0) + Ld.perFloor + Ld.colLoad + this.liveLoadOn(c));
      }
      if (!alive.length) {
        // nothing left standing at this level: all of it becomes falling load, carried down to
        // whichever storey still has columns
        orphanLoad += [...cell.values()].reduce((a, b) => a + b, 0);
        this.orphanedStories.add(s);
        incoming = new Map();
        continue;
      }
      // spread the dead cells' load (and any orphaned load from above) onto the survivors
      for (const c of cols) {
        if (!c.failed) continue;
        this._spread(alive, c, cell.get(c), cell);
        cell.set(c, 0);
      }
      if (orphanLoad > 0) {
        const share = orphanLoad / alive.length;
        for (const c of alive) cell.set(c, cell.get(c) + share);
        orphanLoad = 0;
      }
      // Shoring OFFLOADS a column: the timber carries weight the column would otherwise take.
      // This is the mechanism that matters in practice — a 0.4 m column at 2.6 m is a SHORT
      // column (slenderness ~45), so crush governs and bracing alone changes nothing. Reducing
      // demand does.
      for (const c of alive) c.demand = Math.max(0, cell.get(c) - (c.relief || 0));
      incoming = new Map();
      for (const c of alive) incoming.set(c.key, (incoming.get(c.key) || 0) + c.demand);
    }
  }

  /**
   * Shed a lost column's load onto its neighbours. Load follows the BEAM LINES: when a column
   * goes, the beams above it span twice as far and deliver almost all of the orphaned tributary
   * to the immediately adjacent columns. So we spread over the adjacent ring only (within 1.5
   * bays), inverse-square weighted, and fall back to the whole storey if the neighbourhood is
   * wiped out. Spreading thinly over every surviving column instead would dilute the load so far
   * that a cascade could never start — which is the classic mistake in toy collapse models.
   */
  _spread(alive, from, load, into) {
    if (!alive.length || !(load > 0)) return;
    const reach = this.loadMatrix().spacing * 1.5;
    let pool = alive.filter((c) => Math.hypot(c.x - from.x, c.z - from.z) <= reach);
    if (!pool.length) pool = alive;
    const w = pool.map((c) => 1 / Math.max(1e-6, (c.x - from.x) ** 2 + (c.z - from.z) ** 2));
    const wsum = w.reduce((a, b) => a + b, 0);
    pool.forEach((c, i) => into.set(c, (into.get(c) || 0) + (load * w[i]) / wsum));
  }

  // ---- evaluation / progressive collapse ----------------------------------

  /**
   * Evaluate the whole frame and cascade. Fails the single worst over-utilised column, sheds its
   * load onto its neighbours, then re-evaluates — repeating until either nothing is over capacity
   * or the cascade runs away. Returns the ordered list of columns that failed, which is exactly
   * specs.md §2A's "progressive: failure of one member sequentially unloads onto and breaks
   * adjacent members".
   */
  evaluate({ maxCascade = 64 } = {}) {
    const failures = [];
    for (let iter = 0; iter < maxCascade; iter++) {
      this._computeDemands();
      this._refreshCapacities();
      let worst = null;
      for (const c of this.columns) {
        if (c.failed) continue;
        if (c.utilization > 1 && (!worst || c.utilization > worst.utilization)) worst = c;
      }
      if (!worst) break;
      worst.failed = true;
      worst.failureMode = worst.governing;
      failures.push(worst);
      this.log.push(`storey ${worst.story} col (${worst.gi},${worst.gj}) failed in ${worst.governing}: ` +
        `${worst.demand.toFixed(0)} kN > ${worst.capacity.toFixed(0)} kN (util ${worst.utilization.toFixed(2)})`);
    }
    this._computeDemands();
    this._refreshCapacities();
    return failures;
  }

  // ---- damage & mitigation API --------------------------------------------

  columnsOfStory(s) { return this.byStory[s] || []; }
  nodeForMember(m) { return this.columns.find((c) => c.member === m) || null; }

  /** Nearest surviving column node to a world point (optionally restricted to a storey). */
  nearestColumn(x, z, story) {
    let best = null, bd = Infinity;
    for (const c of this.columns) {
      if (c.failed) continue;
      if (story !== undefined && c.story !== story) continue;
      const d = (c.x - x) ** 2 + (c.z - z) ** 2;
      if (d < bd) { bd = d; best = c; }
    }
    return best;
  }

  /** Spall a column's section (a cut, a hammer, an impact). `frac` is the fraction LOST. */
  damageColumn(c, frac) {
    if (!c) return;
    c.spall = Math.max(0.02, c.spall * (1 - Math.max(0, Math.min(1, frac))));
    this._refreshCapacities();
  }

  /** Losing the framing at an end degrades end fixity, which raises KL and cuts P_cr. */
  degradeFixity(c, mode = 'pinned') {
    if (!c) return;
    const o = this.opts;
    const K = mode === 'free' ? o.endFixityFree : o.endFixityPinned;
    c.K = Math.max(c.K, K);
    this._refreshCapacities();
  }

  addLiveLoad(load) { this.liveLoads.push(load); this._refreshCapacities(); return load; }
  removeLiveLoad(load) {
    const i = this.liveLoads.indexOf(load);
    if (i >= 0) this.liveLoads.splice(i, 1);
    this._refreshCapacities();
  }

  /**
   * Shoring a column does two distinct things, and both matter:
   *   1. It BRACES: bracing at mid-height halves the unbraced length, and since P_cr ∝ 1/(KL)²
   *      that quadruples buckling capacity. Only visible when the column is slender enough for
   *      buckling to govern.
   *   2. It OFFLOADS: the shore carries load the column no longer has to (`relief`, in kN, kept
   *      up to date from the shore's measured load transfer). This is what helps a short,
   *      crush-governed column — i.e. most RC columns in a low-rise building.
   */
  shoreColumn(c, { braceAtMidHeight = true, restoreFixity = true, relief = 0 } = {}) {
    if (!c) return;
    if (braceAtMidHeight) c.L = Math.min(c.L, this.opts.storyHeight / 2);
    if (restoreFixity) c.K = this.opts.endFixityIntact;
    c.relief = Math.max(c.relief || 0, relief);
    c.shored = true;
    this._computeDemands();
    this._refreshCapacities();
  }

  /** Update how much load the shoring on this column is actually taking (kN). */
  setRelief(c, kN) {
    if (!c) return;
    c.relief = Math.max(0, kN);
    this._computeDemands();
    this._refreshCapacities();
  }

  // ---- reporting -----------------------------------------------------------

  report() {
    const alive = this.columns.filter((c) => !c.failed);
    const utils = alive.map((c) => c.utilization).sort((a, b) => b - a);
    const Ld = this.loadMatrix();
    return {
      columns: this.columns.length,
      standing: alive.length,
      failed: this.columns.length - alive.length,
      worstUtilization: utils[0] ?? 0,
      medianUtilization: utils[Math.floor(utils.length / 2)] ?? 0,
      maxDemand: Math.max(0, ...alive.map((c) => c.demand)),
      groundDemand: (this.byStory[0] || []).filter((c) => !c.failed).reduce((a, c) => a + c.demand, 0),
      totalLive: this.liveLoads.reduce((a, l) => a + l.kN, 0),
      perFloorPerColumn: Ld.perFloor,
      deadPerBay: Ld.dead,
      livePerBay: Ld.live,
      orphanedStories: [...this.orphanedStories],
    };
  }
}

// ---------------------------------------------------------------------------
// DebrisSupport — load paths through the SETTLED pile
// ---------------------------------------------------------------------------
// After the collapse there are no storeys, so "tributary area" means nothing. What a rescuer
// actually needs to know is: if I lift/cut HERE, how much weight is bearing on it? That comes
// from the contact graph. We resolve who-rests-on-whom from Rapier's contact manifolds (a
// contact whose normal is substantially vertical transfers weight) and accumulate mass upward.
export class DebrisSupport {
  constructor(sim) {
    this.sim = sim;
    this.above = new Map();     // part -> Set(parts resting ON it)
    this.below = new Map();     // part -> Set(parts it rests on)
    this.supported = new Map(); // part -> kN of debris weight bearing down through it
    this.contactLoad = new Map(); // part -> kN measured from contact impulses
  }

  /**
   * Rebuild the support graph from current contacts. `verticalDot` is how vertical a contact
   * normal must be to count as weight transfer rather than a side nudge.
   */
  rebuild({ verticalDot = 0.5 } = {}) {
    const sim = this.sim, world = sim.world;
    this.above.clear(); this.below.clear(); this.supported.clear(); this.contactLoad.clear();
    const dt = world.integrationParameters.dt || 1 / 120;

    for (const part of sim.parts) {
      if (part.dead) continue;
      this.above.set(part, new Set());
      this.below.set(part, new Set());
    }

    const seen = new Set();
    for (const part of sim.parts) {
      if (part.dead) continue;
      for (const col of part.colliders || []) {
        world.contactPairsWith(col, (other) => {
          const otherPart = sim.colliderToPart.get(other.handle);
          if (!otherPart || otherPart === part || otherPart.dead) return;
          const pairKey = col.handle < other.handle ? `${col.handle}:${other.handle}` : `${other.handle}:${col.handle}`;
          if (seen.has(pairKey)) return;
          seen.add(pairKey);
          world.contactPair(col, other, (manifold, flipped) => {
            const n = manifold.normal();
            if (!n || Math.abs(n.y) < verticalDot) return;
            // Σ|impulse| / dt is the average normal force carried by this interface, in kN.
            let impulse = 0;
            const nc = manifold.numContacts();
            for (let i = 0; i < nc; i++) impulse += Math.abs(manifold.contactImpulse(i));
            const force = impulse / dt;
            this.contactLoad.set(part, (this.contactLoad.get(part) || 0) + force);
            this.contactLoad.set(otherPart, (this.contactLoad.get(otherPart) || 0) + force);
            // Whichever body sits higher is the one being supported. `flipped` tells us how the
            // manifold normal is oriented relative to the pair, so use positions instead — it is
            // unambiguous and does not depend on collider ordering.
            const ya = part.body.translation().y, yb = otherPart.body.translation().y;
            const upper = ya > yb ? part : otherPart;
            const lower = upper === part ? otherPart : part;
            this.above.get(lower)?.add(upper);
            this.below.get(upper)?.add(lower);
          });
        });
      }
    }
    this._accumulate();
    return this;
  }

  /** Weight of a part itself, in kN. */
  weightOf(part) { return part.body.mass() * this.sim.opts.gravity; }

  /**
   * Accumulate supported weight from the top of the pile down. Where several bodies share a
   * supporting body the load is split evenly. Cycles (A on B on A, common in interlocked rubble)
   * are broken by visiting each part once — documented approximation, not an exact statics
   * solution, which would need a full contact-force LP.
   */
  _accumulate() {
    const memo = this.supported, visiting = new Set();
    const walk = (part) => {
      if (memo.has(part)) return memo.get(part);
      if (visiting.has(part)) return 0;      // cycle: stop, treat as already counted
      visiting.add(part);
      let total = this.weightOf(part);
      for (const up of this.above.get(part) || []) {
        const supporters = (this.below.get(up) || new Set()).size || 1;
        total += walk(up) / supporters;
      }
      visiting.delete(part);
      memo.set(part, total);
      return total;
    };
    for (const part of this.sim.parts) if (!part.dead) walk(part);
  }

  /**
   * kN of debris bearing down through this part (its own weight plus everything above it).
   * This is the AUTHORITATIVE W_debris for lifting-bag stall checks and shoring sizing: it is
   * derived from masses and gravity, so it is bounded by the real weight of the pile.
   */
  supportedLoad(part) { return this.supported.get(part) || 0; }

  /**
   * Total magnitude of contact force passing through a part, summed over all of its contacts
   * (kN, from the solver's normal impulses / dt).
   *
   * NOTE this is deliberately NOT the same quantity as supportedLoad, and it can legitimately
   * exceed the weight above — a slab wedged against ten neighbours sums ten interface forces,
   * including equal-and-opposite reaction pairs, and penetration-recovery impulses spike. Use it
   * as a relative "how hard is this piece being squeezed" indicator (it drives the stress map),
   * not as an absolute load. For a single isolated body — a shore post — the sum over only that
   * body's contacts IS meaningful, which is what shoring load transfer reads.
   */
  contactForceThrough(part) { return this.contactLoad.get(part) || 0; }

  /**
   * Total weight resting above a world point, within `radius` horizontally — the W_debris a
   * lifting bag has to beat.
   */
  loadAbove(point, radius = 0.75) {
    let total = 0;
    for (const part of this.sim.parts) {
      if (part.dead) continue;
      const t = part.body.translation();
      if (t.y < point.y) continue;
      if (Math.hypot(t.x - point.x, t.z - point.z) > radius) continue;
      total += this.weightOf(part);
    }
    return total;
  }
}
