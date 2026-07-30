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

## Iteration 7 — rescue equipment: concrete cutter

First tool in an extensible **equipment registry** (`src/equipment.js`). User positions a cut
plane with a **3D gizmo** and applies it; the cut disturbs the rubble's equilibrium.

- **Cut = crack, not sever (concrete-only).** `sim.cut(point, normal, radius)` converts the
  rigid CONCRETE joints crossing the cut plane within `radius` (slab ties + RC column welds)
  into **revolute rebar hinges** (reusing `_crackJoint`, generalized from `_crackTie`). Pieces
  fold/sag but stay attached — fully freeing them is a future rebar cutter. **Steel beams are
  skipped** (concrete cutter can't cut steel) — this is the hook for future tool differentiation.
- **Local re-settle.** After cutting, wake every piece within `wakeRadius` (~3 m) of the cut to
  Dynamic and set `phase='collapsing'`; the renderer re-settles for `cutSettleSeconds` (~3 s)
  then re-freezes and re-detects voids. Rest of the pile stays Fixed = local disturbance model.
- **Finding — where you cut matters.** After a collapse most slab ties near the *top* are
  already cracked (hinges) from impact, so cutting there does nothing (correct: no concrete
  left, only rebar). A cut only bites on still-**rigid** seams. `verify-cut.mjs` targets a
  rigid tie to be deterministic.
- **Finding — a single precise cut on a settled pile moves things little (~15–20 mm).**
  Physically honest: pieces rest on each other (contact-supported), so converting one seam to
  a hinge barely shifts them. Bigger effect needs a larger reach / multiple cuts / a
  load-bearing spot. The headless assert uses a realistic 10 mm movement threshold + explosion guard.
- **Gizmo:** three.js `TransformControls`. In three 0.161 it *is* an `Object3D` → `scene.add(tc)`
  (later versions need `tc.getHelper()` — check the version). Wire `'dragging-changed'` to
  `controls.enabled = !value` so OrbitControls doesn't fight the gizmo. Cut normal = tool local +Z.
- Verified: `node verify-cut.mjs` → severed 2 joints, re-settled, no explosion; `verify.mjs`
  collapse unchanged; all 27 GUI params defined; build clean.
- **Finding — "the cut did nothing on screen".** It actually worked (severed a joint, woke
  ~57 pieces) but the pile is contact-supported so pieces only shift ~15 mm → imperceptible.
  A concrete-only cut (rebar hinge left) is inherently subtle. Fix: **legibility, not more
  force** — `sim.cut` now returns the severed-joint world positions; the renderer flashes
  fading yellow spark markers there and the status reports severed/woken counts (and, on
  severed=0, tells the user to aim at solid grey concrete). Dramatic *movement* (a piece
  dropping into a void) is the job of the future **rebar cutter** that fully frees pieces.
- **Testing note:** I can't see the browser (snap Firefox single-instance blocks headless
  screenshots). Options for on-screen verification: user closes Firefox → I screenshot static
  renders; OR install Playwright (its own browser) to drive clicks + screenshot. Headless
  Node (`verify-cut.mjs`) covers the physics; the visual/interaction layer needs one of these.

## Iteration 8 — hole-cutting concrete cutter, rebar cutter, and Playwright

Grounded in a real 16″ disc-cutter video the user shared: the tool cuts **straight-line kerfs**
and you make a **square hole** to open an ingress; the cut-out plug drops into the void.

- **Concrete cutter = guided square-hole tool.** A `TransformControls` square gizmo is placed
  on a slab; each Apply (hold Enter) advances a ~10 cm kerf around the perimeter. When the
  square closes, `sim.cutHoleInSlab` swaps that tile's single box collider for a **4-box FRAME**
  (same rigid body → all its rebar ties stay intact) and spawns the **plug** as a falling piece.
  `onReshape` callback lets the renderer rebuild the holed tile as a 4-box group. No CSG.
  - **Finding:** spawn the plug slightly *smaller* than the hole (0.9×) or it wedges in the
    frame and won't drop. And to *see* it drop, cut a slab that's actually over a void
    (`verify-hole.mjs` targets a slab above a detected void).
- **Rebar cutter** (`sim.cut(mode:'rebar')`): a plane gizmo that **fully breaks** every joint
  crossing it (ties, hinges, steel members) → frees pieces so they drop. Two-tool story:
  concrete cutter opens holes / cracks concrete; rebar cutter severs to free.
