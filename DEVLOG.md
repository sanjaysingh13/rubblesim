# RubbleSim Web — engineering devlog

Critical findings and decisions while building the browser collapse simulator
(three.js + Rapier). Kept as a reference so the hard-won lessons aren't re-derived.
Newest iteration last.

---

## Ground rules that paid off

- **Framework-agnostic physics core (`src/sim.js`)** is shared by the renderer
  (`src/main.js`) and a **headless Node test (`verify.mjs`)**. Rapier runs in Node, so
  the whole collapse + void pipeline is verifiable without a browser/WebGL.
- **Measure, then tune.** Every threshold (fracture/snap/crack force, bend angle) was set
  from a measured distribution, not guessed. Pattern: run the sim with the trigger
  disabled (threshold = 1e12), record the per-part peak contact force / max joint bend,
  then pick the threshold off the distribution.
- **`verify.mjs` has an explosion guard**: if any piece's |coord| exceeds ~60 m the run
  FAILs. Instability shows up as coordinates in the thousands — catch it in CI, not by eye.

---

## Iteration 1 — rain debris + pre-placed void spheres

- Spawned weighted debris into a volume, seeded static "void" spheres, froze, exported.
- **Problem:** voids floated *above* the settled pile — pre-placing voids in mid-air
  doesn't work; debris doesn't reliably bury them.
- **Lesson:** voids must be **detected from the settled geometry**, not placed.

## Iteration 2 — 4-story building collapse + void detection

- Modeled a building (columns + slab tiles + furniture), stood it as fixed bodies, then
  collapsed (make dynamic, remove ground/random columns, gravity pancakes it).
- **Void detection by ray-marching** vertical grid lines: an empty gap with solid debris
  above it (covered) and ≥ `minVoidHeight` tall is an enclosed void. Now voids are inside
  the rubble by construction.

## Iteration 3 — "bouncy Lego" → heavy collapse

- Feedback: debris bounced/scattered like light blocks.
- Fixes: **restitution ≈ 0.38**, **gravity 40 m/s²**, high friction, linear/angular
  damping, concrete/steel densities, CCD (heavy fast slabs tunnel otherwise), more solver
  iterations, fixed small timestep (dt = 1/120) with 3 substeps/frame.
- **Lesson:** the "feel" is dominated by restitution + damping + mass, not by any one knob.

## Iteration 4 — visible damage: fracture + snap (measured thresholds)

- Measured slab impact forces (≈500–6800 N at g=40) and member bend.
- **Slabs fractured** into fragments above a force threshold; **columns/beams snap**
  (member = chain of box segments held by fixed joints; a joint removed at overload).
- **Key limit discovered:** rigid-body members barely **bend** (~3–4° max, independent of
  solver iterations). True large-deflection bending needs soft-body/FEM, which Rapier
  can't do. So members are **stiff-then-snap** — which is how RC/steel actually fails.

## Iteration 5 — reinforced concrete (the big rethink)

Driven by real USAR collapse photos:

- **Slabs don't shatter into cubes** — the rebar mesh holds them as coherent panels that
  tilt/pancake, creating lean-to voids. Modeled each floor as a grid of tiles **tied
  together** by joints; the ties are the reinforcement.
- **Rebar stays embedded/exposed, never falls off as "straws."**
- **Beams end up buried** under the pancaking slabs.

### Two explosions and how they were fixed (important)

1. **Joint loops blow up the solver.** Tying every adjacent tile pair makes a 2-D grid of
   fixed joints = closed loops → coordinates → thousands of metres. **Fix:** tie tiles as a
   **spanning tree** (row chains + one linking column) — connected, acyclic, stable.
2. **Rebar as physics bodies exploded** (max |coord| ≈ 2270 m). Thin bars have near-zero
   inertia and the welds had large lever arms. **Fix:** rebar is **visual-only** — child
   mesh descriptors (`part.rebars`) that ride with the concrete piece. Zero physics cost,
   and it's still embedded-then-exposed because it's parented to the concrete mesh.
- **Debug technique:** added `enableRebar` / `enableSlabTies` gates and bisected — ties
  alone were stable (11.8 m), rebar bodies were the culprit. Toggle-and-bisect beats
  staring at the code.

## Iteration 6 — slabs crack into large connected pieces

- Feedback: let slabs crack (they shouldn't stay perfectly whole).
- **Cracking is impact-driven, not bend-driven.** Measured inter-tile bend maxes at ~1°
  (tied mats pancake flat), so a bend threshold never fires. Real slabs crack where they
  *hit* something.
- **Two-stage tile-seam failure:**
  1. Hard impact (contact force > `slabCrackForce`) cracks **one** seam: the rigid tie is
     replaced by a **revolute hinge** along the crack line → pieces fold but stay connected
     by rebar (`_crackTie`).
  2. Extreme fold (> `slabTearAngle`) tears the rebar → full separation (rare).
- **Sparse cracks** (one seam per hard hit) → floors break into a few large multi-tile
  pieces, not a floppy chain.
- Headless (seeds 1–3): ~11–15 cracks, 1–3 tears, 5–8 snaps, 144 settled, pile 3.3–4.7 m,
  no explosion.

---

## Gotchas / guardrails

- **Black screen = a load-time exception, not a render bug.** Root cause once: `main.js`
  had a `gui.add(params, 'slabFractureForce')` for a param removed from `sim.js` DEFAULTS;
  **lil-gui throws on an undefined property**, killing the module before the render loop.
  Guardrail: after any DEFAULTS change, run the assertion that every `gui.add`-bound param
  exists in the assembled `params` object.
- **HMR does not recover from a module-load exception** — hard-reload (Ctrl+Shift+R) after
  fixing such a crash.
- **Rapier 0.14 (compat) API used:** `World`, `RigidBodyDesc.fixed/dynamic` +
  `setLinearDamping/setAngularDamping/setCcdEnabled`, `ColliderDesc.cuboid` +
  `setRestitution/setFriction/setDensity/setActiveEvents(CONTACT_FORCE_EVENTS)/setContactForceEventThreshold`,
  `EventQueue` + `drainContactForceEvents(e => e.maxForceMagnitude()/collider1()/collider2())`,
  `JointData.fixed/revolute`, `createImpulseJoint`/`removeImpulseJoint`,
  `intersectionWithShape` (point probe for void detection). WASM is inlined by `-compat`.
- **Top-level `await RAPIER.init()`** requires Vite `build.target: 'esnext'`.

## Open items / future

- True visible **bending** of members (needs soft-body/FEM, or a visual-only mesh-bend).
- **Void reachability** — which detected voids connect to the surface (the real USAR question).
- **Victim placement** at void centres using the exported ground-truth JSON.
- Concrete **cover-spall** on beams so steel is exposed "by cutting", per the photos.
- Perf: ~150–250 bodies during collapse; watch frame rate as `grid`/`stories` grow.
