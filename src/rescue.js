// Rescue operations — pneumatic lifting bags and structural shoring.
// Framework-agnostic (no three.js / DOM); the renderer mirrors these as meshes.
// Implements specs.md §3.2 and §3.3.
//
// UNITS (from sim.js): m, tonnes (Mg), s => force kN.
//
// THE TRAINING LOOP THIS ENCODES
// ------------------------------
// A lifting bag has a hard rated capacity. If the debris bearing on the lift point weighs more
// than the bag can push, the bag STALLS — it does not "try harder", and no amount of holding the
// button helps. The way out is the real one: shore the load to carry part of it (or cut weight
// away), then lift. Shoring is therefore not decoration; it changes the number the bag is fighting
// and it raises the buckling capacity of what is still standing (FrameModel.shoreColumn).

// Low-pressure lifting bags, rated the way real ones are — by tonnes of lift.
// Capacity in kN = rated tonnes x g. Displacement is capped at 50 cm per specs.md §3.2.
export const LIFT_BAGS = [
  { id: 'bag4t', label: '4 t lifting bag', tonnes: 4, maxLift: 0.5, radius: 0.3 },
  { id: 'bag10t', label: '10 t lifting bag', tonnes: 10, maxLift: 0.5, radius: 0.4 },
  { id: 'bag20t', label: '20 t lifting bag', tonnes: 20, maxLift: 0.5, radius: 0.5 },
];

// Timber shoring. Capacity is NOT a made-up number: it is the same Euler/crush pair used on the
// concrete frame, evaluated for a timber post (E ~ 10 GPa, fc ~ 20 MPa), so a 100 mm post over
// 2.5 m comes out around 130 kN — which is genuinely what governs a real shore.
export const SHORE_TYPES = [
  { id: 'tShore', label: 'T-shore', posts: 1, post: 0.1, headerLen: 0.9, braced: false },
  { id: 'laceShore', label: 'Lace shore', posts: 2, post: 0.1, headerLen: 1.6, braced: true },
];

const TIMBER_E = 10e6;   // kPa (10 GPa)
const TIMBER_FC = 20e3;  // kPa (20 MPa)

export const bagById = (id) => LIFT_BAGS.find((b) => b.id === id) || null;
export const shoreById = (id) => SHORE_TYPES.find((s) => s.id === id) || null;

/** Axial capacity of one timber post: min(crush, Euler buckling). kN. */
export function postCapacity(side, length, K = 1.0) {
  const Ag = side * side;
  const I = (side ** 4) / 12;
  const crush = TIMBER_FC * Ag;
  const euler = (Math.PI ** 2 * TIMBER_E * I) / ((K * length) ** 2);
  return { crush, euler, capacity: Math.min(crush, euler), governing: euler < crush ? 'buckling' : 'crush' };
}

// Extension ladder for USAR access when a natural pull-up (~7–8 ft) is not enough.
export const LADDER_SPEC = {
  id: 'extLadder',
  label: 'Extension ladder',
  length: 3.5,       // m — typical portable ladder reach
  width: 0.45,
};

export class RescueOps {
  constructor(sim) {
    this.sim = sim;
    this.bags = [];
    this.shores = [];
    this.ladders = [];
    this.events = [];        // {type, ...} drained by the renderer for HUD messages
  }

  clear() {
    this.bags.length = 0; this.shores.length = 0; this.ladders.length = 0; this.events.length = 0;
  }
  emit(e) { this.events.push(e); return e; }
  drainEvents() { const e = this.events.slice(); this.events.length = 0; return e; }

  // ---- shared helpers -----------------------------------------------------

  /**
   * Find the part directly above (or below) a point by casting a ray along the bag's LINE OF
   * ACTION. This is specs.md §3.2.1's "detect the contact interface between two overlapping rigid
   * bodies", and it has to be a ray, not a proximity search: picking the nearest body by centre
   * distance can return something a metre off to one side, and the bag then rises past it and
   * lifts nothing at all.
   */
  _partByRay(point, dirY, maxDist = 2.5) {
    const sim = this.sim;
    const ray = new sim.R.Ray({ x: point.x, y: point.y + 0.02 * dirY, z: point.z }, { x: 0, y: dirY, z: 0 });
    const hit = sim.world.castRay(ray, maxDist, true);
    if (!hit) return null;
    const part = sim.colliderToPart.get(hit.collider.handle);
    return part && !part.dead ? part : null;
  }

