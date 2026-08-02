// USAR rescuer agent — framework-agnostic (no three.js / DOM).
//
// PHYSICS MODEL
// -------------
// The rescuer is a Rapier *kinematic* capsule driven by a KinematicCharacterController (KCC).
// Kinematic bodies do NOT fall under world gravity by themselves — we integrate vertical
// velocity manually (walk / jump) or script the motion (mantle / ladder). Contacts still
// push dynamic debris when setApplyImpulsesToDynamicBodies(true), and we wake the local
// pile so DebrisSupport / SURVIVOR_COMPROMISED see the load path.
//
// LOCOMOTION MODES
// ----------------
//   idle | walk | jump | mantle | ladder | fallen
// Mantle = pull-up onto a ledge ~2.1–2.4 m above the feet (USAR "pull yourself up ~7–8 ft").
// Ladder = climb a placed RescueOps ladder along its axis.
//
// LIVE LOAD
// ---------
// While grounded / climbing we keep a tagged FrameModel live load in sync with params.rescuerLoad
// (and a multiple during mantle). Post-collapse, waking debris underfoot is what actually
// stresses the rubble contact graph.

import { CAPSULE_RADIUS, CAPSULE_HALF, CROUCH_RADIUS, CROUCH_HALF, RESCUER_MASS_T } from './rescuer-constants.js';

export const WALK_SPEED = 2.2;          // m/s on rubble
export const CRAWL_SPEED = 0.95;        // m/s while crouched
export const JUMP_SPEED = 5.2;          // m/s — enough apex to reach ledges / 1 m landings
export const GRAVITY = 18;              // m/s² — slightly juicy for game feel on kinematic body
export const ACCESS_RADIUS = 0.6;       // m — touch distance to count VICTIM_ACCESSED

// Locomotion constraints (DEVLOG 2026-08-01)
export const MAX_SLOPE_DEG = 30;        // walk / land / grab — steeper → slide
export const MAX_SLOPE_RAD = (MAX_SLOPE_DEG * Math.PI) / 180;
export const MAX_JUMP_LAND_H = 1.0;     // m — jump may only land on surfaces ≤ this above takeoff
export const MAX_HOLE_DROP = 2.5;       // m — free drop into a hole; deeper needs rappel (TODO)
export const MAX_GRAB_H = 7.0;          // m — max edge height above jump origin for a pull-up grab
export const MIN_GRAB_H = 1.2;          // m — below this, use walk/autostep or a short land, not a mantle
export const HAND_REACH = 2.15;         // m above feet — raised-hand height while jumping
export const LAND_FORWARD = 0.12;       // m — plant a few cm in front of the contact
export const HOLE_SLIDE_SPEED = -4.5;   // m/s commit fall through a clear opening (was too soft → snap fight)

export const MANTLE_MIN = MIN_GRAB_H;
export const MANTLE_MAX = MAX_GRAB_H;
export const MANTLE_DURATION = 1.4;     // seconds for the scripted pull-up
export const MANTLE_LOAD_MUL = 2.5;     // concentrated load while hanging on the ledge
export const LADDER_CLIMB_SPEED = 1.2;  // m/s along ladder axis
export const LADDER_MOUNT_DIST = 0.85;  // m — how close to mount
export const BUMP_COOLDOWN = 0.28;      // s between body-bump SFX

/** Unit normal's slope from horizontal (0 = flat floor, π/2 = vertical wall). */
export function slopeFromUp(nx, ny, nz) {
  const nlen = Math.hypot(nx, ny, nz) || 1;
  const upDot = Math.max(-1, Math.min(1, ny / nlen));
  return Math.acos(upDot); // angle between normal and +Y
}

export function slopeOk(nx, ny, nz) {
  return slopeFromUp(nx, ny, nz) <= MAX_SLOPE_RAD + 1e-3;
}
/**
 * One playable rescuer bound to a RubbleSim instance.
 */
export class RescuerAgent {
  /**
   * @param {object} sim  RubbleSim
   * @param {{x:number,y:number,z:number}} spawn  capsule-centre world position
   */
  constructor(sim, spawn) {
    this.sim = sim;
    this.R = sim.R;
    this.mode = 'idle';
    this.yaw = 0;
    this.vVel = 0;
    this.walkPhase = 0;
    this.events = [];
    this.liveLoad = null;
    this.accessed = new Set();   // victim ids already counted
    this.wakeCooldown = 0;
    this.mantle = null;          // { t, duration, from, to, supportPart }
    this.ladderRide = null;      // { ladder, t }  t ∈ [0,1] along length
    this.victims = [];           // { id, x, y, z, voidRef, lost, ingressUnlocked }
    this.jumpOrigin = null;      // { x, y, z, feetY } when Space starts a jump
    this.crouched = false;       // hold Shift/Z — shorter capsule for crawl
    this.capHalf = CAPSULE_HALF;
    this.capRadius = CAPSULE_RADIUS;
    this.holeSlideCooldown = 0;   // avoid re-triggering fall while climbing out
    this.holeSliding = false;    // true while committed through an opening (snap/autostep off)
    // wasGrounded starts false until the first KCC query latches — avoids a phantom Space
    // jump or gravity freefall on the very first frame before queries are synced.
    this.wasGrounded = false;
    this.locoReady = false;      // true after first grounded KCC sample
    this.bumpCooldown = 0;
    this.slideVel = null;        // { x, z } brief push-back after a bad landing
    const R = sim.R;
    // Kinematic position-based: we set the next translation each frame after the KCC resolves
    // collisions. Dynamic would fight the character controller and feel spongy.
    const bd = R.RigidBodyDesc.kinematicPositionBased()
      .setTranslation(spawn.x, spawn.y, spawn.z)
      .setCcdEnabled(true);
    this.body = sim.world.createRigidBody(bd);

    // Capsule: radius + cylindrical half-height. Total standing height = 2*(half+radius).
    this.controller = sim.world.createCharacterController(0.01);
    this._buildCapsuleCollider(CAPSULE_HALF, CAPSULE_RADIUS);
    // DEVLOG: max vertical incline 30° — steeper surfaces are walls / slide-backs.
    this.controller.setMaxSlopeClimbAngle(MAX_SLOPE_RAD);
    this.controller.setMinSlopeSlideAngle(MAX_SLOPE_RAD);
    // Autostep for small debris under the 1 m jump-land limit (walk-up, not jump).
    this.controller.enableAutostep(0.45, 0.2, true);
    this.controller.enableSnapToGround(0.35);
    this.controller.setApplyImpulsesToDynamicBodies(true);
    // TONNES, not kilograms — sim.js works in Mg throughout (a slab is ~2 t, not ~2000). Passing
    // 80 here made the rescuer an 80-TONNE character: walking into a 31 t block launched it 6.9 m
    // at 4 m/s. At a real body mass the same walk moves it ~1 cm, which is about what a man
    // leaning on a 30-tonne slab should achieve. Derived from the same `rescuerLoad` the frame
    // model books for a rescuer, so the two cannot drift apart.
    const massT = (sim.opts?.rescuerLoad ?? 1.2) / (sim.opts?.gravity ?? 9.81);
    this.controller.setCharacterMass(Number.isFinite(massT) && massT > 0 ? massT : RESCUER_MASS_T);

    // New kinematic colliders are invisible to scene queries until the pipeline is refreshed.
    // Soft-frozen piles skip world.step(), so we must sync explicitly or spawn is a ghost.
    this._syncSceneQueries();

    this.emit({ type: 'RESCUER_SPAWNED', x: spawn.x, y: spawn.y, z: spawn.z });
  }

