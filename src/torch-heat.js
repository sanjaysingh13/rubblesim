// Along-beam heat from an oxy-acetylene cut (pure geometry — no Three / Rapier).
//
// Heat conducts ±`along` metres from the cut along the beam axis. A victim burns only when
// their position is within that axial window AND within `clearance` of the steel (perpendicular
// distance to the axis, after subtracting the beam half-width). There is no free-air sphere
// around the tip — off-axis air does not score a burn.

/** Default half-width when a synthetic member has no segment shapes (verify / unit tests). */
const DEFAULT_BEAM_HALF = 0.15;

/**
 * Build a unit axis through a beam member from its live segment positions (or explicit ends).
 * Returns { origin, dir, halfWidth } or null if the member is too short / empty.
 *
 * `member` may be a sim member `{ segments: [{ body, shape, dead }] }` or a test stub
 * `{ origin, dir, halfWidth }` / `{ a, b, halfWidth }`.
 */
export function beamAxis(member) {
  if (!member) return null;

  // Explicit stubs used by verify-torch (no Rapier bodies).
  if (member.origin && member.dir) {
    const d = member.dir;
    const len = Math.hypot(d.x, d.y, d.z);
    if (len < 1e-6) return null;
    return {
      origin: { ...member.origin },
      dir: { x: d.x / len, y: d.y / len, z: d.z / len },
      halfWidth: member.halfWidth ?? DEFAULT_BEAM_HALF,
    };
  }
  if (member.a && member.b) {
    const dx = member.b.x - member.a.x, dy = member.b.y - member.a.y, dz = member.b.z - member.a.z;
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return null;
    return {
      origin: { ...member.a },
      dir: { x: dx / len, y: dy / len, z: dz / len },
      halfWidth: member.halfWidth ?? DEFAULT_BEAM_HALF,
    };
  }

  const segs = (member.segments || []).filter((s) => s && !s.dead && s.body);
  if (segs.length < 1) return null;
  const first = segs[0].body.translation();
  const last = segs[segs.length - 1].body.translation();
  const dx = last.x - first.x, dy = last.y - first.y, dz = last.z - first.z;
  const len = Math.hypot(dx, dy, dz);
  // Single-segment beams: fall back to the joint pair if available, else a tiny axis.
  let origin = { x: first.x, y: first.y, z: first.z };
  let dir;
  if (len >= 1e-4) {
    dir = { x: dx / len, y: dy / len, z: dz / len };
  } else if (member.joints && member.joints.length) {
    const j = member.joints.find((r) => !r.broken) || member.joints[0];
    const pa = j.a.body.translation(), pb = j.b.body.translation();
    const jdx = pb.x - pa.x, jdy = pb.y - pa.y, jdz = pb.z - pa.z;
    const jlen = Math.hypot(jdx, jdy, jdz);
    if (jlen < 1e-6) return null;
    origin = { x: pa.x, y: pa.y, z: pa.z };
    dir = { x: jdx / jlen, y: jdy / jlen, z: jdz / jlen };
  } else {
    return null;
  }

  // Half-width: smallest non-axis half-extent on a segment (cross-section).
  let halfWidth = DEFAULT_BEAM_HALF;
  const sample = segs[0].shape;
  if (sample) {
    const hx = sample.hx ?? DEFAULT_BEAM_HALF;
    const hy = sample.hy ?? DEFAULT_BEAM_HALF;
    const hz = sample.hz ?? DEFAULT_BEAM_HALF;
    // Long axis is the largest half-extent; cross is the other two — use their max as radius.
    const halves = [hx, hy, hz].sort((a, b) => a - b);
    halfWidth = halves[1]; // median ≈ cross half-width for a slender box
  }

  return { origin, dir, halfWidth };
}

/** Scalar projection of point p onto axis (metres from origin along dir). */
function projectS(axis, p) {
  return (p.x - axis.origin.x) * axis.dir.x
    + (p.y - axis.origin.y) * axis.dir.y
    + (p.z - axis.origin.z) * axis.dir.z;
}

/** Perpendicular distance from point p to the infinite beam axis. */
function perpDist(axis, p) {
  const s = projectS(axis, p);
  const cx = axis.origin.x + axis.dir.x * s;
  const cy = axis.origin.y + axis.dir.y * s;
  const cz = axis.origin.z + axis.dir.z * s;
  return Math.hypot(p.x - cx, p.y - cy, p.z - cz);
}

/**
 * Would a victim at `victimPos` burn from a torch cut at `cutPoint` on `member`?
 *
 * @param {{x,y,z}} cutPoint
 * @param {object} member  sim member or axis stub (see beamAxis)
 * @param {{x,y,z}} victimPos
 * @param {{ along?: number, clearance?: number }} [opts]
 */
export function burnsAlongBeam(cutPoint, member, victimPos, opts = {}) {
  const along = opts.along ?? 2.0;
  const clearance = opts.clearance ?? 0.5;
  const axis = beamAxis(member);
  if (!axis || !cutPoint || !victimPos) return false;

  const sCut = projectS(axis, cutPoint);
  const sVic = projectS(axis, victimPos);
  if (Math.abs(sVic - sCut) > along) return false;

  // Distance to steel surface ≈ perp to centreline minus half-width; burn if within clearance.
  const toCentre = perpDist(axis, victimPos);
  const toSteel = Math.max(0, toCentre - axis.halfWidth);
  return toSteel <= clearance;
}

/**
 * Filter a list of void / victim entries that burn from this cut.
 * Each entry needs `{ x, y, z }` (and optional `compromised` to skip).
 */
export function victimsBurnedByCut(cutPoint, member, entries, opts = {}) {
  const out = [];
  for (const e of entries) {
    if (!e || e.compromised) continue;
    if (burnsAlongBeam(cutPoint, member, e, opts)) out.push(e);
  }
  return out;
}
