/**
 * Pure confined-access clearance checks for USAR rescuer → victim commit.
 *
 * Kept free of three.js / Rapier so verify scripts and (later) the telescopic probe
 * camera can reuse the same rules: same pocket, enough height for a prone envelope,
 * distance within crawl reach, no blocking debris AABB on the path.
 *
 * Returns { ok: true } or { ok: false, reason } where reason is one of:
 *   'lost' | 'no_ingress' | 'too_far' | 'too_tight' | 'blocked' | 'no_path'
 */

import { PRONE_HEIGHT } from './rescuer-constants.js';

/** Default max horizontal crawl assist distance (m). */
export const DEFAULT_COMMIT_REACH = 2.5;

/** How much taller than the prone envelope a void must be to count as crawlable. */
export const HEIGHT_MARGIN = 0.05;

/** Max floor-Y difference between rescuer and victim pocket to treat as connected. */
export const FLOOR_CONNECT_TOL = 0.55;

/** Sample spacing along the rescuer→victim segment (m). */
export const PATH_SAMPLE_STEP = 0.25;

/**
 * Axis-aligned box vs a vertical cylinder (disc extruded in Y) used as the prone corridor.
 * The corridor is a fat line on the floor between rescuer and victim at the prone height.
 */
function aabbHitsCorridor(aabb, x, z, y0, y1, radius) {
  // Expand the query point into a horizontal disc; AABB overlap in XZ + Y range.
  const nearestX = Math.max(aabb.minX, Math.min(x, aabb.maxX));
  const nearestZ = Math.max(aabb.minZ, Math.min(z, aabb.maxZ));
  const dx = x - nearestX;
  const dz = z - nearestZ;
  if (dx * dx + dz * dz > radius * radius) return false;
  // Vertical overlap with the prone envelope slab.
  if (aabb.maxY < y0 || aabb.minY > y1) return false;
  return true;
}

/**
 * True if (x,z) lies inside a void's horizontal footprint (circle of void.radius).
 * Voids without radius fall back to 0.6 m.
 */
function pointInVoidXZ(x, z, v) {
  const r = v.radius ?? 0.6;
  return Math.hypot(x - v.x, z - v.z) <= r + 0.15;
}

/**
 * Pick the best void associated with a world point (prefer confined voids near floorY).
 */
function voidNearPoint(voids, x, y, z) {
  let best = null;
  let bestD = Infinity;
  for (const v of voids || []) {
    const fy = v.floorY ?? (v.y - (v.h ?? v.height ?? 1) * 0.5);
    if (Math.abs(fy - y) > FLOOR_CONNECT_TOL + 0.4) continue;
    const d = Math.hypot(x - v.x, z - v.z);
    const r = (v.radius ?? 0.6) + 0.8;
    if (d <= r && d < bestD) {
      bestD = d;
      best = v;
    }
  }
  return best;
}

/**
 * Core clearance test. All inputs are plain numbers / POJOs — no engine objects.
 *
 * @param {object} args
 * @param {{x:number,y:number,z:number,feetY?:number}} args.rescuer  capsule/world pose
 * @param {{x:number,y:number,z:number,lost?:boolean,ingressUnlocked?:boolean,voidRef?:object}} args.victim
 * @param {object[]} [args.voids]  confined (or all) voids with x,z,floorY,h/height,radius
 * @param {{minX:number,minY:number,minZ:number,maxX:number,maxY:number,maxZ:number}[]} [args.debrisAabbs]
 * @param {number} [args.proneHeight]  vertical envelope (default PRONE_HEIGHT)
 * @param {number} [args.commitReach]  max horizontal assist distance
 */
