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

## Iteration 13 — the rebar lattice is an endo-skeleton (hidden until the concrete breaks)

Reference photos of skinned slabs settle two things iteration 11c got half-right: real RC floor
slabs are **not** one mid-plane grid, and in an intact slab you see **no steel at all**. So the
reinforcement became a 3D cage, and its visibility became an *event*, not a constant.

### The lattice (`buildSlabRebarLattice`, sim.js)
- Several planar X–Z mats **stacked through the thickness** between the cover faces, tied by a
  **vertical stirrup at every grid node** — a rectangular cage, not a plane. New params
  `rebarLayers` (4) and `rebarCover` (0.022 m); `rebarSpacing` 0.2 → **0.10 m** and rods stay at
  r = 0.008 m, i.e. ~16 mm bars at ~10 cm centres, which is a real light floor mat.
- Measured on the default 4-storey build: **609 rods per tile** (84 running X, 84 running Z,
  **441 stirrups**), 36 tiles, **21,924 slab rods / 22,548 total**. The stirrups outnumber the
  mats 2.6 : 1 — a stacked-mat count of `layers × 2(n+1)` is the *small* term, and doubling
  `rebarLayers` costs far less than halving `rebarSpacing` (stirrups go as n²).
- Still **visual-only**: rods are descriptors carried by the part and merged into one child mesh,
  so physics is untouched. Confirmed unchanged post-collapse: 10 cracks, 7 snaps, 0 tears, 177
  parts settled — inside the iteration 6/12 envelope, and all seven headless suites pass.
- Cylinders dropped 8 → **6 radial segments**: 40 verts/rod instead of 52 (measured), ~23% off a
  budget that is now ~880k verts of rebar across 36 merged meshes. Draw calls are unaffected —
  one merged mesh per part is what makes a 600-rod cage affordable at all.

### Exposure: `onExpose` (a fifth sim → renderer callback)
- Rebar meshes are built **hidden** (`visible = false`) and revealed only when the concrete
  actually opens: a tie **cracks**, a joint **snaps or tears**, the cutter opens a **hole**, the
  saw **slices** a tile, or the hammer **spalls** a face. `_exposeRebar(part)` is idempotent and
  fires `onExpose` once per part. Measured: **0 of 204 parts exposed at build; 30 of 177 after a
  collapse** — the pile shows steel exactly at its fractures.
- The renderer answer to "how do you see a cage inside a solid box" is a **skinned concrete**
  material — same grey, `transparent` at opacity 0.65–0.70 with `depthWrite` left **on**. The
  rebar child is opaque, so it draws in the opaque pass *before* the shell and reads through it;
  keeping depth-write means skinned pieces still occlude the pile behind them properly.
- Rebar tint went 0xb04a24 → **0x904428** with lower metalness. At 600 rods/tile the old rust was
  a solid red wash at any distance; the frame has to stay grey concrete with steel *inside* it.
- `onExpose` swaps materials only — no mesh rebuild — and re-applies through the stress map, so
  exposing a part mid-collapse doesn't fight the grey→red bucket materials.

### The plug used to fall as plain concrete
- `clipRebarForHole` trimmed the slab's rods to the hole rim (frayed ends, iteration 11c) but the
  **cut-out square itself** got none of them. New `extractRebarForHole` is its exact inverse: the
  rod segments *inside* the footprint, recentred into the plug's local frame, handed to the
  spawned fragment — which is then exposed, so a plug reads as a chunk of RC with its cage
  showing rather than a grey block.
- `clipRebarForHole` also learned about stirrups: an `axis:'y'` rod inside the hole footprint
  leaves with the plug instead of hanging in the opening.

### Guardrail
- Rebar now has **two** independent reasons to be invisible: the layer-1 camera trap from
  iteration 12, and `rebarExposed` being false. Before debugging a missing cage, check which —
  "no steel on an intact building" is now the correct behaviour.

## Iteration 14 — poor-site concrete, splinters, dust, and lattice tuning