  // ---- Feature 2: pneumatic lifting bags (specs.md §3.2) ------------------

  /**
   * Place a bag at the contact interface between two overlapping bodies.
   *
   * MECHANISM — and why it is not a pure force. specs.md §3.2 allows either "a temporary
   * constraint or ... linear upward vectors"; the bag is modelled as an INFLATING KINEMATIC
   * VOLUME (a cuboid whose half-height grows via collider.setHalfExtents), not as
   * addForceAtPoint. A capacity-clamped force source cannot HOLD a load: once the debris is
   * raised, any force above the true weight keeps accelerating it, and the true weight of a
   * contact-supported pile is not knowable in advance. The first implementation here did exactly
   * that and flung a slab 17 km. An inflating volume is also what makes the spec's "max
   * displacement must cap RIGIDLY at 50 cm" exact — the cap is the geometry, not a servo target.
   *
   * Force is still used where a force is genuinely right: the reaction into whatever the bag is
   * standing on (a kinematic body transmits no reaction of its own), applied with the real
   * rapier 0.14 API, addForceAtPoint.
   */
  placeBag(point, bagType = LIFT_BAGS[1]) {
    const sim = this.sim, R = sim.R;
    const spec = typeof bagType === 'string' ? bagById(bagType) : bagType;
    if (!spec) return null;
    const upper = this._partByRay(point, +1);
    const lower = this._partByRay(point, -1, 1.2);
    if (!upper) { this.emit({ type: 'BAG_NO_INTERFACE', point }); return null; }
    // Cement chips sit on slab tops — skip them so the bag engages the structural slab below.
    let liftTarget = upper;
    for (let skip = 0; skip < 8 && liftTarget?.kind === 'fragment'; skip++) {
      const t = liftTarget.body.translation();
      const next = this._partByRay(
        { x: point.x, y: t.y + liftTarget.shape.hy + 0.04, z: point.z }, +1);
      if (!next || next === liftTarget) break;
      liftTarget = next;
    }

    // The bag's contact surface is a constant-size kinematic platform that RISES; it is not a
    // collider that gets resized. setNextKinematicTranslation gives the solver a proper contact
    // velocity, so the debris is carried up smoothly. Resizing via setHalfExtents instead leaves
    // the shape with no velocity: contacts are missed and then resolved as one deep overlap,
    // which ejected the pile to |coord| ~1e6 m. The renderer draws the inflating pillow between
    // baseY and the platform, so it still reads as a bag.
    const plate = 0.03;                               // platform half-height
    const body = sim.world.createRigidBody(
      R.RigidBodyDesc.kinematicPositionBased().setTranslation(point.x, point.y + plate, point.z));
    const col = sim.world.createCollider(
      R.ColliderDesc.cuboid(spec.radius, plate, spec.radius)
        .setFriction(sim.opts.friction).setRestitution(0), body);

    const bag = {
      spec, point: { ...point }, upper: liftTarget, lower,
      capacity: spec.tonnes * sim.opts.gravity,     // kN
      maxLift: spec.maxLift,
      y0: liftTarget.body.translation().y,
      baseY: point.y, plate,
      body, col,
      lift: 0, inflated: false, stalled: false,
      load: 0, carrying: 0, applied: 0, active: true,
    };
    this.bags.push(bag);
    this._assessBag(bag);
    // lifting adds a live load onto the structure below (bag reaction + the debris it shifts)
    if (sim.frame) {
      const node = sim.frame.nearestColumn(point.x, point.z);
      if (node) bag.liveLoad = sim.frame.addLiveLoad({ x: point.x, z: point.z, story: node.story, kN: 0, tag: 'bag' });
    }
    sim.phase = 'collapsing';
    sim._wakeNear(point, Math.max(1.5, spec.radius * 3));
    this.emit({ type: bag.stalled ? 'BAG_STALLED' : 'BAG_PLACED', bag });
    return bag;
  }

  removeBag(bag) {
    const i = this.bags.indexOf(bag);
    if (i >= 0) this.bags.splice(i, 1);
    if (bag.liveLoad && this.sim.frame) this.sim.frame.removeLiveLoad(bag.liveLoad);
    bag.active = false;
    if (bag.body) this.sim.world.removeRigidBody(bag.body);   // takes its collider with it
    this.sim._wakeNear(bag.point, 1.5);                       // load drops back onto the pile
  }