export function clearanceToVictim({
  rescuer,
  victim,
  voids = [],
  debrisAabbs = [],
  proneHeight = PRONE_HEIGHT,
  commitReach = DEFAULT_COMMIT_REACH,
} = {}) {
  if (!rescuer || !victim) return { ok: false, reason: 'no_path' };
  if (victim.lost) return { ok: false, reason: 'lost' };
  if (!victim.ingressUnlocked) return { ok: false, reason: 'no_ingress' };

  const rx = rescuer.x;
  const rz = rescuer.z;
  const ry = rescuer.feetY ?? rescuer.y;
  const vx = victim.x;
  const vz = victim.z;
  const vy = victim.y;

  // Horizontal distance — assist only within crawl reach (not a long-range teleport).
  const horiz = Math.hypot(vx - rx, vz - rz);
  if (horiz > commitReach) return { ok: false, reason: 'too_far' };

  // Same void / connected floor path.
  const vr = victim.voidRef;
  const victimFloor = vr?.floorY ?? (vy - 0.07);
  if (Math.abs(victimFloor - ry) > FLOOR_CONNECT_TOL + 0.35) {
    return { ok: false, reason: 'no_path' };
  }

  // Prefer the victim's voidRef; otherwise look up voids near both ends.
  const startVoid = voidNearPoint(voids, rx, ry, rz);
  const endVoid = vr || voidNearPoint(voids, vx, victimFloor, vz);
  if (startVoid && endVoid) {
    const same =
      startVoid === endVoid
      || (Math.abs((startVoid.x ?? 0) - (endVoid.x ?? 0)) < 0.05
        && Math.abs((startVoid.z ?? 0) - (endVoid.z ?? 0)) < 0.05
        && Math.abs((startVoid.floorY ?? 0) - (endVoid.floorY ?? 0)) < 0.2);
    // Allow nearby connected pockets: both confined-ish and floor within tolerance.
    const floorsClose = Math.abs(
      (startVoid.floorY ?? victimFloor) - (endVoid.floorY ?? victimFloor),
    ) <= FLOOR_CONNECT_TOL;
    if (!same && !floorsClose) return { ok: false, reason: 'no_path' };
  }

  const needH = proneHeight + HEIGHT_MARGIN;
  const corridorR = 0.28; // half-width of the prone body corridor
  const samples = Math.max(2, Math.ceil(horiz / PATH_SAMPLE_STEP) + 1);

  for (let i = 0; i <= samples; i++) {
    const u = i / samples;
    const x = rx + (vx - rx) * u;
    const z = rz + (vz - rz) * u;
    const floorY = ry + (victimFloor - ry) * u;
    const envelopeTop = floorY + needH;

    // Height: if we have voids along the path, require one that covers this sample
    // with enough clear height. If voids list is empty (unit test with only debris),
    // skip the void-height gate and rely on debris blocking alone.
    let covered = false;
    if (voids.length) {
      for (const v of voids) {
        if (!pointInVoidXZ(x, z, v)) continue;
        const h = v.h ?? v.height ?? 0;
        const fy = v.floorY ?? (v.y - h * 0.5);
        if (Math.abs(fy - floorY) > FLOOR_CONNECT_TOL) continue;
        if (h >= needH) {
          covered = true;
          break;
        }
      }
      // Near the endpoints, allow slight miss (rescuer may still be in the hole column).
      if (!covered && u > 0.08 && u < 0.92) {
        return { ok: false, reason: 'too_tight' };
      }
    }

    // Debris AABB gate: only when this sample is NOT already inside a tall-enough void.
    // Void detection already proved empty space there; counting the roof/floor slabs that
    // *define* the void as "blocking" made every real pocket fail commit.
    if (covered) continue;

    for (const box of debrisAabbs) {
      if (aabbHitsCorridor(box, x, z, floorY + 0.02, envelopeTop, corridorR)) {
        // Ignore very flat floor-like boxes under the belly (maxY barely above floor).
        if (box.maxY <= floorY + 0.08) continue;
        // Ignore soffits that only graze the top of the prone envelope.
        if (box.minY >= envelopeTop - 0.06) continue;
        return { ok: false, reason: 'blocked' };
      }
    }
  }

  return { ok: true };
}

/**
 * Build world-axis AABB list from sim parts for clearance tests.
 * Skips rescuer / victim / ladder / agent tags and already-removed debris.
 *
 * @param {object} sim  RubbleSim-like { parts: [...] }
 */
export function debrisAabbsFromSim(sim) {
  const out = [];
  if (!sim?.parts) return out;
  for (const p of sim.parts) {
    if (!p || p.dead || p.agent || p.rescuer || p.victim || p.ladder) continue;
    if (p.kind === 'rescuer' || p.kind === 'victim') continue;
    const t = p.body?.translation?.() ?? p.pos;
    if (!t) continue;
    const s = p.shape;
    if (!s) continue;
    // Axis-aligned bound from local half-extents (ignores part rotation — conservative
    // enough for a commit gate; slightly over-blocks rather than under-blocks).
    const hx = Math.max(s.hx ?? 0.1, s.hy ?? 0.1, s.hz ?? 0.1);
    const hy = Math.max(s.hy ?? 0.1, 0.05);
    // Use a tighter vertical extent than the max-of-all for hy when available.
    const halfY = s.hy ?? hy;
    const halfXZ = Math.max(s.hx ?? 0.1, s.hz ?? 0.1);
    out.push({
      minX: t.x - halfXZ,
      maxX: t.x + halfXZ,
      minY: t.y - halfY,
      maxY: t.y + halfY,
      minZ: t.z - halfXZ,
      maxZ: t.z + halfXZ,
    });
  }
  return out;
}

/**
 * Convenience: run clearanceToVictim using a live sim + rescuer agent + victim record.
 */
export function clearanceForAgent(agent, victim, opts = {}) {
  if (!agent || !victim) return { ok: false, reason: 'no_path' };
  const t = agent.translation();
  const sim = agent.sim;
  const voids = typeof sim?.confinedVoids === 'function'
    ? sim.confinedVoids()
    : (sim?.voids || []);
  return clearanceToVictim({
    rescuer: { x: t.x, y: t.y, z: t.z, feetY: agent.feetY() },
    victim,
    voids,
    debrisAabbs: opts.debrisAabbs ?? debrisAabbsFromSim(sim),
    proneHeight: opts.proneHeight ?? PRONE_HEIGHT,
    commitReach: opts.commitReach ?? DEFAULT_COMMIT_REACH,
  });
}