Driven by USAR feedback and on-site reality: **most builders skimp on cement**, slabs splinter
and spall more than the nominal-mix defaults suggested, and a collapse throws up a **cement-dust
haze**. The sim now treats weak mix as the default, not an edge case.

### Rebar lattice specs (user-facing RC defaults)
Iteration 13's cage was retuned to match real light-floor reinforcement rather than a dense
research grid:
- **`rebarLayers` 4 → 2** — top + bottom mat only (still tunable 1–6 in GUI).
- **`rebarCover` 0.040 m** — each mat sits 40 mm in from the slab's major (top/bottom) face.
- **`rebarSpacing` 0.30 m** — 300 mm square grid pitch (~7×7 lines per ~2 m tile).
- Rod radius stays **0.008 m** (~16 mm bars). GUI folder renamed **"Rebar lattice"** with
  spacing range 0.15–0.50 m and **"cover from face (m)"**.

At these defaults a tile carries far fewer rods than iteration 13's 609/tile figure — the cage
reads as a real mat, not a solid red mesh.

### Skinned concrete — fixing the "red wash"
First skinned build made the whole pile look like rust: rebar drew through translucent shells
at ~36% opacity while **every** slab was mass-exposed on `collapse()`, and rebar child meshes
were always visible under opaque concrete until exposure fired.

Fixes:
- Rebar meshes stay **`visible = false`** until `_exposeRebar` / `onExpose`.
- Skinned opacity **0.36 → 0.65–0.70**, `depthWrite: true` — grey concrete dominates, steel
  is a hint inside fractures.
- Removed mass slab expose on `collapse()`; steel appears at **cracks, snaps, cuts, spalls**
  only (measured ~30/177 parts exposed post-collapse, not 36/36 tiles).
- Rebar tint **0x904428**, lower metalness — at high rod counts the old rust read as a surface.

### Poor-site concrete is now the DEFAULT
No separate "cement:sand ratio" param — **`concreteFc` (17 MPa)** is the single engineering
proxy for under-cemented, high-sand site mix. Nominal design mix is **25 MPa** (`concreteFcRef`,
used only for dust/spall scaling).

| Param | Nominal (iter 12) | Default now |
|-------|-------------------|-------------|
| `concreteFc` | 25 MPa | **17 MPa** |
| `beamSegments` / `colSegments` | 3 / 3 | **6 / 5** |
| `maxBreaksPerMember` | 1 | **2** (up to 3 lengths per member) |
| `beamSnapForce` | 1150 kN | **950 kN** |
| `spallOnCut` | 0.35 | **0.48** |

Measured on seed 1: **~39 member snaps** vs ~7 at nominal mix; **~270–280 settled parts** vs
~177 (more segments + splinter geometry). Collapse still passes `verify.mjs` (no explosion,
buried voids). Weaker `f'c` makes crush govern sooner in `FrameModel` — columns fail earlier in
the cascade, which matches the intended "skimped mix" story.

### Splintering (visual-only cement chips)
Beam/column snaps spawn **`splinterChips` (2)** grey fragment boxes at the joint mid-point.
They are **not Rapier bodies** — early attempts with dynamic or fixed physics fragments either
**exploded the solver** (|coord| ~10⁶–10⁷ m under lifting bags) or **inflated `DebrisSupport`**
readings (9000+ kN carrying). Final design:

- `sim._spawnSplinters(rec)` → **`onSplinter(chips, parentPart)`** callback.
- Renderer parents each chip to **`rec.a`'s mesh** in local coordinates so chips **move with the
  broken segment** instead of hanging at the old world-space fracture point.
- **`splinterOnCrack: 0`** — slab seam chips off by default (beam/column snaps are where
  splintering reads); turning it on spammed chips that confused bag interface rays.

### Cement-dust cloud (renderer-only)
Dust is not a material property — it is impact energy dissolving into fines. Implemented as:

- **`sim.dustQueue`** + `drainDustEvents()` — physics emits `{x,y,z,count,spread}`; renderer
  never touches Rapier for dust.