  /**
   * Create or replace the KCC capsule. Keeps feet planted when switching stand ↔ crouch
   * by adjusting the body centre for the new half+radius.
   */
  _buildCapsuleCollider(half, radius) {
    const R = this.sim.R;
    const feet = this.body ? this.feetY() : null;
    if (this.collider && this.sim?.world) {
      try {
        this.sim.colliderToPart.delete(this.collider.handle);
        this.sim.world.removeCollider(this.collider, true);
      } catch (_) { /* rebuild / dispose race */ }
      this.collider = null;
    }
    this.capHalf = half;
    this.capRadius = radius;
    const cd = R.ColliderDesc.capsule(half, radius)
      .setFriction(0.9)
      .setRestitution(0)
      .setDensity(0);
    this.collider = this.sim.world.createCollider(cd, this.body);
    if (!this.part) {
      this.part = {
        body: this.body,
        col: this.collider,
        colliders: [this.collider],
        shape: { hx: radius, hy: half + radius, hz: radius },
        kind: 'rescuer',
        matKind: 'rescuer',
        agent: true,
        rescuer: true,
        dead: false,
        fixed: false,
      };
    } else {
      this.part.col = this.collider;
      this.part.colliders = [this.collider];
      this.part.shape = { hx: radius, hy: half + radius, hz: radius };
    }
    this.sim.colliderToPart.set(this.collider.handle, this.part);
    if (feet != null) {
      this._setPose({ x: this.translation().x, y: feet + half + radius, z: this.translation().z });
    }
    this._syncSceneQueries();
  }

  emit(e) { this.events.push(e); return e; }
  drainEvents() { const e = this.events.slice(); this.events.length = 0; return e; }

  translation() { return this.body.translation(); }

  /** Feet world Y (bottom of capsule). */
  feetY() {
    const t = this.translation();
    return t.y - this.capHalf - this.capRadius;
  }

  /** Standing height of the current capsule (m). */
  capsuleHeight() {
    return this.capHalf * 2 + this.capRadius * 2;
  }

  /**
   * Where he is standing, in the shape src/rescuer-reach.js wants for its reach tests.
   * Handing out one object keeps the renderer from re-deriving feet height and heading itself.
   */
  stance() {
    const t = this.translation();
    return {
      x: t.x, z: t.z, feetY: this.feetY(), yaw: this.yaw,
      crouched: this.crouched, height: this.capsuleHeight(),
    };
  }

  /**
   * Hold-to-crouch. Standing up requires clear overhead; otherwise stay crouched.
   */
  setCrouch(want) {
    if (want === this.crouched) return;
    if (want) {
      this._buildCapsuleCollider(CROUCH_HALF, CROUCH_RADIUS);
      this.crouched = true;
      this.emit({ type: 'RESCUER_CROUCH', crouched: true });
      return;
    }
    // Stand: cast up from feet for standing clearance.
    if (!this._canStandHere()) {
      this.emit({ type: 'RESCUER_CROUCH_BLOCKED' });
      return;
    }
    this._buildCapsuleCollider(CAPSULE_HALF, CAPSULE_RADIUS);
    this.crouched = false;
    this.emit({ type: 'RESCUER_CROUCH', crouched: false });
  }

  /** True if a standing capsule fits above the current feet without hitting solid. */
  _canStandHere() {
    const feet = this.feetY();
    const t = this.translation();
    const standTop = feet + CAPSULE_HALF * 2 + CAPSULE_RADIUS * 2;
    // Start above the crouch crown + probe radius so we never overlap our own capsule.
    const probeR = Math.min(CROUCH_RADIUS, CAPSULE_RADIUS) * 0.7;
    const crouchTop = feet + this.capsuleHeight();
    const R = this.sim.R;
    const ball = new R.Ball(probeR);
    const rot = { x: 0, y: 0, z: 0, w: 1 };
    for (let y = crouchTop + probeR + 0.04; y <= standTop - probeR; y += 0.1) {
      // Exclude our own body — otherwise the crouch capsule always "blocks" standing.
      const hit = this.sim.world.intersectionWithShape(
        { x: t.x, y, z: t.z }, rot, ball,
        undefined, undefined, undefined, this.body,
      );
      if (hit !== null) return false;
    }
    return true;
  }