- **`sim.cut` generalized** to `mode` — 'concrete' cracks rigid concrete into hinges,
  'rebar' breaks everything crossing the plane. Multi-collider parts now tracked via
  `part.colliders`; `_removePart` unregisters all of them.

### Playwright — I can finally see/drive the sim headless
- **Node 18 here, so pin `playwright@1.48`** (1.50+ needs Node 20). Chromium headless WebGL
  works with `--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`.
- A `?test` URL exposes `window.__app` (params, setEquipment, applyEquipment, camera, …) so
  `shoot.mjs` can: load → wait for freeze → screenshot → select cutter → cut a hole →
  re-freeze → zoom the camera onto the hole → screenshot. This is the visual-regression path.
- Verified on-screen: the collapse (rebar grid, black beams, cyan voids) and a real square
  hole with the plug dropped. Headless: `verify-hole.mjs` + `verify-cut.mjs` both PASS.

## Iteration 9 — intuitive blade cursor + audio (replaced the gizmo)

The TransformControls gizmo was clunky. Replaced with a **disc-cutter blade** you move with
the mouse (a canvas sprite: circle + teeth + handle, billboarded, `depthTest:false`).

- **Mouse-driven, raycast onto `structureGroup`.** `pointermove` → position the blade at the
  hit point (offset along the face normal); `hitPart` via `mesh.userData.part`. The concrete
  cutter's square footprint + kerf lie on the hit surface (oriented by the face normal).
- **Audio (`src/audio.js`, Web Audio, no assets):** `playContact()` (metallic tick) fires when
  the blade first touches a solid; `startGrind()/stopGrind()` gate a looping bandpassed-noise
  grind while cutting. Hardened with try/catch + a `failed` flag so a no-audio/headless env
  can't break the sim. Needs a user gesture — `ensureAudio()` resumes on first pointerdown.
- **Interaction:** HOLD left-mouse to grind (concrete = square hole grows ~0.9 m/s of kerf
  then plug drops; rebar = one-shot sever under the blade). **Right-drag still orbits**
  (`controls.mouseButtons.LEFT = null` while a tool is active). Enter / Apply button = one-shot.
- **Gotcha:** the `?test` hook still referenced the deleted `cutTool` → would ReferenceError.
  When you delete a gizmo, grep the test hook too. Now exposes `blade`, `lastCut()`.
- Verified visually via Playwright: the blade sprite reads clearly as a disc cutter on the
  slab; headless tests + build still green.

### Iteration 9b — visual feedback (dev machine is speaker-less)
Audio is useless without speakers, so feedback is now visual and the trigger is right-click:
- **Blade rim turns GREEN on contact** (two canvas textures, swapped on engage) instead of a
  contact tick. Off a surface, rim is grey + sprite dimmed.
- **Green translucent square marks the hole** to be cut, laid on the slab under the blade
  (fill + outline, `depthTest:false`).
- **RIGHT-CLICK cuts** (one-shot: concrete = square hole + plug drop, rebar = sever). Left-drag
  still orbits (`mouseButtons.RIGHT=null`, `contextmenu` prevented). Dropped the hold-to-grind
  progressive kerf. Audio calls remain (harmless) for machines that do have speakers.
- Playwright now tests the real right-click path (`page.mouse.click(x,y,{button:'right'})`);
  green rim confirmed on-screen.

## Iteration 10 — hydraulic rebar cutter (long pliers, short mouth)

Second tool, per the real device: cuts the **exposed rebar in a fracture between slabs**.
- **Model:** a fracture between slabs = a *cracked tie hinge* (the collapse leaves ~14 of
  these — the rebar bridging two slab pieces). `sim.exposedRebarNear(point, reach)` finds the
  nearest one; `sim.cutRebar` breaks that hinge (fully separating the pieces) + wakes locally.
  Targets the **seam** (tile centre + its joint anchor, in world space), not the tile centre,
  so hovering the visible fracture engages.
- **UI:** a pliers sprite (long handles + hydraulic body + **short jaws**) that go **green when
  an exposed rebar is within the short mouth** (reach ~0.55 m). Right-click snips it. Distinct
  from the concrete disc; textures swap per tool via `activeFreeTex/activeOnTex`.
- **Tool synergy:** collapse fractures concrete → rebar exposed in the seams → rebar cutter
  snips it → pieces separate. (Concrete cutter opens holes; rebar cutter frees pieces.)