- **`spawnDustCloud`** — up to 2500 billboard `Points`, brown-grey, 2.5–5 s lifetime, light
  gravity + drag.
- **Burst on `collapse()`** — `dustCollapseBurst` (100) × `concreteFcRef / concreteFc`
  (~1.47× at default weak mix).
- **Puffs on hard contacts** — force > `dustContactForce` (350 kN), scaled the same way.
- **Fog tightens** while `phase === 'collapsing'` (near 18 m / far 72 m vs 28 / 88 standing).

Weak mix ⇒ more dust for the same impact, without a separate "cement ratio" slider.

### Flying bricks frozen in mid-air
Two bugs, one screenshot:

1. **Furniture + loose segments** — soft-freeze slept every dynamic body wherever it was,
   including brown furniture boxes and grey beam chunks still falling. **`freeze()` now runs
   `_settleAirborne()`** first: raycast downward from each piece's bottom; if no support within
   ~22 cm, wake it and step physics (up to ~300 frames). Anything still floating is **`_removePart`**
   (stray debris that would never land cleanly in the settle window).
2. **Splinter chips at old snap positions** — fixed by parenting chips to the broken part (above).

Press **P** rebuild / **C** collapse after pulling; **F** re-freeze runs the airborne pass again.

### Rescue / headless notes
- **`placeBag`** skips **`kind === 'fragment'`** hits when ray-finding the lift target (hole plugs
  are real fragments; splinter chips no longer are).
- Dynamic splinter experiments broke **`verify-lift.mjs`** intermittently; visual-only splinters
  restored stability. Full **`npm run verify`** should be re-run after lattice/splinter changes.

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
- ~~Concrete **cover-spall** so steel is exposed "by cutting", per the photos.~~ Done in
  iteration 13 — the hammer spalls a face and `onExpose` skins the concrete over the cage.
- Perf: ~150–280 bodies during collapse (weak-mix defaults + extra segments); watch frame rate
  as `grid`/`stories` grow. Dust particles capped at 2500; rebar rod count scales with
  `rebarSpacing`² via stirrups.

### Golden grail — rescuer / victim access (void “reaching”)

**Deferred design call (2026-07-31):** void markers are now a faint spherical wireframe hint
only; we track detected + compromised counts. “Reaching a void” is *not* camera/tool proximity —
it means a **human rescuer accessing a victim** inside a survivable pocket.

**Shipped (2026-07-31 → 2026-08-01) — rescuer agent + camera + stability:**

- **Appearance:** procedural Civil Defence humanoid (`src/rescuer-mesh.js`) — orange tee with
  canvas “CIVIL DEFENCE” text, digi-camo trousers, red helmet, black ammo boots. Physics is a
  Rapier capsule (`src/rescuer.js` + `rescuer-constants.js`); no GLTF.
- **Control:** `R` spawns / toggles rescuer mode; WASD walk (camera-relative), Space jump,
  `E` pull-up or mount ladder. Extension ladder is equipment key `8`.
- **Camera:** default **3rd-person shoulder** with OrbitControls pan / zoom / tilt (target
  follows the rescuer). `T` (or GUI “Rescuer view”) switches to **1st-person eyes** with look
  + scroll zoom. Do not overwrite `camera.position` every frame in 3rd-person — that jammed
  the view into debris and fought WASD.
- **Grounding:** sim ground is a fixed Rapier body (not a parentless collider). Spawn
  `snapToGround()` plants feet on y≈0; softer KCC ground bias to avoid W-key vertical
  oscillation against rubble.
- **Rebuild:** clear the rescuer **before** `sim.dispose()` — disposing the world first left
  `removeCollider` on freed WASM memory and crashed rebuild (P).
- **Loads / settle:** walk must not bulk-`_wakeNear` every tick (that froze→woke→collapsed in
  a loop and hung the browser). Mantle may still one-shot wake. Live-load capacity refresh is
  throttled. `doFreeze` defers if `world.step()` is in flight (Rapier aliasing).