  /**
   * Snap-to-ground + autostep fight a hole drop: the capsule falls a few cm into the
   * opening, then snaps back onto the frame rim → visible up/down oscillation.
   * While committed through a hole, both must stay off until we land below.
   */
  _setHoleFallAids(active) {
    if (!this.controller) return;
    if (active) {
      // Distance 0 = effectively off (rapier-compat has no disableSnapToGround).
      this.controller.enableSnapToGround(0);
      this.controller.enableAutostep(0, 0, false);
    } else {
      this.controller.enableSnapToGround(0.35);
      this.controller.enableAutostep(0.45, 0.2, true);
    }
  }

  /**
   * Stepped onto a clear cutter / hammer+rebar opening — drop through instead of walking over.
   * Teleports below the slab band in one shot so KCC never gets a chance to snap back to the rim.
   */
  _tryHoleSlide(grounded) {
    if (this.holeSliding) return false;
    if (!grounded || this.mode === 'jump' || this.mode === 'mantle' || this.mode === 'ladder') return false;
    if (this.holeSlideCooldown > 0) return false;
    if (!this.sim?.passableOpeningAt) return false;
    const t = this.translation();
    const feet = this.feetY();
    // Stricter inset so only a real step into the hole commits (rim walking stays stable).
    const hit = this.sim.passableOpeningAt(t.x, feet + 0.05, t.z, 0.72);
    if (!hit) return false;

    const hy = hit.part?.shape?.hy ?? 0.11;
    // Capsule centre clearly under the slab underside — past snap range and past frame colliders.
    const clearFeetY = hit.y - hy - 0.28;
    const centreY = clearFeetY + this.capHalf + this.capRadius;

    this.jumpOrigin = { x: t.x, y: t.y, z: t.z, feetY: feet };
    this._setHoleFallAids(true);
    this.holeSliding = true;
    this._setPose({
      x: hit.x,
      y: centreY,
      z: hit.z,
    });
    this.vVel = HOLE_SLIDE_SPEED;
    this.mode = 'jump';
    this.wasGrounded = false;
    this.locoReady = false;
    // Long enough to finish the drop and step away from the hole column before re-arming.
    this.holeSlideCooldown = 1.4;
    this.emit({ type: 'HOLE_SLIDE', x: hit.x, y: hit.y, z: hit.z, radius: hit.radius });
    return true;
  }

  /** End a committed hole fall and restore normal walk aids. */
  _endHoleSlide() {
    if (!this.holeSliding) return;
    this.holeSliding = false;
    this._setHoleFallAids(false);
  }

  /**
   * Turn on the spot to face a world position — used when a tool is applied slightly off to one
   * side, so he squares up to the work instead of cutting across his own body.
   *
   * `rate` caps the turn in radians per second; pass Infinity to snap. Returns true once he is
   * within a couple of degrees of the requested heading.
   */
  faceTowards(x, z, dt = 0, rate = Infinity) {
    const t = this.translation();
    const dx = x - t.x, dz = z - t.z;
    if (Math.hypot(dx, dz) < 1e-3) return true;
    const want = Math.atan2(dx, dz);
    // Shortest way round the circle: wrap the error into (-π, π] before easing along it.
    let err = want - this.yaw;
    while (err > Math.PI) err -= Math.PI * 2;
    while (err < -Math.PI) err += Math.PI * 2;
    const step = Math.min(Math.abs(err), rate * dt);
    this.yaw = Number.isFinite(step) ? this.yaw + Math.sign(err) * step : want;
    // The capsule is a body of revolution so its collisions do not care, but the rotation has to
    // be pushed into Rapier anyway or the next KCC query works from a stale orientation.
    this._setPose(this.translation(), this.yaw);
    return Math.abs(err) < 0.03;
  }

  /**
   * Soft-frozen piles stop calling `world.step()`. Rapier's KCC / castRay still read the
   * *query pipeline*, which only refreshes on step — or via these two hooks. Without them,
   * setTranslation moves the body but debris/ground stay "where they were" for queries, so
   * the rescuer falls through floors and walks through slabs (Casper).
   */
  _syncSceneQueries() {
    const w = this.sim?.world;
    if (!w) return;
    if (typeof w.propagateModifiedBodyPositionsToColliders === 'function') {
      w.propagateModifiedBodyPositionsToColliders();
    }
    if (typeof w.updateSceneQueries === 'function') {
      w.updateSceneQueries();
    }
  }

  /**
   * Apply pose immediately (frozen world may not step) and queue for the next Rapier step.
   * Always refresh the query pipeline afterward so the next KCC / raycast sees us here.
   */
  _setPose(pos, yaw = this.yaw) {
    this.body.setTranslation(pos, true);
    this.body.setNextKinematicTranslation(pos);
    const half = yaw * 0.5;
    const rot = { x: 0, y: Math.sin(half), z: 0, w: Math.cos(half) };
    this.body.setRotation(rot, true);
    this.body.setNextKinematicRotation(rot);
    this._syncSceneQueries();
  }

  /**
   * One KCC resolve: sync → compute corrected delta → apply pose.
   * Returns { corr, grounded } from this compute.
   */
  _moveWithKcc(desired) {
    this._syncSceneQueries();
    this.controller.computeColliderMovement(this.collider, desired);
    const corr = this.controller.computedMovement();
    const t = this.translation();
    this._setPose({
      x: t.x + corr.x,
      y: t.y + corr.y,
      z: t.z + corr.z,
    });
    return {
      corr,
      grounded: this.controller.computedGrounded(),
    };
  }

  /**
   * Scene ray that never reports our own capsule. After `_syncSceneQueries`, the rescuer
   * collider is in the query pipeline — without an exclude, forward mantle/grab casts start
   * inside the capsule (TOI 0) and never see the wall ahead.
   *
   * Prefer `filterExcludeRigidBody` over `filterExcludeCollider` alone: both are supported by
   * rapier-compat 0.14, and excluding the whole kinematic body is the safer "not me" filter.
   */
  _castRay(origin, dir, maxToi, { normal = false } = {}) {
    const ray = new this.R.Ray(origin, dir);
    const args = [ray, maxToi, true, undefined, undefined, undefined, this.body];
    return normal
      ? this.sim.world.castRayAndGetNormal(...args)
      : this.sim.world.castRay(...args);
  }