  /**
   * Work out what this bag is fighting: the debris weight bearing on the lift point, less
   * whatever nearby shoring is already carrying. This is the W_debris of the spec's stall test.
   */
  _assessBag(bag) {
    const sim = this.sim;
    const support = sim.support;
    let W = 0;
    if (support) {
      support.rebuild();
      // prefer the accumulated support chain through the body being lifted; fall back to a
      // straight column-of-debris weight above the point
      W = Math.max(support.supportedLoad(bag.upper), support.loadAbove(bag.point, bag.spec.radius * 2));
    } else {
      W = bag.upper.body.mass() * sim.opts.gravity;
    }
    bag.rawLoad = W;
    bag.relief = this.shoreReliefAt(bag.point, 1.5);
    bag.load = Math.max(0, W - bag.relief);
    // Must match the test that actually gates inflation in updateBags, or the reported state and
    // the observed behaviour disagree: the estimate alone once read "not stalled" for a bag that
    // was measuring twice its rating at the contact and had not moved a millimetre.
    bag.stalled = (bag.load > bag.capacity || bag.carrying > bag.capacity)
      && bag.lift < bag.maxLift - 1e-3;
    return bag;
  }

  /** kN of load currently taken by shores near a point — the reason shoring makes a lift possible. */
  shoreReliefAt(point, radius) {
    let relief = 0;
    for (const s of this.shores) {
      if (!s.active) continue;
      if (Math.hypot(s.point.x - point.x, s.point.z - point.z) > radius) continue;
      relief += Math.min(s.carrying, s.capacity);
    }
    return relief;
  }

  /**
   * Per-substep update: inflate the bags and push the reaction into their base.
   * Must run before EVERY world.step — Rapier clears the force accumulator each step, and a
   * kinematic target must be set for the step that is about to run.
   */
  applyForces() {
    const sim = this.sim;
    const dt = sim.world.integrationParameters.dt || 1 / 120;
    const rate = 0.12;                                   // m/s of inflation — a bag is not fast
    for (const bag of this.bags) {
      if (!bag.active) continue;
      if (bag.upper.dead) { bag.active = false; continue; }

      bag.carrying = this._measureBag(bag);
      // A bag stops expanding when the reaction it is carrying reaches its rating. That IS the
      // stall: no scripted lockout, just a bag at max pressure that cannot grow any further.
      const overloaded = bag.carrying > bag.capacity || bag.load > bag.capacity;
      bag.stalled = overloaded && bag.lift < bag.maxLift - 1e-3;

      if (!overloaded && bag.lift < bag.maxLift) {
        bag.lift = Math.min(bag.maxLift, bag.lift + rate * dt);   // exact, hard-capped
        bag.body.setNextKinematicTranslation({
          x: bag.point.x, y: bag.baseY + bag.plate + bag.lift, z: bag.point.z });
      }
      bag.inflated = bag.lift >= bag.maxLift - 1e-3;

      // Reaction into the base. A kinematic body transmits none of its own, but a real bag
      // absolutely shoves down on what it stands on — which is why bagging off soft debris just
      // drives the bag into the pile instead of lifting anything.
      bag.applied = Math.min(bag.capacity, bag.carrying);
      if (bag.lower && !bag.lower.dead && bag.applied > 0) {
        bag.lower.body.addForceAtPoint({ x: 0, y: -bag.applied, z: 0 },
          { x: bag.point.x, y: bag.baseY - 0.02, z: bag.point.z }, true);
      }
      if (bag.liveLoad) bag.liveLoad.kN = bag.applied;
    }
  }

  /** Load actually bearing on a bag, from the normal impulses on its own collider (kN). */
  _measureBag(bag) {
    const sim = this.sim, world = sim.world, dt = world.integrationParameters.dt || 1 / 120;
    let load = 0;
    world.contactPairsWith(bag.col, (other) => {
      world.contactPair(bag.col, other, (manifold) => {
        const n = manifold.normal();
        if (!n || Math.abs(n.y) < 0.4) return;
        let imp = 0;
        const nc = manifold.numContacts();
        for (let i = 0; i < nc; i++) imp += Math.abs(manifold.contactImpulse(i));
        load += imp / dt;
      });
    });
    return load;
  }

  // ---- Feature 3: structural shoring (specs.md §3.3) ---------------------