- **Victims:** prone figures at void centres after freeze; `VICTIM_ACCESSED` when the rescuer
  reaches one whose void is not compromised. Agents / ladders / victims are excluded from the
  intrusion AABB test (only debris compromises).
- **Verify:** `verify-rescuer.mjs` (wired into `npm run verify`); Playwright `shoot-ui` /
  hang checks used while debugging.

Still open: multi-rescuer teams, victim physiology beyond accessed/lost, climb animations / IK,
and tightening locomotion to real USAR movement limits (next).

**Next :** we will now establish the constraints for the rescuer’s locomotion.
- Rescuer cannot walk through rubble. Two solid bodies cannot occupy the same space. If he collides with a body, give a light audio signal like a man hitting concrete with his trunk or feet.
- If jumping (space) lands him on a solid object not more than 1 metre high at the point of landing, land him there (a few cm in front and upto 1 m high). But the maximum vertical incline of the plane at the point should not be more than 30 degrees, or else he slides back.
- If jumping brings his raised hands within reach of an edge , which is upto 7 m in height from where he jumps, he will grab the edge and pull himself up. Again, the max vertical incline should be respected. or slippage will occur

**Implemented (2026-08-01) — locomotion constraints above:**

- **Solid collision:** Rapier KCC already rejects interpenetration. Horizontal wish largely blocked by a
  near-vertical hit → `RESCUER_BUMP` + `playBodyBump()` (soft trunk/boot thud).
- **Jump land ≤ 1 m:** takeoff feet stored on Space; on touchdown, rise and surface slope (≤30°) are
  checked. Fail → slide-back toward takeoff + status. Pass → plant a few cm forward.
- **Jump grab ≤ 7 m:** while airborne, multi-height face probes find an edge (a single hand-height
  ray flies over the deck); slope ≤30° required or `RESCUER_GRAB_FAIL` (slip). Success starts the
  existing mantle pull-up. Standing `E` uses the same slope/height rules. KCC max climb slope set
  to 30° to match. Standing-jump apex ~0.75 m → hands reach ~2.9 m from takeoff; 7 m is the cap for
  jumps from raised perches.
- Constants live in `src/rescuer.js` (`MAX_JUMP_LAND_H`, `MAX_GRAB_H`, `MAX_SLOPE_DEG`, …).

**Fix (2026-08-01) — Casper / spawn bounce:** soft-frozen piles skip `world.step()`, so the Rapier
query pipeline went stale after kinematic `setTranslation`. KCC then saw no solids → walk-through
debris + gravity/snap oscillation through slabs. Fix: `propagateModifiedBodyPositionsToColliders` +
`updateSceneQueries` on every pose / KCC move; latch grounded in `snapToGround`; ignore Space until
`locoReady`. Verify covers frozen (no-step) wall blocking.

**Fix (2026-08-01) — floating solids after freeze:** `_isAirborne` had dropped `excludeCollider`
(Rapier aliasing workaround) and was self-hitting, so floaters held by fixed joints never dropped.
Now excludes `part.body`, casts from under the AABB, detaches joints on still-airborne pieces during
`_settleAirborne`, and multi-pass culls leftovers.

**Fix (2026-08-01) — tip / friction / remaining floaters:** soft-freeze was sleeping pieces mid-tip
and mid-slip (furniture on a corner, slabs with ~30 cm air). Now:

- Multi-point support from the *lowest* box corners; one-corner “balance” counts as unsettled
  (CoG torque must tip it).
- Longer airborne settle + `_stabilizePile` (keep stepping while unsupported or still moving) before
  sleep; refuse to sleep unsettled leftovers (cull instead).
- Coulomb friction μ=0.65 concrete / 0.35 furniture, Min combine; lower linear/angular damping so
  slip and tip can finish. Lean-to slabs at steep angles are kept (valid USAR) — we do not cull
  merely for world-tilt.