- **Finding (again):** a snipped hinge barely moves *contact-supported* neighbours (~8 cm) —
  the point is the cut, not spectacle. `verify-rebar.mjs` asserts on the break, not on motion.
- **Test-harness note:** projecting the seam to a pixel + raycasting can land off the seam
  (parallax on tilted slabs), so the automated screenshot showed grey jaws; engagement itself
  is unit-verified (green on the fracture, off at 0.9 m). Interactive hovering works fine.

## Iteration 11 — visible rebar cage on the whole structure

Feedback: "the entire structure should be reinforced concrete with rebars; I can't see any."
Rebar was only on slab tops; columns/beams had bars buried *inside* the section (offset
0.3·cross) so invisible, and beams were black steel.
- Rebar cage bars moved to the **surface corners** (offset 0.5·cross) as a **4-bar cage** per
  member, thicker (0.045), so columns and beams visibly show rebar running their length.
- **Beams are now reinforced concrete** too (rebar cage; grey, not black steel).
- Colours: columns/beams concrete grey, rebar **rust-red** (0xb04a24), slabs grey.
- Visual-only (rebar descriptors + materials); densities unchanged, so the collapse tuning
  and all headless tests still hold. Confirmed with a standing-building screenshot (look.mjs).

### 11b — rebar is a thin cylindrical GRID (corrected from fat bars)
Reference photo: rebar = a dense grid lattice of thin (~0.5–1 in) cylindrical rods in the slab.
My "2 fat boxes per tile" was wrong. Now: each slab carries a **grid of thin cylinder rods**
(`rebarSpacing` 0.32 m, radius 0.015 m) near the top face; columns/beams get 4 thin
longitudinal corner rods. Rebar descriptors are now `{x,y,z,len,r,axis}`; the renderer merges
a part's rods into one cylinder mesh (`mergeGeometries`) to keep draw calls low. Rust-red.

### 11c — rebar as an embedded skeleton with frayed ends
Rebar now sits at the slab **mid-plane** (embedded, hidden in intact concrete), denser
(spacing 0.2 m) and thinner (r 0.008 m). Rods run slightly past the tile (`rebarFray`) so
their ends **protrude at fractures and slab edges**. When the concrete cutter removes a
square, the rebar is **kept and trimmed to the hole** (`clipRebarForHole`) — rods crossing
the opening are split and extended a touch past the rim, so cut ends stick into the hole
(frayed). `onReshape` renders the trimmed rebar with the frame. Verified: intact slabs read
as solid concrete; a cut hole shows rust rebar stubs protruding from its edges.

## Iteration 12 — real engineering units + a structural model (specs.md §2–§4)

The passive collapse toy became an interactive tactical trainer. The through-line: **the numbers on
screen have to be real kN**, or shoring/lifting/buckling decisions are theatre.

### Units: g = 40 → 9.81 (and why the "feel" survived)
- Adopted **m · tonnes (Mg) · s ⇒ force in kN, stress in kPa**. Densities were already tonnes/m³
  (2.4), so the old thresholds named "N" were really kN all along — the units were *muddled*, not
  wrong. `densitySteel: 3.1` was applied to columns/beams that iteration 11 had already made
  reinforced concrete; now `densityMember: 2.5` with a real `densitySteel: 7.85` kept for rebar area.
- **Heaviness comes from restitution/damping/mass, not fake gravity.** restitution 0.38 → **0.10**
  (concrete on concrete is a dead thud). Measured: pile top 3.33 m at rest=0.10 vs **4.70 m** at
  rest=0.38 — keeping the old restitution at real g reintroduces exactly the "bouncy Lego" scatter
  iteration 3 fought. Real g alone is not what makes a collapse feel heavy.
- **Re-tuned thresholds by POSITION IN THE DISTRIBUTION, not by absolute value.** `measure.mjs` now
  has two modes because one run cannot set both kinds of threshold:
  - `mode=force` — all triggers off ⇒ true impact-force spectrum ⇒ sets the `*Force` thresholds.
  - `mode=folds` — cracking ON, tearing off ⇒ how far a cracked rebar hinge actually folds ⇒ the
    only way to set `slabTearAngle`. In force mode nothing cracks, so there are no hinges, bend
    stays ~1°, and every angle threshold looks unreachable.
- **Trap I fell into:** `measure.mjs`'s subclass overrode `_processContacts` to *record* forces and
  silently dropped the trigger logic. Force mode still looked fine (its thresholds were 1e12
  anyway) but folds mode reported "cracks formed: 0". A measurement rig that disables the thing it
  is measuring is worse than no rig. It now records *and* applies, with 1e12 doing the disabling.