  /**
   * Input snapshot from the renderer:
   *   { forward, back, left, right, jump, interact, crouch, camForward, camRight, loadkN }
   */
  step(dt, input = {}) {
    if (!this.body) return;
    const loadkN = input.loadkN ?? this.sim.opts.rescuerLoad ?? 1.2;
    this.bumpCooldown = Math.max(0, this.bumpCooldown - dt);
    this.holeSlideCooldown = Math.max(0, this.holeSlideCooldown - dt);

    // Hold Shift or Z to crouch / crawl (C is Collapse; Ctrl fights browser shortcuts).
    if (this.mode !== 'mantle' && this.mode !== 'ladder') {
      this.setCrouch(!!input.crouch);
    }

    if (this.mode === 'mantle') {
      this._stepMantle(dt, loadkN);
      this._checkOpeningIngress();
      this._checkVictimAccess();
      return;
    }
    if (this.mode === 'ladder') {
      this._stepLadder(dt, input, loadkN);
      this._checkOpeningIngress();
      this._checkVictimAccess();
      return;
    }

    // --- horizontal wish from camera-relative WASD --------------------------------
    const speed = this.crouched ? CRAWL_SPEED : WALK_SPEED;
    let mx = 0, mz = 0;
    const f = input.camForward || { x: 0, z: 1 };
    const r = input.camRight || { x: 1, z: 0 };
    if (input.forward) { mx += f.x; mz += f.z; }
    if (input.back) { mx -= f.x; mz -= f.z; }
    if (input.right) { mx += r.x; mz += r.z; }
    if (input.left) { mx -= r.x; mz -= r.z; }
    const len = Math.hypot(mx, mz);
    if (len > 1e-6) {
      mx = (mx / len) * speed * dt;
      mz = (mz / len) * speed * dt;
      this.walkPhase += dt * (this.crouched ? 5 : 8);
      if (this.mode !== 'jump') this.mode = this.crouched ? 'crawl' : 'walk';
    } else if (this.mode === 'walk' || this.mode === 'crawl') {
      this.mode = this.crouched ? 'crouch' : 'idle';
    } else if (this.crouched && (this.mode === 'idle' || !this.mode)) {
      this.mode = 'crouch';
    } else if (!this.crouched && this.mode === 'crouch') {
      this.mode = 'idle';
    }

    // Brief slide-back after a rejected landing overrides the wish this frame.
    if (this.slideVel) {
      mx = this.slideVel.x * dt;
      mz = this.slideVel.z * dt;
      this.slideVel.ttl -= dt;
      if (this.slideVel.ttl <= 0) this.slideVel = null;
    }

    // --- vertical: jump + gravity -------------------------------------------------
    const groundedBefore = this.locoReady && this.controller.computedGrounded();

    // Over a passable cut: kill snap/autostep so the rim cannot bob the capsule, then commit.
    if (!this.holeSliding && this.sim?.passableOpeningAt) {
      const tProbe = this.translation();
      const overCut = this.sim.passableOpeningAt(tProbe.x, this.feetY() + 0.05, tProbe.z, 0.88);
      if (overCut) this._setHoleFallAids(true);
      else this._setHoleFallAids(false);
    }
    this._tryHoleSlide(groundedBefore);

    if (groundedBefore && this.mode === 'jump' && !this.holeSliding) {
      // Landing handled after movement — keep mode jump until we resolve the land.
    }
    // No jump while crouched — stand first. Hole-slide already set mode=jump.
    if (this.locoReady && groundedBefore && input.jump && this.mode !== 'jump' && !this.crouched && !this.holeSliding) {
      const t0 = this.translation();
      this.jumpOrigin = { x: t0.x, y: t0.y, z: t0.z, feetY: this.feetY() };
      this.vVel = JUMP_SPEED;
      this.mode = 'jump';
      this.emit({ type: 'RESCUER_JUMP', feetY: this.jumpOrigin.feetY });
    } else if (!groundedBefore || this.holeSliding) {
      this.vVel -= GRAVITY * dt;
      if (this.vVel < -12) this.vVel = -12;
    } else if (this.mode !== 'jump') {
      this.vVel = -0.08;
    }

    const desired = { x: mx, y: this.vVel * dt, z: mz };
    const { corr, grounded: groundedAfter } = this._moveWithKcc(desired);

    if (len > 1e-6 && (Math.abs(corr.x) + Math.abs(corr.z)) > 1e-4) {
      this.yaw = Math.atan2(corr.x, corr.z);
    } else if (len > 1e-6) {
      this.yaw = Math.atan2(mx, mz);
    }

    this._detectBump(desired, corr);

    if (groundedAfter) this.locoReady = true;

    if (this.mode === 'jump' && !groundedAfter) {
      const grab = this._findJumpGrab();
      if (grab) {
        this._startMantle(grab);
        this._checkOpeningIngress();
        this._checkVictimAccess();
        return;
      }
    }

    if (this.mode === 'jump' && !this.wasGrounded && groundedAfter) {
      this._resolveJumpLanding();
      this._endHoleSlide();
    } else if (groundedAfter && this.mode === 'jump') {
      this.mode = len > 1e-6 ? (this.crouched ? 'crawl' : 'walk') : (this.crouched ? 'crouch' : 'idle');
      this.jumpOrigin = null;
      this._endHoleSlide();
    }

    // Safety: if somehow grounded while still flagged, restore walk aids.
    if (groundedAfter && this.holeSliding && this.mode !== 'jump') {
      this._endHoleSlide();
    }

    this.wasGrounded = groundedAfter;
    this._updateLiveLoad(loadkN, groundedAfter);
    this._maybeWake(dt, len > 1e-6 || this.mode === 'jump');

    if (input.interact && this.mode !== 'jump' && !this.crouched) {
      if (!this._tryMantle()) this._tryMountLadder();
    }

    this._checkOpeningIngress();
    this._checkVictimAccess();
  }