**Reverted + replaced (2026-08-01) — contact-based equilibrium.** The settle/stabilize/cull surgery
above was the wrong cure and caused the two-stage collapse: `freeze()` was re-simulating for up to
600 frames, breaking ~100 rebar ties and deleting 36–57 pieces, so the pile visibly moved a second
time after it had already come to rest. Its support test was also wrong for rubble — downward
raycasts from the lowest corners cannot see the wedged and leaning faces that carry most of a pile,
so it condemned pieces that were properly supported. All of it is gone.

*Freeze is now inert:* zero the velocities, `sleep()`, rebuild support. Nothing moves, no tie
breaks, nothing is deleted (asserted in `verify-equilibrium.mjs`). `setCanSleep(false)` was removed
too: every structural piece is built `fixed:true` and only turns dynamic in `collapse()`, so the
guard never applied to them anyway — and a body created with `canSleep=false` *ignores* `sleep()`,
which quietly broke the soft freeze. Damping is back to 0.08 / 0.30.

*Equilibrium is decided from contacts, not rays* (`_equilibriumOf`). For each piece at rest we read
Rapier's narrow phase — contact points, normals, solver impulses — and classify it:

| state | meaning |
| --- | --- |
| `unsupported` | nothing transmits force to it and no rebar holds it: it is floating |
| `hanging` | no contact carries it; a tie does. Real for a panel off the pile edge |
| `wedged` | held by side friction (arching). Σ μ·N must cover the weight, else `unsupported` |
| `loaded` | tied, or surcharged by debris above — forces we cannot see, so no free-body test |
| `tipping` | free-standing, CoG outside the load-bearing footprint (support polygon, XZ hull) |
| `slipping` | free-standing on a plane steeper than atan(μ) — the block-on-an-incline condition |

Two Rapier details cost a while to find: contact points are in each collider's **local** frame and
the manifold keeps its own collider order (`flipped` says ours is the second), and impulses are
indexed by **contact**, not by solver contact — `numSolverContacts()` is routinely smaller than
`numContacts()`, so iterating the solver list silently drops the strongest support contacts and
made well-supported beams read as tipping.

*Nothing is culled or kicked.* Pieces that fail get `wakeUp()` during the collapse — sleeping bodies
keep their manifolds, so a piece that dozed off balanced on a corner is caught and tips on its own.
Capped at 3 attempts per piece: if the solver truly holds it, shaking it again is theatre.

*Rest is drift, not velocity.* The 184–248 rebar ties keep a settled pile buzzing for ever (only
34/198 bodies ever sleep, p90 speed ~0.06 m/s at t=24 s), but over 4 s the worst piece moves 2.7 cm.
So a piece is at rest when it has not gone anywhere in half a second. `main.js` freezes on
`sim.isSettled()` rather than on the stopwatch alone (cap 2× `settleSeconds`), which is what stops
pieces being frozen mid-fall.

*Limits.* One pass per frame clamps debris to 25 m/s / 25 rad/s and deletes anything below
y = −1.5 m. A fragment pinched between a lifting bag and the slab it is jacking was picking up a
penetration-recovery velocity of 2600 m/s and falling through the floor for ever, dragging the
scene's coordinates to 10⁷ m; nothing in a three-storey collapse falls faster than ~20 m/s.

Result on seed 2 (198 pieces): `unsupported 0`, `failing 0`, `moving 0`, ~26 `hanging` on rebar, of
which only 2–3 have real air beneath them. Freeze moves nothing (max 0.000000 m). The frozen census
is on `sim.equilibrium` and in the HUD status line.

**Follow-up (2026-08-01) — ties that yield under sustained load.** The gap left above: rebar ties
only tore by **folding** past `slabTearAngle`, so a *steady* pull never broke one and a slab could
hang rigidly in mid-air on a single tie for ever, with no sag at all. A fixed joint does not care
how hard it is pulled.

`_yieldTiesOf` adds the missing check. Gravity acts through the centre of gravity, so a tie offset
horizontally from it carries the weight as **bending**: `M = share × lever`. Past the seam's
cracking moment the weld is replaced by a revolute hinge and the piece rotates down; past the bars'
tensile capacity (`_tieBarCapacity`, from bar count × area × `steelFy`) it separates outright. Only
pieces already judged at rest are evaluated, so this never fires mid-collapse.