- Result, seeds 1–3: cracks 10–17, tears 0–1, snaps 8–10, settled 144–153, pile 3.8–4.0 m — inside
  the envelope iteration 6 documented. `slabTearAngle` 0.7 → **0.9** (p99.9 of measured folds; my
  first guess of 0.35 sat at ~p70 and produced 15 tears instead of 1–3).
- **`beamSnapAngle` is now a near-inert backstop.** Members bend at most **0.9°** at real g. Any
  angle threshold that fires reliably would fire on solver noise. Real member failure is
  `beamSnapForce` plus the axial checks below — as iteration 4 suspected, bend was never the story.
- Impact triggers are now documented as a **numerical proxy**: a solver's peak contact force over
  one dt is far spikier than a sustained flexural load. The dimensionally honest checks live in
  `structure.js` and act on static tributary loads.

### `src/structure.js` — FrameModel (§2)
- `loadMatrix()` is the discrete form of `W = ∫(D_L + L_L) dA`. Outputs are sane on inspection:
  **6.7 kPa dead + 2.0 kPa live per bay, 199.8 kN on a ground column of a 4-storey frame.**
- **The stylized geometry is ~20× over-designed.** 0.4 m columns on a 2 m grid give a raw
  geometric capacity of ~3700 kN against ~200 kN of demand (utilization 0.05), so buckling is
  unreachable and nothing ever cascades. Capacity is therefore sized to
  `designSafetyFactor × intact service demand` (default 1.8), which is how real frames are
  proportioned; intact worst utilization comes out at **0.556 = 1/1.8**. Set it to 0 for the raw
  section. The *loads* stay honest; only the capacity is calibrated.
- **A 0.4 m × 2.6 m RC column is a SHORT column** (slenderness ≈ 45): crush governs, and Euler
  never bites until spalling is severe. That is not a bug — Euler governs steel and slender
  concrete. Both checks are implemented, and the model reports which one governs. Because a square
  section that spalls stays square, `A = A₀·s` and `I = A₀²s²/12` — so section loss collapses
  buckling capacity *quadratically*, which is exactly the spec's "damaged inertia moment".
- **Progressive collapse must concentrate load, not spread it.** Shedding a lost column's load over
  every survivor by inverse-square distance dilutes it so far that a cascade can never start. Load
  follows the **beam lines**, so it spreads over the adjacent ring only (≤1.5 bays). With that fix:
  at SF 1.8 losing one column is survived (1 failure, no cascade — real progressive-collapse
  resistance); at SF 1.15 the same single loss cascades to **9 failures**. The cascade is an
  outcome of redistribution, not a script.
- Failure profiles replace the old unconditional ground-floor wipe + 40% coin flip. `pancake` must
  gut a whole **level** — on a 3×3 grid "interior columns" is a single column, which barely moves.

### The settled pile was kinematically fake
- `freeze()` set every body to `Fixed`, which **zeroes every contact force**. Nothing bore on
  anything, so "how much weight is on this slab?" had no answer — and the stress map, lifting bags
  and shoring all need one. Now a **soft freeze**: bodies stay Dynamic and are put to *sleep*
  (cheap, and manifolds + normal impulses survive). Verified: 177/177 asleep, 145 support edges,
  113 parts with a nonzero measured contact load, total pile weight **150 t** for a 4-storey frame.
- `DebrisSupport.contactForceThrough()` is deliberately **not** the same quantity as
  `supportedLoad()`. Summing every contact on a wedged slab counts reaction pairs and penetration
  spikes and legitimately exceeded the whole pile's weight (2153 kN vs 1473 kN total). It is a
  relative "how squeezed is this" indicator (it drives the stress map). Anything that needs a real
  load — bag stall, shore sizing — uses the mass-derived `supportedLoad`.

### Lifting bags (§3.2) — a force source cannot hold a load
- First implementation followed the spec literally (capacity-clamped upward force) and **flung a
  slab 17 km**. Once the debris is raised, any force above its true weight keeps accelerating it,
  and the true weight of a contact-supported pile isn't knowable in advance.
- Second attempt inflated a collider via `setHalfExtents`. Also wrong: a resized shape has **no
  contact velocity**, so contacts are missed and then resolved as one deep overlap (|coord| ~1e6 m),
  and the measured load read 0 kN.