  /**
   * If the wish was blocked by a steep contact, emit RESCUER_BUMP (renderer plays SFX).
   */
  _detectBump(desired, corr) {
    const wishH = Math.hypot(desired.x, desired.z);
    if (wishH < 1e-4 || this.bumpCooldown > 0) return;
    const gotH = Math.hypot(corr.x, corr.z);
    // Blocked most of the horizontal wish → walking into rubble.
    if (gotH > wishH * 0.55) return;
    let wallHit = false;
    const n = this.controller.numComputedCollisions();
    for (let i = 0; i < n; i++) {
      const hit = this.controller.computedCollision(i);
      if (!hit || !hit.normal1) continue;
      // Near-vertical contact = trunk/foot into a face (not the floor).
      if (Math.abs(hit.normal1.y) < 0.55) { wallHit = true; break; }
    }
    if (!wallHit && gotH < wishH * 0.25) wallHit = true; // blocked with no floor normal
    if (!wallHit) return;
    this.bumpCooldown = BUMP_COOLDOWN;
    this.emit({ type: 'RESCUER_BUMP' });
  }

  /**
   * After a jump touches down: accept only if rise ≤ 1 m, drop ≤ MAX_HOLE_DROP, and
   * surface slope ≤ 30°. Deeper drops need rappelling (TODO).
   */
  _resolveJumpLanding() {
    const origin = this.jumpOrigin;
    const feet = this.feetY();
    const rise = origin ? feet - origin.feetY : 0;
    const drop = origin ? origin.feetY - feet : 0;
    const ground = this._sampleGroundNormal();
    const okSlope = ground ? slopeOk(ground.x, ground.y, ground.z) : true;
    const okRise = rise <= MAX_JUMP_LAND_H + 0.05;
    const okDrop = drop <= MAX_HOLE_DROP + 0.05;
    const okHeight = okRise && okDrop;

    if (okHeight && okSlope) {
      // Hole drops plant in place — a forward nudge can push back onto the rim and re-bounce.
      if (!this.holeSliding) {
        const fx = Math.sin(this.yaw), fz = Math.cos(this.yaw);
        const t = this.translation();
        this._setPose({
          x: t.x + fx * LAND_FORWARD,
          y: t.y,
          z: t.z + fz * LAND_FORWARD,
        });
      }
      this.mode = this.crouched ? 'crouch' : 'idle';
      this.vVel = -0.08;
      this.emit({ type: 'RESCUER_LAND', rise, drop, ok: true });
      this.jumpOrigin = null;
      return;
    }

    // Reject: slide back toward the takeoff footprint.
    const reason = !okDrop ? 'too_deep' : !okRise ? 'too_high' : 'too_steep';
    this.emit({
      type: 'RESCUER_LAND',
      rise,
      drop,
      ok: false,
      reason,
    });
    if (origin) {
      const t = this.translation();
      const dx = origin.x - t.x, dz = origin.z - t.z;
      const d = Math.hypot(dx, dz) || 1;
      this.slideVel = { x: (dx / d) * 2.5, z: (dz / d) * 2.5, ttl: 0.35 };
      // Drop back down toward origin height if we overshot a tall face.
      this._setPose({
        x: t.x,
        y: Math.min(t.y, origin.y + 0.15),
        z: t.z,
      });
    }
    this.mode = 'jump'; // stay airborne until we actually settle
    this.vVel = -2;
    this.jumpOrigin = origin;
  }

  /** Best-effort ground normal under the feet (downward cast). */
  _sampleGroundNormal() {
    const t = this.translation();
    const hit = this._castRay(
      { x: t.x, y: t.y, z: t.z },
      { x: 0, y: -1, z: 0 },
      this.capHalf + this.capRadius + 0.6,
      { normal: true },
    );
    if (!hit) return null;
    const n = hit.normal;
    return n ? { x: n.x, y: n.y, z: n.z } : { x: 0, y: 1, z: 0 };
  }

  /**
   * While jumping: if raised hands reach an edge ≤ MAX_GRAB_H above jump origin and the
   * landing plane is ≤ 30°, begin a pull-up.
   *
   * IMPORTANT: do NOT cast only from hand height. When hands are level with (or above) the
   * ledge top, a horizontal hand-ray flies *over* the slab and never sees the face. Probe
   * several heights from mid-torso up toward the hands so we hit the vertical face, then
   * require that the measured top is within raised-hand reach.
   *
   * Standing-jump apex is only ~0.75 m (JUMP_SPEED/GRAVITY), so hand reach from takeoff is
   * roughly HAND_REACH + apex ≈ 2.9 m — still well under MAX_GRAB_H=7, which covers jumps
   * from raised perches.
   */
  _findJumpGrab() {
    if (!this.jumpOrigin) return null;
    const feet = this.feetY();
    const handY = feet + HAND_REACH;
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const t = this.translation();

    // Sample heights along the raised arm / torso — lowest first so we prefer a solid face hit.
    const probeYs = [
      feet + 1.05,
      feet + 1.45,
      feet + 1.85,
      Math.max(feet + 1.05, handY - 0.35),
    ];

    let hit = null;
    let hitOrigin = null;
    for (const py of probeYs) {
      const origin = { x: t.x + fx * 0.2, y: py, z: t.z + fz * 0.2 };
      // Horizontal forward — we want the vertical face, not the top deck.
      const cand = this._castRay(origin, { x: fx, y: 0, z: fz }, 1.55);
      if (!cand) continue;
      const part = this.sim.colliderToPart.get(cand.collider.handle);
      if (part && (part.agent || part.victim || part.ladder || part.shore)) continue;
      hit = cand;
      hitOrigin = origin;
      break;
    }
    if (!hit || !hitOrigin) return null;

    const part = this.sim.colliderToPart.get(hit.collider.handle);
    const hitPoint = {
      x: hitOrigin.x + fx * hit.timeOfImpact,
      y: hitOrigin.y,
      z: hitOrigin.z + fz * hit.timeOfImpact,
    };
    // Drop onto the top deck just past the face.
    const upOrigin = { x: hitPoint.x + fx * 0.25, y: Math.max(hitPoint.y, handY) + 4.0, z: hitPoint.z + fz * 0.25 };
    const topHit = this._castRay(upOrigin, { x: 0, y: -1, z: 0 }, 8.0, { normal: true });
    if (!topHit) return null;
    const topY = upOrigin.y - topHit.timeOfImpact;
    const rise = topY - this.jumpOrigin.feetY;
    if (rise < MIN_GRAB_H || rise > MAX_GRAB_H) return null;

    const n = topHit.normal || { x: 0, y: 1, z: 0 };
    if (!slopeOk(n.x, n.y, n.z)) {
      this.emit({ type: 'RESCUER_GRAB_FAIL', reason: 'too_steep', rise });
      return null;
    }

    // Hands must actually reach the edge (+ small margin for fingertip / timing).
    if (topY > handY + 0.35) return null;

    const support = this.sim.colliderToPart.get(topHit.collider.handle) || part;
    return {
      supportPart: support,
      topY,
      landX: hitPoint.x + fx * 0.35,
      landZ: hitPoint.z + fz * 0.35,
      rise,
    };
  }