Two corrections were needed before it did anything useful:

- *Surcharge counts.* The first version only ran on `hanging` pieces — which by definition have
  **zero** contacts, so debris resting on them could never enter the demand. The case that matters
  is a tie-borne piece with a slab lying across it, which classified as `loaded` and was skipped
  entirely. `_equilibriumOf` now reports `tieBorne` + `surcharge` (downward contact impulse ÷ dt,
  less what the pile still gives back) and the check runs on both. Yields per collapse: 0 → ~22.
- *Plain concrete is derated.* The mean modulus of rupture is optimistic for a seam that has just
  been through a collapse: unreinforced flexure is brittle and scatters badly, which is why ACI 318
  uses φ ≈ 0.60 for it. `plainConcretePhi` (0.6) applies that. Yields ~22 → ~37.

Effect across seeds 2/7/13/21/34: pieces with real air beneath them (>0.2 m, measured by ray from
the centre) drop from **6–8 to 2–4**, and the survivors are mostly slabs on 2–3 ties, i.e. genuinely
*spanning* a void between two anchors — which is what a floor slab does for a living and should not
be deleted. The single-tie leftovers are short columns and beams hanging vertically (lever ≈ 0, so
pure tension, which the bars easily hold — the classic dangling-column image). `unsupported` stays
0. New counter `stats.yields` separates these from impact-driven `cracks` / `snaps`.

**`verify-shore` (2026-08-01).** Both failures were test bugs, not physics:

- “bracing raises P_cr” read `after.governing`, but that object stores the key as `gov`, so it was
  always `undefined`. The assertion itself is now “bracing helps, *unless* crushing already
  governs”: at `concreteFc` 17 MPa the braced column is crush-governed at 32 kN, and demanding a
  further 1.5× would be demanding that timber add concrete section.
- “shoring rescues the lift” bagged the single heaviest slab in the pile — 80 kN against a 39 kN
  bag, where no realistic shoring bridges the gap. It now picks the *lightest* slab that still
  stalls the bag. The assertion also judged `bag.lift`, which is bag **growth**, not debris
  movement; but the slab's own rise is not conclusive either, because placing a bag wakes the
  surrounding rubble and the slab drifts ~0.12 m even with a bag that never inflates. Both readings
  now have to agree: the bag could not grow at all unaided, and after shoring it grows >5 cm *and*
  the slab ends up higher than it did unaided.

Also fixed in `rescue.js`: `_assessBag` recomputed `stalled` every frame from the support-graph
estimate alone, clobbering the contact-measured value that actually gates inflation — the HUD could
read “not stalled” for a bag measuring twice its rating that had not moved a millimetre. Both sites
now use the same test.

**Fix (2026-08-01) — the rescuer was an 80-tonne man.** Reported as: jumping against an inclined
slab knocks it flying, though the slab outweighs him by orders of magnitude and is not precariously
perched. `setCharacterMass(80)` — commented “kg”. **sim.js works in tonnes (Mg) throughout**, so
that made the KCC treat the rescuer as 80 000 kg. Measured: walking into a free-standing **31 t**
block shoved it **6.94 m at 4.16 m/s**. At a correct body mass the same walk moves it **11 mm** and
it never gets moving. Character mass is now derived from `opts.rescuerLoad / gravity` (1.2 kN → 0.122 t)
so it cannot drift from the live load the frame model already books for a rescuer; `RESCUER_MASS_T`
in `rescuer-constants.js` is the fallback, spelled in tonnes with a warning.

*This is the same class of bug worth watching for elsewhere:* every mass, force and stress in this
project is Mg / kN / kPa, so any figure that looks right in SI is wrong here by 1000.