  /**
   * Erect a shore from a solid base up to the sagging member overhead. Posts are FIXED bodies
   * (RigidBodyDesc.fixed) — a shore that could itself be shoved around would not be shoring.
   */
  placeShore(point, shoreType = SHORE_TYPES[0]) {
    const sim = this.sim, R = sim.R, o = sim.opts;
    const spec = typeof shoreType === 'string' ? shoreById(shoreType) : shoreType;
    if (!spec) return null;

    // Span from the base up to the UNDERSIDE of whatever is overhead. The clear height has to
    // come from a ray cast, and the post must be built slightly short of it: a fixed body spawned
    // overlapping settled debris generates enormous penetration-recovery impulses (a 0.3 m stub
    // jammed into a slab measured 617 kN — three times its own capacity — and "failed" instantly).
    const baseY = Math.max(0, point.y);
    const ray = new R.Ray({ x: point.x, y: baseY + 0.05, z: point.z }, { x: 0, y: 1, z: 0 });
    const hit = sim.world.castRay(ray, o.storyHeight * 2, true);
    const overhead = hit ? sim.colliderToPart.get(hit.collider.handle) : null;
    const clear = hit ? hit.timeOfImpact + 0.05 : o.storyHeight * 0.8;
    // Real shoring is WEDGED tight — a shore left with an air gap carries nothing at all (an
    // early version built 20 mm short and dutifully reported 0 kN forever). So build 3 mm proud
    // of the clear height: enough preload to guarantee contact, far too little to cause the
    // penetration blow-up that spawning a post inside a slab does.
    const gap = -0.003;
    const length = clear - gap - 0.10;                    // 0.10 leaves room for the header plate
    const MIN_SHORE = 0.4;
    if (length < MIN_SHORE) {
      this.emit({ type: 'SHORE_NO_ROOM', point, clear });
      return null;
    }
    const cap = postCapacity(spec.post, length);

    const shore = {
      spec, point: { ...point }, length, overhead,
      capacity: cap.capacity * spec.posts, governing: cap.governing,
      perPost: cap.capacity, carrying: 0, raw: 0, parts: [], active: true, failed: false,
      age: 0,
    };

    // post(s) + header, as fixed bodies
    const halfSpan = spec.posts > 1 ? spec.headerLen / 2 - spec.post : 0;
    const offsets = spec.posts > 1 ? [-halfSpan, halfSpan] : [0];
    for (const dx of offsets) {
      const p = sim._addBox({ hx: spec.post / 2, hy: length / 2, hz: spec.post / 2 },
        { x: point.x + dx, y: baseY + length / 2, z: point.z }, null, 'shore',
        { fixed: true, density: 0.6, events: true });     // 0.6 Mg/m³ ~ softwood
      if (p) { p.shore = shore; shore.parts.push(p); }
    }
    // header plate spreading the load into the slab above
    const header = sim._addBox({ hx: spec.headerLen / 2, hy: 0.05, hz: spec.post / 2 },
      { x: point.x, y: baseY + length + 0.05, z: point.z }, null, 'shore',
      { fixed: true, density: 0.6, events: true });
    if (header) { header.shore = shore; shore.parts.push(header); }
    if (spec.braced) {
      // diagonal laces: modelled as two shallow boxes, which is enough to read as a laced frame
      for (const s of [-1, 1]) {
        const b = sim._addBox({ hx: spec.headerLen / 2.6, hy: 0.04, hz: spec.post / 2.2 },
          { x: point.x, y: baseY + length * (0.5 + 0.2 * s), z: point.z }, null, 'shore',
          { fixed: true, density: 0.6, events: true });
        if (b) { b.shore = shore; shore.parts.push(b); }
      }
    }

    this.shores.push(shore);

    // Structural feedback: a shore braces the nearest column at mid-height (halving unbraced
    // length quadruples P_cr) and restores its end fixity.
    if (sim.frame) {
      const node = sim.frame.nearestColumn(point.x, point.z);
      if (node) { sim.frame.shoreColumn(node); shore.column = node; }
    }
    sim.phase = 'collapsing';
    sim._wakeNear(point, 1.0);
    // Wake the member the shore is seated under, so the load path can actually redistribute onto
    // the new support. Without this the soffit stays asleep metres overhead and the shore reads
    // 0 kN forever — it is touching the load but the load never notices it.
    if (overhead && !overhead.dead) {
      const ot = overhead.body.translation();
      sim._wakeNear(ot, 1.0);
    }
    this.emit({ type: 'SHORE_PLACED', shore });
    return shore;
  }