  _startMantle(target) {
    // Pull-ups need full standing height — leave crouch before climbing.
    if (this.crouched) this.setCrouch(false);
    const t = this.translation();
    const landY = target.topY + this.capHalf + this.capRadius + 0.02;
    this.mantle = {
      t: 0,
      duration: MANTLE_DURATION,
      from: { x: t.x, y: t.y, z: t.z },
      to: { x: target.landX, y: landY, z: target.landZ },
      supportPart: target.supportPart,
    };
    this.mode = 'mantle';
    this.vVel = 0;
    this.jumpOrigin = null;
    if (target.supportPart && !target.supportPart.dead && this.sim.phase === 'frozen') {
      this.sim._wakeNear(target.supportPart.body.translation(), 1.0);
      this.sim.phase = 'collapsing';
    }
    this.emit({ type: 'MANTLE_START', rise: target.rise });
  }

  // ---- live load / wake ----------------------------------------------------------

  _updateLiveLoad(kN, bearing) {
    const t = this.translation();
    if (!bearing || !this.sim.frame) {
      if (this.liveLoad) {
        this.sim.frame.removeLiveLoad(this.liveLoad);
        this.liveLoad = null;
      }
      return;
    }
    if (!this.liveLoad) {
      const node = this.sim.frame.nearestColumn(t.x, t.z);
      this.liveLoad = this.sim.frame.addLiveLoad({
        x: t.x, z: t.z, story: node ? node.story : 0, kN, tag: 'rescuer',
      });
      this._liveLoadAt = { x: t.x, z: t.z, kN };
      return;
    }
    // Refresh capacities only when the load meaningfully moved — calling this every frame
    // rebuilds the whole column graph and freezes the UI.
    const prev = this._liveLoadAt || { x: t.x, z: t.z, kN };
    const moved = Math.hypot(t.x - prev.x, t.z - prev.z);
    if (moved < 0.25 && prev.kN === kN) {
      this.liveLoad.x = t.x;
      this.liveLoad.z = t.z;
      return;
    }
    this.liveLoad.x = t.x;
    this.liveLoad.z = t.z;
    this.liveLoad.kN = kN;
    this._liveLoadAt = { x: t.x, z: t.z, kN };
    this.sim.frame._refreshCapacities();
  }

  /**
   * Wake sleeping debris underfoot so rescuer weight enters the contact graph.
   *
   * IMPORTANT: bulk `_wakeNear` + flipping `sim.phase` back to `collapsing` while the player
   * is still walking created an endless freeze→wake→collapse loop that hung the browser.
   * Everyday foot traffic relies on KCC `setApplyImpulsesToDynamicBodies` instead; only an
   * explicit heavy action (mantle) may bulk-wake and re-enter the settle loop.
   */
  _maybeWake(_dt, _moving) {
    // Intentionally a no-op for walk/jump/ladder. See _tryMantle for the one-shot wake path.
  }

  // ---- mantle / pull-up ----------------------------------------------------------

  /**
   * Probe for a standable ledge ahead (E while grounded). Same slope / height rules as a jump grab.
   * Returns { supportPart, topY, landX, landZ, rise } or null.
   */
  findMantleTarget() {
    const t = this.translation();
    const feet = this.feetY();
    const fx = Math.sin(this.yaw);
    const fz = Math.cos(this.yaw);
    const raw = { x: fx, y: 0.12, z: fz };
    const rl = Math.hypot(raw.x, raw.y, raw.z) || 1;
    const dir = { x: raw.x / rl, y: raw.y / rl, z: raw.z / rl };
    // Start slightly ahead of the chest so we are not casting from deep inside the capsule.
    const origin = { x: t.x + fx * 0.35, y: t.y, z: t.z + fz * 0.35 };
    const hit = this._castRay(origin, dir, 1.8);
    if (!hit) return null;
    const part = this.sim.colliderToPart.get(hit.collider.handle);
    if (!part || part.agent || part.victim || part.ladder || part.shore) return null;

    const hitPoint = {
      x: origin.x + dir.x * hit.timeOfImpact,
      y: origin.y + dir.y * hit.timeOfImpact,
      z: origin.z + dir.z * hit.timeOfImpact,
    };
    const upOrigin = { x: hitPoint.x + fx * 0.2, y: hitPoint.y + Math.max(4, MAX_GRAB_H), z: hitPoint.z + fz * 0.2 };
    const topHit = this._castRay(upOrigin, { x: 0, y: -1, z: 0 }, MAX_GRAB_H + 2, { normal: true });
    if (!topHit) return null;
    const topY = upOrigin.y - topHit.timeOfImpact;
    const rise = topY - feet;
    if (rise < MANTLE_MIN || rise > MANTLE_MAX) return null;

    const n = topHit.normal || { x: 0, y: 1, z: 0 };
    if (!slopeOk(n.x, n.y, n.z)) return null;

    const landX = hitPoint.x + fx * 0.35;
    const landZ = hitPoint.z + fz * 0.35;
    const support = this.sim.colliderToPart.get(topHit.collider.handle) || part;
    return { supportPart: support, topY, landX, landZ, rise };
  }