A **second, independent** mechanism turned up while measuring this, and is **deliberately kept**.
On a frozen pile `step()` returns immediately, so walking moves literally nothing (0 pieces,
verified). But a jump that finds a ledge starts a mantle, and `_tryMantle` sets
`sim.phase = 'collapsing'` for the WHOLE pile: one mantle re-animates all 198 pieces and **108–116
of them shift >5 cm** as they re-settle — worst 0.93 m (seed 2), and 4.17 m on a 0.2 t fragment
(seed 7). The mass fix cut that worst case from 4.70 m, but cannot remove the effect itself.

Decision: a rescuer hauling his weight onto rubble and shifting the pile is realistic, and this is
the training point — so it stays. Note the constraint if it is ever revisited: `_wakeNear` alone
cannot achieve a *local* wake, because a frozen sim does not step at all, so waking anything
requires the global phase flip. Doing it properly would mean letting a soft-frozen pile step
whenever any body is awake (an all-asleep pile cannot move, and sleeping bodies are nearly free in
Rapier) — but an earlier attempt at per-tick waking produced a freeze→wake→collapse loop that hung
the browser, so that path needs care.

**Rescuer ↔ equipment coupling (2026-08-01).** Tools used to float free of the man: any of them
could be applied by mouse raycast anywhere the camera could see, with no rescuer on site and no
range limit. The cutter is the first tool switched to rescuer-relative working; the others keep
free aim until their turn (`equipment.js` `needsReach`).

*Gate.* Equipment selection (keys 1–7, tool ring, lil-gui dropdown) is locked until a rescuer is
spawned (`R`). Clearing him or rebuilding drops the selection to None and greys the ring again.

*Carry.* Selecting a tool clips a procedural prop (`src/tool-mesh.js`) into his right fist; the arm
aims at the work point when it is inside the envelope. In first person (`T`) the body mesh is
hidden and a camera-parented forearm + tool viewmodel takes its place — you see the hand and the
machine, and look ahead. Over the shoulder the real arm holds the real prop.

*Reach.* `src/rescuer-reach.js` is pure geometry (no three.js / Rapier): a sphere of radius
`ARM_REACH + toolLength` centred on the right shoulder, plus a ±60° forward cone measured from the
torso axis (not the offset shoulder — that wrongly refused points straight overhead). The player
must walk him to the work face with WASD; there is no auto-walk. The envelope agrees with
`HAND_REACH = 2.15 m` in `rescuer.js` so a tool cannot touch what a bare hand could not.
`verify-reach.mjs` covers this; `shoot-tooling.mjs` drives the wiring in a browser.

*Cut plane.* There is no separate `wall` part kind — a wall is a `slab` tile standing on edge.
`sim.cutHoleInSlab` always bores through the tile's thickness, so a floor face gives a
near-horizontal opening and a leaning face a near-vertical one. The status line names which.
Aim must be square-on to a broad face (not the thin edge). On apply he yaws to face the spot.

*No floating blade.* The old disc-cutter sprite that followed the mouse is gone. Aim with the
mouse, right-click an eligible spot, and the cut fires. The only on-screen tell left for the
cutter is the green/amber square hole footprint on the tile (green = right-click will cut).

**Saw retired from the roster (2026-08-01).** Concrete saw stays in `EQUIPMENT` as a vestige
(`available: false`) — `sliceSlab`, the disc mesh, and the apply path remain so a future
"slice like butter" tool can reuse them — but it is stripped from the tool ring, lil-gui
dropdown, and hotkeys. Keys renumbered: 1 cutter, 2 rebar, 3 torch, 4 hammer, 5 bag, 6 shore,
7 ladder.

**Rebar cutter ↔ rescuer (2026-08-01).** Second tool switched to rescuer-relative working
(`needsReach: true`). Long pliers with short blades (`tool-mesh.js` `buildPliers`): twin
handles, hydraulic head, stubby mouth. Aim snaps to the nearest cracked-tie seam inside the
mouth (`params.cutReach` ~0.55 m); a green/amber crosshair marks the bar. He must walk to the
fracture — out of reach refuses with the same envelope as the cutter; on snip he faces the
seam. Rod diameter unchanged (~16 mm / `rebarThickness` 0.008 m radius).