- What works is the spec's *other* sanctioned mechanism ("a temporary constraint"): a constant-size
  **kinematic platform that rises** via `setNextKinematicTranslation`. The solver gets a proper
  contact velocity, the debris is carried up smoothly, and the 50 cm cap is **exact geometry**
  rather than a servo target — which is what "cap rigidly at 50 cm" should mean. Force is still
  used where a force is right: the reaction into the bag's base, via `addForceAtPoint`.
- **Interface detection must be a RAY, not a proximity search.** Picking the nearest body by centre
  distance returned slabs up to 1.15 m off to the side; the bag rose past them and lifted nothing
  (measured load 0 kN). Verified end state: a 4 t bag under 92 kN of debris measures 60 kN of
  reaction and lifts **0.000 m**; a 20 t bag lifts the full 0.500 m. The stall is physical.

### Shoring (§3.3)
- **Shoring's real mechanism is OFFLOADING, not bracing.** Bracing changes `L` and `K`, which only
  helps if buckling governs — and it usually doesn't (see short columns above). A shore carries
  load the column no longer has to: `relief` cuts a ground column from 200 kN → 80 kN
  (utilization 0.56 → 0.22). Bracing is implemented too and does show up on a spalled column
  (20 → 32 kN, governing flipping buckling → crush).
- **A shore spawned overlapping debris is not a shore.** A 0.3 m stub jammed into a slab measured
  617 kN — 3× its own capacity — and "failed" instantly. Placement now ray-casts the clear height,
  refuses anything under 0.4 m, and seats the head with a **3 mm preload**: a shore built 20 mm
  short touches nothing and dutifully reports 0 kN forever. Real shores are wedged tight.
- Load readings are bounded by the weight actually available above, then smoothed (EMA), with a
  grace period — a shore is judged by where it settles, not by the take-up transient.
- **Placing a shore must wake the member it is seated under**, or the soffit stays asleep metres
  overhead and never notices the new support (0 kN forever, again).
- Timber capacity uses the same Euler/crush pair as the frame: a 0.1 m post is crush-governed at
  1.5 m (200 kN) and buckling-governed at 2.5 m (132 kN). End to end, shoring drops what a bag is
  fighting from **144 kN → 67 kN**.

### UI (§4)
- **three.js layers gate RENDERING as well as raycasting**, and a camera renders only layer 0 by
  default. Putting rebar on layer 1 and void volumes on layer 2 (so tools can filter what they
  pick) silently made **both invisible** — the rebar cage vanished from the scene and I nearly
  shipped it. `camera.layers.enable(1); camera.layers.enable(2)`.
- Stress map swaps meshes between a bank of 12 pre-built grey→red bucket materials instead of
  cloning a material per part or rewriting vertex colours every frame. Sampled every N frames
  because rebuilding the support graph walks every manifold in the pile.
- Voids are transparent boxes (opacity 0.3) per spec, **plus** `depthTest:false` edges: a void is
  buried by definition, so a depth-tested fill alone is invisible from outside the pile.
- **Rapier 0.14 exposes no joint-force readback**, so §4A's "query Rapier joint forces" is served by
  contact impulses plus the analytic model. Two other spec APIs don't exist as written:
  `applyForceAtPoint` is `addForceAtPoint(force, WORLD point, wakeUp)`, and `world.contactsWith` is
  `contactPairsWith(collider)` + `contactPair(a, b, m => m.contactImpulse(i))`.
- lil-gui sidebar is ~245 px wide; anything positioned on the right is hidden behind it. All
  readouts moved to the left column.

## Gotchas / guardrails

- **Black screen = a load-time exception, not a render bug.** Root cause once: `main.js`
  had a `gui.add(params, 'slabFractureForce')` for a param removed from `sim.js` DEFAULTS;
  **lil-gui throws on an undefined property**, killing the module before the render loop.
  Guardrail: this is now an automated test — **`node verify-params.mjs`** parses every
  `X.add(params, '…')` in main.js and asserts it resolves. Run it after any DEFAULTS change.
  (It earned its keep immediately: iteration 12 removed the now-unused `columnsRemoved`.)
- **`npm run verify`** runs the whole headless suite; **`npm run measure`** is the threshold rig;
  **`npm run shoot`** drives the browser (needs `npm run dev` in another shell).
- **A `vite build` passing does not mean the page runs.** Only the Playwright drivers
  (`shoot.mjs`, `shoot-ui.mjs`) catch load-time exceptions and invisible-geometry bugs; both fail
  the run on any `pageerror`.
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