  /**
   * Candidate shoring positions: ground points with real headroom under an overhead member.
   * Used to validate a placement before committing, and by the renderer to show where a shore
   * will actually fit.
   */
  findShoreSpots({ minClear = 0.8, extent = null, step = 0.5 } = {}) {
    const sim = this.sim, o = sim.opts;
    const ext = extent ?? o.buildingSize / 2 + 2;
    const spots = [];
    for (let x = -ext; x <= ext; x += step) {
      for (let z = -ext; z <= ext; z += step) {
        const ray = new sim.R.Ray({ x, y: 0.05, z }, { x: 0, y: 1, z: 0 });
        const hit = sim.world.castRay(ray, o.storyHeight * 2, true);
        if (!hit) continue;
        const clear = hit.timeOfImpact + 0.05;
        if (clear < minClear) continue;
        const part = sim.colliderToPart.get(hit.collider.handle);
        if (!part || part.shore) continue;
        spots.push({ x, y: 0, z, clear, overhead: part });
      }
    }
    spots.sort((a, b) => b.clear - a.clear);
    return spots;
  }

  removeShore(shore) {
    const i = this.shores.indexOf(shore);
    if (i >= 0) this.shores.splice(i, 1);
    for (const p of shore.parts) this.sim._removePart(p);
    shore.active = false;
  }

  /**
   * Read how much load each shore is actually taking, from the contact manifolds on its own
   * colliders — specs.md §3.3's "extract the normal impulses to calculate structural load
   * transfer". (The spec's `world.contactsWith(body)` does not exist; the real API is
   * `contactPairsWith(collider)` + `contactPair(a, b, manifold => ...)`.)
   *
   * Summing over a single isolated body like a post IS physically meaningful, unlike summing
   * over a wedged slab — see the note on DebrisSupport.contactForceThrough.
   */
  measureShores() {
    const sim = this.sim, world = sim.world;
    const dt = world.integrationParameters.dt || 1 / 120;
    for (const shore of this.shores) {
      if (!shore.active) continue;
      let load = 0;
      for (const part of shore.parts) {
        if (part.dead) continue;
        for (const col of part.colliders || []) {
          world.contactPairsWith(col, (other) => {
            const otherPart = sim.colliderToPart.get(other.handle);
            if (otherPart && otherPart.shore === shore) return;   // ignore shore-internal contacts
            world.contactPair(col, other, (manifold) => {
              const n = manifold.normal();
              if (!n || Math.abs(n.y) < 0.4) return;              // only weight transfer
              let imp = 0;
              const nc = manifold.numContacts();
              for (let i = 0; i < nc; i++) imp += Math.abs(manifold.contactImpulse(i));
              load += imp / dt;
            });
          });
        }
      }
      // Raw impulse sums are spiky and can exceed anything physical, so bound the reading by the
      // weight actually available above the shore, then smooth it. A shore is judged by the load
      // it settles at, not by the transient as it takes up.
      const available = sim.support ? sim.support.loadAbove(shore.point, shore.spec.headerLen) : Infinity;
      shore.raw = load;
      const bounded = Math.min(load, available);
      shore.carrying = shore.age === 0 ? bounded : shore.carrying * 0.8 + bounded * 0.2;
      shore.age++;
      // keep the frame model's demand relief in step with what the timber is really taking
      if (shore.column && sim.frame) sim.frame.setRelief(shore.column, Math.min(shore.carrying, shore.capacity));

      const GRACE = 30;    // steps of take-up before a shore can be judged overloaded
      // Overloaded shoring fails — this is the trap for a trainee who under-shores a heavy load.
      if (!shore.failed && shore.age > GRACE && shore.carrying > shore.capacity) {
        shore.failed = true;
        shore.active = false;
        for (const p of shore.parts) if (!p.dead) { p.body.setBodyType(sim.R.RigidBodyType.Dynamic, true); p.fixed = false; }
        if (shore.column && sim.frame) sim.frame.setRelief(shore.column, 0);   // relief is gone
        this.emit({ type: 'SHORE_FAILED', shore });
      }
    }
  }