**Retarget — snip visible rods, not invisible seams (2026-08-01).** The player-facing target is
any exposed rust-red rod in his vicinity: the cage left in a cut hole, bars protruding from a
fractured edge, lattice through skinned cover. Raycast is restricted to the rebar layer; a
green/amber crosshair sits on the rod under the cursor. `sim.cutRebar` severs that rod
descriptor into stubs (`onRebarChange` rebuilds the mesh) and, if a cracked-tie hinge is also
within reach, breaks it so fractured pieces can separate. Status no longer says "hover a
fracture between slab pieces".

**Demolition hammer (2026-08-01).** Replaced the one-shot "spall" sledge with an electric
breaker. Hold right-click: `sim.chipBreach` widens and deepens a circular pocket each chip;
rebar is exposed but never clipped. Once depth reaches the tile thickness the colliders open
a through-hole (ingress / camera drop) with the lattice still spanning — clear it with the
rebar cutter. Rhythmic hammer SFX for the whole mouse-down (`startHammer` / `stopHammer`).
`needsReach: true`; prop is a motor body + chisel bit. Columns still fall back to `spallAt`.

**Loose rebar falls (2026-08-01).** After a snip, rods (or a connected cage island) that no
longer reach any concrete-anchored bar — e.g. a segment cut free on both sides inside a
hammered opening — are removed from the parent mesh and spawned as dynamic debris
(`_dropLooseRebar` / `_spawnRebarDebris`). Snip gap breaks lattice adjacency so stubs across
a cut do not stay welded. `verify-rebar-fall.mjs` covers this.

**Victim placement + USAR score (2026-08-02).**

- **No floating victims:** `detectVoids` stores `floorY`; prone figures sit on the pocket floor
  (`floorY + 0.07`), not at the void midpoint.
- **No void wireframes:** cyan sphere markers / `V` toggle removed. Voids remain as invisible
  AABB targets for spawn + intrusion. HUD shows **USAR score** instead of void counts.
- **+1 reach:** rescuer must pass through a registered cutter hole or through hammer breach
  (`sim.openings` / `openingIngressAt`), unlocking nearby victims, then get within
  `ACCESS_RADIUS`. Proximity alone no longer scores.
- **−1 ops-compromise:** `sim.compromiseAttribution` is set when a rescue tool wakes debris.
  Later `SURVIVOR_COMPROMISED` events increment `rescuerCompromised` (and the score); pre-tool
  crush still paints the victim lost but does not change score.
- **Hole drop ≤ 2.5 m:** `_resolveJumpLanding` rejects drops deeper than `MAX_HOLE_DROP`
  (`too_deep`).

**TODO — rappelling** for voids deeper than 2.5 m.

**TODO — telescopic camera** the rescuer can drop into a void to probe when the pocket is not
fully visible from outside.

**Confined victims only (2026-08-02).** Open / walkable voids still detect for compromise AABBs,
but survivors spawn only in **confined** pockets: ≥6/8 lateral solid hits within 1 m at torso
height, and not an exposed rooftop deck (`voidRooftopMaxClear`). Status reports
`N voids · M confined` and refuses to place walk-up victims. Ingress scoring unchanged.

**Hole slide + crouch (2026-08-02).** Stepping onto a **passable** opening (concrete-cutter hole,
or hammer through-breach with spanning rebar cleared) slides the rescuer down (`HOLE_SLIDE`,
still capped at 2.5 m). Hold **Shift** or **Z** to crouch: capsule shrinks to ~0.88 m
(`CROUCH_HALF` / `CROUCH_RADIUS`) so he can crawl into low voids; crawl speed ~0.95 m/s.
Standing blocked under low overhead emits `RESCUER_CROUCH_BLOCKED`. (Ctrl was dropped — it
steals Ctrl+W/A/S/D from the browser.) Human scale is correct
(~1.68 m vs 2.6 m stories); they look large vs 0.6 m cutter holes by design.

**Next — expand reach gating to the remaining tools one at a time** (torch, bag, shore;
ladder already mounts via `E`). Flip `needsReach: true` and harden each tool's eligibility.