  _tryMantle() {
    const target = this.findMantleTarget();
    if (!target) {
      this.emit({ type: 'MANTLE_NO_LEDGE' });
      return false;
    }
    this._startMantle(target);
    return true;
  }

  _stepMantle(dt, loadkN) {
    const m = this.mantle;
    if (!m) { this.mode = 'idle'; return; }
    m.t += dt;
    const u = Math.min(1, m.t / m.duration);
    // Ease-in-out so the pull-up doesn't look linear.
    const s = u * u * (3 - 2 * u);
    const x = m.from.x + (m.to.x - m.from.x) * s;
    const y = m.from.y + (m.to.y - m.from.y) * s;
    const z = m.from.z + (m.to.z - m.from.z) * s;
    this._setPose({ x, y, z });

    // Concentrated live load while hanging — no per-frame bulk wake (that hung the sim).
    this._updateLiveLoad(loadkN * MANTLE_LOAD_MUL, true);

    if (u >= 1) {
      this.mantle = null;
      this.mode = 'idle';
      this.vVel = -0.5;
      this.emit({ type: 'MANTLE_DONE' });
    }
  }

  // ---- ladder -------------------------------------------------------------------

  _tryMountLadder() {
    const ladders = this.sim.rescue?.ladders || [];
    const t = this.translation();
    let best = null, bestDist = LADDER_MOUNT_DIST;
    for (const ladder of ladders) {
      if (!ladder.active) continue;
      // Closest point on the ladder segment (base → top).
      const dx = ladder.top.x - ladder.base.x;
      const dy = ladder.top.y - ladder.base.y;
      const dz = ladder.top.z - ladder.base.z;
      const lenSq = dx * dx + dy * dy + dz * dz || 1;
      let u = ((t.x - ladder.base.x) * dx + (t.y - ladder.base.y) * dy + (t.z - ladder.base.z) * dz) / lenSq;
      u = Math.max(0, Math.min(1, u));
      const px = ladder.base.x + dx * u;
      const py = ladder.base.y + dy * u;
      const pz = ladder.base.z + dz * u;
      const d = Math.hypot(t.x - px, t.y - py, t.z - pz);
      if (d < bestDist) { bestDist = d; best = { ladder, u }; }
    }
    if (!best) {
      this.emit({ type: 'LADDER_NONE_NEAR' });
      return false;
    }
    this.ladderRide = { ladder: best.ladder, t: best.u };
    this.mode = 'ladder';
    this.vVel = 0;
    if (this.liveLoad) {
      this.sim.frame?.removeLiveLoad(this.liveLoad);
      this.liveLoad = null;
    }
    this.emit({ type: 'LADDER_MOUNT' });
    return true;
  }

  _stepLadder(dt, input, loadkN) {
    const ride = this.ladderRide;
    if (!ride || !ride.ladder.active) {
      this.mode = 'idle';
      this.ladderRide = null;
      return;
    }
    const ladder = ride.ladder;
    let climb = 0;
    if (input.forward) climb += 1;
    if (input.back) climb -= 1;
    const len = ladder.length || 1;
    ride.t += (climb * LADDER_CLIMB_SPEED * dt) / len;
    ride.t = Math.max(0, Math.min(1, ride.t));

    const x = ladder.base.x + (ladder.top.x - ladder.base.x) * ride.t;
    const y = ladder.base.y + (ladder.top.y - ladder.base.y) * ride.t;
    const z = ladder.base.z + (ladder.top.z - ladder.base.z) * ride.t;
    // Offset capsule centre slightly off the rails so we don't sink into them.
    const nx = ladder.normal?.x || 0;
    const nz = ladder.normal?.z || 0;
    this._setPose({
      x: x + nx * 0.35,
      y: y,
      z: z + nz * 0.35,
    }, Math.atan2(-nx, -nz) || this.yaw);
    this.yaw = Math.atan2(-nx, -nz);
    this._updateLiveLoad(loadkN, true);
    this._maybeWake(dt, Math.abs(climb) > 0);

    // Dismount at ends with jump/interact, or when player presses jump.
    if (input.jump || input.interact) {
      this._dismountLadder(ride.t > 0.85 ? 'top' : 'bottom');
    } else if (ride.t <= 0 && climb < 0) {
      this._dismountLadder('bottom');
    } else if (ride.t >= 1 && climb > 0) {
      this._dismountLadder('top');
    }
  }

  _dismountLadder(where) {
    const ride = this.ladderRide;
    this.ladderRide = null;
    this.mode = 'idle';
    this.vVel = 0;
    if (ride && where === 'top') {
      const ladder = ride.ladder;
      const nx = ladder.normal?.x || 0;
      const nz = ladder.normal?.z || 0;
      // Step onto the landing just past the top.
      this._setPose({
        x: ladder.top.x + nx * 0.5,
        y: ladder.top.y + CAPSULE_HALF + CAPSULE_RADIUS,
        z: ladder.top.z + nz * 0.5,
      });
    }
    this.emit({ type: 'LADDER_DISMOUNT', where });
  }

  // ---- victims / success ---------------------------------------------------------

  /**
   * Register victim targets (usually one per void). Does not create physics bodies —
   * victims are sensors only; the renderer draws them.
   *
   * `ingressUnlocked` starts false: the rescuer must pass through a cut opening that
   * associates with the void before proximity can score VICTIM_ACCESSED.
   */
  setVictims(list) {
    this.victims = list.map((v, i) => ({
      id: v.id ?? `v${i}`,
      x: v.x, y: v.y, z: v.z,
      voidRef: v.voidRef || null,
      lost: false,
      ingressUnlocked: !!v.ingressUnlocked,
    }));
  }

  markVoidCompromised(voidObj) {
    for (const v of this.victims) {
      if (v.voidRef === voidObj || (v.voidRef && voidObj
        && v.voidRef.x === voidObj.x && v.voidRef.y === voidObj.y && v.voidRef.z === voidObj.z)) {
        v.lost = true;
      }
    }
  }

