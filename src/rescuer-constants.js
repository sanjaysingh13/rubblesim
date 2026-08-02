// Shared capsule dimensions for the USAR rescuer (physics + mesh).
// Kept in a tiny module so headless verify scripts can import numbers without loading three.js.

export const CAPSULE_RADIUS = 0.32;
export const CAPSULE_HALF = 0.52; // cylindrical half-height between the two hemispheres
export const RESCUER_HEIGHT = CAPSULE_HALF * 2 + CAPSULE_RADIUS * 2;

/** Crouched / crawl capsule — fits under ~0.9 m voids and through ~0.6 m cutter holes. */
export const CROUCH_RADIUS = 0.26;
export const CROUCH_HALF = 0.18;
export const CROUCH_HEIGHT = CROUCH_HALF * 2 + CROUCH_RADIUS * 2; // ≈ 0.88 m

/**
 * Prone / elbow-crawl capsule — Rapier's Y-capsule is pitched horizontal along heading.
 * Envelope height above the floor is ~2 * radius (the long axis lies in XZ).
 * This is what lets the rescuer enter side voids that the upright squat crouch cannot.
 */
export const PRONE_RADIUS = 0.22;
export const PRONE_HALF = 0.50; // half-length of the cylindrical section along the body
/** Vertical clearance the prone envelope needs (belly + kit thickness). */
export const PRONE_HEIGHT = PRONE_RADIUS * 2; // ≈ 0.44 m

// Fallback mass of a kitted rescuer in the SIM'S units — tonnes (Mg), like everything else in
// sim.js. This is 122 kg, matching the 1.2 kN `rescuerLoad` the frame model already books for one
// rescuer + kit. Writing it as `122` would read correctly in SI and be catastrophically wrong
// here: the KCC would then shove debris as a 122-TONNE character.
export const RESCUER_MASS_T = 0.122;