  /**
   * Place an extension ladder against a near-vertical face at `point`.
   * The ladder leans from the ground (or debris under the point) up along the surface normal
   * toward the hit, so a rescuer can mount it and climb past a wall that is too tall to mantle.
   */
  placeLadder(point, length = LADDER_SPEC.length) {
    const sim = this.sim, R = sim.R;
    // Find a nearby surface by casting horizontally in several directions from the click.
    let best = null;
    for (let i = 0; i < 8; i++) {
      const ang = (i / 8) * Math.PI * 2;
      const dir = { x: Math.cos(ang), y: 0, z: Math.sin(ang) };
      const ray = new R.Ray({ x: point.x, y: point.y + 0.4, z: point.z }, dir);
      const hit = sim.world.castRay(ray, 2.5, true);
      if (!hit || hit.timeOfImpact > 2.0) continue;
      const part = sim.colliderToPart.get(hit.collider.handle);
      if (!part || part.shore || part.ladder || part.agent) continue;
      if (!best || hit.timeOfImpact < best.toi) {
        best = { toi: hit.timeOfImpact, dir, part, ang };
      }
    }
    if (!best) {
      this.emit({ type: 'LADDER_NO_FACE', point });
      return null;
    }

    // Normal points away from the wall (opposite of cast direction into the face).
    const nx = -best.dir.x;
    const nz = -best.dir.z;
    const faceX = point.x + best.dir.x * best.toi;
    const faceZ = point.z + best.dir.z * best.toi;

    // Base sits on whatever is under the face (ground / debris).
    const down = new R.Ray({ x: faceX + nx * 0.4, y: point.y + 2.0, z: faceZ + nz * 0.4 }, { x: 0, y: -1, z: 0 });
    const groundHit = sim.world.castRay(down, 6.0, true);
    const baseY = groundHit ? (down.origin.y - groundHit.timeOfImpact) : 0;
    const base = { x: faceX + nx * 0.55, y: baseY, z: faceZ + nz * 0.55 };
    // Top leans into the wall — climbable length along the rail.
    const lean = 0.25; // horizontal inset toward the wall at the top
    const top = {
      x: faceX + nx * lean,
      y: baseY + length,
      z: faceZ + nz * lean,
    };
    const actualLen = Math.hypot(top.x - base.x, top.y - base.y, top.z - base.z);

    // Thin fixed collider so the character controller can rest against the ladder rails.
    const mid = {
      x: (base.x + top.x) / 2,
      y: (base.y + top.y) / 2,
      z: (base.z + top.z) / 2,
    };
    // Approximate orientation: ladder rises mostly in Y; we store base/top for climb math and
    // use a vertical box collider at mid for crude blocking.
    const p = sim._addBox(
      { hx: LADDER_SPEC.width / 2, hy: actualLen / 2, hz: 0.04 },
      mid,
      null,
      'ladder',
      { fixed: true, density: 0.5, events: false },
    );
    if (!p) {
      this.emit({ type: 'LADDER_NO_ROOM', point });
      return null;
    }
    p.ladder = true;
    p.agent = false;

    const ladder = {
      spec: LADDER_SPEC,
      base,
      top,
      normal: { x: nx, y: 0, z: nz },
      length: actualLen,
      part: p,
      parts: [p],
      active: true,
      yaw: Math.atan2(nx, nz),
    };
    p.ladderRef = ladder;
    this.ladders.push(ladder);
    this.emit({ type: 'LADDER_PLACED', ladder });
    return ladder;
  }

  removeLadder(ladder) {
    const i = this.ladders.indexOf(ladder);
    if (i >= 0) this.ladders.splice(i, 1);
    for (const p of ladder.parts || []) this.sim._removePart(p);
    ladder.active = false;
  }

  /** Called once per rendered step, after the substeps. */
  postStep() {
    this.measureShores();
    for (const bag of this.bags) {
      if (!bag.active || bag.upper.dead) continue;
      const wasStalled = bag.stalled;
      this._assessBag(bag);
      if (wasStalled && !bag.stalled) this.emit({ type: 'BAG_FREED', bag });
      if (!wasStalled && bag.stalled) this.emit({ type: 'BAG_STALLED', bag });
    }
  }

  report() {
    return {
      bags: this.bags.map((b) => ({
        label: b.spec.label, capacity: b.capacity, load: b.load, relief: b.relief,
        lift: b.lift, maxLift: b.maxLift, stalled: b.stalled, inflated: b.inflated, applied: b.applied,
      })),
      shores: this.shores.map((s) => ({
        label: s.spec.label, capacity: s.capacity, carrying: s.carrying,
        utilization: s.capacity > 0 ? s.carrying / s.capacity : 0,
        governing: s.governing, failed: s.failed, length: s.length,
      })),
      ladders: this.ladders.map((l) => ({
        label: l.spec.label, length: l.length, active: l.active,
      })),
    };
  }
}