  /**
   * If the capsule is inside / through a registered cutter or hammer opening, unlock
   * victims whose voids sit under or near that opening.
   */
  _checkOpeningIngress() {
    if (!this.sim?.openingIngressAt || !this.victims.length) return;
    const t = this.translation();
    const hit = this.sim.openingIngressAt(
      t.x, t.y, t.z,
      this.capHalf + this.capRadius,
    );
    if (!hit) return;
    this._unlockVictimsNearOpening(hit);
  }

  /**
   * Associate an opening with nearby voids that lie at or below it, and mark those
   * victims as enterable for scoring.
   */
  _unlockVictimsNearOpening(opening) {
    const margin = 1.0;
    for (const v of this.victims) {
      if (v.lost || v.ingressUnlocked) continue;
      const vr = v.voidRef;
      if (!vr) continue;
      // Void pocket should be at or below the opening (searching downward into rubble).
      if (vr.y > opening.y + 0.75) continue;
      const dist = Math.hypot(vr.x - opening.x, vr.z - opening.z);
      const reach = (vr.radius || 0.5) + opening.radius + margin;
      if (dist <= reach) {
        v.ingressUnlocked = true;
        this.emit({ type: 'INGRESS_UNLOCKED', victimId: v.id, x: opening.x, y: opening.y, z: opening.z });
      }
    }
  }

  /**
   * Score +1 only when the rescuer is within touch range of a victim whose void was
   * unlocked by entering a cut opening, and the void is not compromised.
   */
  _checkVictimAccess() {
    const t = this.translation();
    for (const v of this.victims) {
      if (v.lost || this.accessed.has(v.id) || !v.ingressUnlocked) continue;
      const d = Math.hypot(t.x - v.x, t.y - v.y, t.z - v.z);
      if (d <= ACCESS_RADIUS + CAPSULE_RADIUS) {
        this.accessed.add(v.id);
        this.emit({ type: 'VICTIM_ACCESSED', victimId: v.id, x: v.x, y: v.y, z: v.z });
      }
    }
  }

  /** Test helper: force-unlock a victim for ingress (skips hole transit). */
  unlockVictimIngress(victimId) {
    for (const v of this.victims) {
      if (v.id === victimId || victimId == null) v.ingressUnlocked = true;
    }
  }

  accessedCount() { return this.accessed.size; }

  dispose() {
    // Safe if the sim world was already freed (rebuild clears the agent after dispose).
    try {
      if (this.liveLoad && this.sim?.frame) this.sim.frame.removeLiveLoad(this.liveLoad);
    } catch (_) { /* world may already be gone */ }
    this.liveLoad = null;
    try {
      if (this.collider && this.sim?.world) {
        this.sim.colliderToPart.delete(this.collider.handle);
        this.sim.world.removeCollider(this.collider, true);
      }
      if (this.body && this.sim?.world) this.sim.world.removeRigidBody(this.body);
      if (this.controller && this.sim?.world) this.sim.world.removeCharacterController(this.controller);
    } catch (_) { /* ignore double-free during rebuild */ }
    this.body = null;
    this.collider = null;
    this.controller = null;
    this.sim = null;
  }

  /**
   * Drop the rescuer at a given capsule-centre position, clearing any scripted motion first.
   *
   * There is no pathfinding in this sim — the player walks him with WASD — so this exists for
   * setting up a situation: the headless browser drivers use it to park him at a work face before
   * exercising a tool, which is the only way to test the reach envelope end to end.
   *
   * @param {{x:number,y:number,z:number}} pos  capsule CENTRE, not the feet
   * @param {number} yaw     heading in radians (0 = +Z); defaults to the current heading
   * @param {boolean} snap   true (default) drops him onto whatever is below; false leaves him
   *                         exactly where he was put, which is what a fixed test pose needs
   */
  teleport(pos, yaw = this.yaw, snap = true) {
    if (!this.body) return;
    this.mode = 'idle';
    this.vVel = 0;
    this.mantle = null;
    this.ladderRide = null;
    this.jumpOrigin = null;
    this.slideVel = null;
    this.yaw = yaw;
    this._setPose({ x: pos.x, y: pos.y, z: pos.z }, yaw);
    if (snap) this.snapToGround();
  }

  /**
   * Raycast down and plant feet on the first solid (ground or debris).
   * Call on spawn and whenever the capsule has fallen through the world.
   *
   * After planting we run one downward KCC resolve so `computedGrounded()` is true
   * before the player can press Space — otherwise the first frame looks like freefall
   * (or a jump) until gravity and snap fight each other through a slab.
   */
  snapToGround() {
    if (!this.body || !this.sim?.world) return;
    this._syncSceneQueries();
    const t = this.translation();
    const originY = Math.max(t.y, 1) + 3.0;
    const hit = this._castRay(
      { x: t.x, y: originY, z: t.z },
      { x: 0, y: -1, z: 0 },
      50,
    );
    let groundY = 0; // visual / physics floor top
    if (hit) {
      groundY = Math.max(0, originY - hit.timeOfImpact);
    }
    this._setPose({
      x: t.x,
      y: groundY + this.capHalf + this.capRadius + 0.02,
      z: t.z,
    });
    // Latch onto the floor with a short downward wish so grounding is real, not assumed.
    const { grounded } = this._moveWithKcc({ x: 0, y: -0.25, z: 0 });
    this.vVel = -0.08;
    this.mode = 'idle';
    this.jumpOrigin = null;
    this.slideVel = null;
    this.wasGrounded = !!grounded;
    this.locoReady = !!grounded;
  }
}

/**
 * Pure helper for tests: is a ledge rise within the pull-up band?
 */
export function mantleRiseOk(rise) {
  return rise >= MANTLE_MIN && rise <= MANTLE_MAX;
}

/**
 * Pure helper: would an overlapping agent alone compromise a void? (Always false — callers
 * must skip agent-tagged parts.)
 */
export function agentTriggersCompromise(part) {
  return !(part.agent || part.rescuer || part.victim || part.ladder || part.shore);
}
