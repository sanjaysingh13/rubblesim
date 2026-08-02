// Rescue-equipment registry (framework-agnostic; no three.js).
// Tools act on the settled rubble at a chosen 3D point via the physics core (src/sim.js) and the
// rescue-ops layer (src/rescue.js). specs.md §4B wants a single global active-tool enum driving
// both the HUD ring and the raycaster's layer filtering, so `id` IS that enum and every tool
// declares what it is allowed to hit:
//
//   picks: 'concrete' — only structural concrete geometry (raycast layer 0)
//          'rebar'    — only exposed reinforcement (raycast layer 1); pliers only, not the torch
//          'gap'      — an interface / floor position rather than a surface (bags, shoring)
//          Oxy-acetylene picks 'concrete' so it can aim at beam faces and melt member joints.
//
// `kind` tells the renderer which cursor / prop to draw.
//
// RESCUER COUPLING (DEVLOG 2026-08-01)
// ------------------------------------
// Tools used to float free of the man: any of them could be applied anywhere the camera could see,
// with no rescuer on site. Two fields tie them back to a body:
//
//   toolLength — metres from the fist to the working edge. Added to the rescuer's arm to get his
//                working radius, and used by src/rescuer-mesh.js to size the prop he carries.
//   needsReach — when true the tool only fires where the rescuer can actually stand and touch:
//                inside the reach sphere of src/rescuer-reach.js and inside his working cone.
//                We are switching the tools over ONE AT A TIME (see the DEVLOG); everything still
//                marked false keeps the old free-aim behaviour until its turn comes.
//
//   available  — when false the tool is a VESTIGE: its apply() / mesh / sim path stay in the
//                codebase so we can revive them later, but they are stripped from the tool ring,
//                the lil-gui dropdown, and the 1–N hotkeys. Concrete saw is the first (and so
//                far only) vestige — nothing in the field can slice a slab like butter yet.
//
// Every available tool is carried in the right hand once selected — that part is not staged,
// because a rescuer must now be spawned before the equipment ring unlocks at all.

export const TOOL_NONE = 'NONE';

export const EQUIPMENT = [
  {
    id: 'CONCRETE_CUTTER', label: 'Concrete cutter', short: 'Cutter', kind: 'hole', picks: 'concrete', key: '1',
    hint: 'Cut a square hole in a slab — the plug drops into the void below.',
    holeSize: 0.6,        // default square side (m)
    toolLength: 0.45,     // petrol cut-off saw: body + 300 mm blade beyond the grip
    needsReach: true,     // first tool switched to rescuer-relative working (DEVLOG 2026-08-01)
    available: true,
    // completion handled by main.js -> sim.cutHoleInSlab (removes plug, leaves a hole)
  },
  // VESTIGE — kept so a future "slice a slab like butter" tool can reuse sliceSlab + the disc
  // mesh. Stripped from every player-facing interface (`available: false`).
  {
    id: 'CONCRETE_SAW', label: 'Concrete saw', short: 'Saw', kind: 'slice', picks: 'concrete', key: null,
    hint: 'Slice a slab clean through — it splits into two bodies that keep their momentum.',
    toolLength: 0.45, needsReach: false, available: false,
    apply(sim, { part, local, axis }) {
      if (!part || part.kind !== 'slab') return { severed: 0, points: [] };
      const res = sim.sliceSlab(part, axis, axis === 'x' ? local.x : local.z);
      if (!res || !res.spawned) return { severed: 0, points: [] };
      const t = res.spawned.body.translation();
      return { severed: 1, points: [{ x: t.x, y: t.y, z: t.z }], spawned: res.spawned };
    },
  },
  {
    // Hydraulic snips: long handles, short blades. Cuts the exposed rebar (cracked tie hinge)
    // bridging a fracture between two slab pieces — the mouth is short (~0.55 m), so he has to
    // walk right up to the seam. Second tool switched to rescuer-relative working.
    id: 'REBAR_CUTTER', label: 'Rebar cutter', short: 'Rebar', kind: 'rebar', picks: 'rebar', reach: 0.55, key: '2',
    hint: 'Long pliers, short blades: snip any exposed red rod in reach (hole cage, frayed edge, fracture).',
    toolLength: 0.70,     // long handles — fist to blade tips
    needsReach: true,
    available: true,
    apply(sim, { point }) { return sim.cutRebar(point, this.reach); },
  },
  {
    // Oxy-acetylene: melts steel beam joints (not slab ties / columns). Heat conducts ±heatAlong
    // metres along the beam; victims within heatClearance of that heated segment burn (ops −1).
    id: 'TORCH', label: 'Oxy-acetylene torch', short: 'Oxy', kind: 'torch', picks: 'concrete',
    reach: 0.8, key: '3',
    heatAlong: 2.0,       // m either side of the cut along the beam axis
    heatClearance: 0.5,   // m clearance to the heated steel (not a free-air sphere)
    hint: 'Melt through a steel beam joint. Heat travels ±2 m along the beam — check for victims below.',
    toolLength: 0.40, needsReach: false, available: true,
    apply(sim, { point }) { return sim.cutBeamNear(point, this.reach); },
  },
  {
    // Electric demolition hammer (breaker): hold RMB to chip a widening, deepening circular
    // breach. Rebar is exposed but left intact so the snips can clear the opening afterward.
    id: 'BREACHING_HAMMER', label: 'Demolition hammer', short: 'Hammer', kind: 'hammer', picks: 'concrete', reach: 0.6, key: '4',
    hint: 'Hold right-click: chips a widening, deepening hole. Rebar stays — clear it with the rebar cutter.',
    toolLength: 0.75,     // body + chisel bit beyond the grip
    needsReach: true,
    available: true,
    holdToUse: true,      // main.js: chip on an interval while RMB is down, not one-shot
  },
  {
    id: 'LIFT_BAG', label: 'Lifting bag', short: 'Bag', kind: 'bag', picks: 'gap', key: '5',
    hint: 'Place at an interface and inflate. Stalls if the debris outweighs its rating.',
    toolLength: 0.25, needsReach: false, available: true,
    apply(sim, { point, bagId }) {
      const bag = sim.rescue.placeBag(point, bagId || 'bag10t');
      return { severed: bag ? 1 : 0, points: bag ? [point] : [], bag };
    },
  },
  {
    id: 'SHORE', label: 'Shoring', short: 'Shore', kind: 'shore', picks: 'gap', key: '6',
    hint: 'Erect a T-shore or lace shore to carry load before you lift.',
    toolLength: 0.90, needsReach: false, available: true,
    apply(sim, { point, shoreId }) {
      const shore = sim.rescue.placeShore({ x: point.x, y: 0, z: point.z }, shoreId || 'tShore');
      return { severed: shore ? 1 : 0, points: shore ? [point] : [], shore };
    },
  },
  {
    id: 'LADDER', label: 'Extension ladder', short: 'Ladder', kind: 'ladder', picks: 'concrete', key: '7',
    hint: 'Lean a ladder against a wall or slab face when a pull-up is not enough. Mount with E in rescuer mode.',
    toolLength: 1.10, needsReach: false, available: true,
    apply(sim, { point }) {
      const ladder = sim.rescue.placeLadder(point);
      return { severed: ladder ? 1 : 0, points: ladder ? [point] : [], ladder };
    },
  },
];

/** Tools the player can actually pick — vestiges (available: false) are filtered out. */
export const AVAILABLE_EQUIPMENT = EQUIPMENT.filter((e) => e.available !== false);

export const equipmentById = (id) => EQUIPMENT.find((e) => e.id === id) || null;
export const equipmentByLabel = (label) => EQUIPMENT.find((e) => e.label === label) || null;
// Dropdown / ring labels only list tools that are on the roster.
export const TOOL_LABELS = ['None', ...AVAILABLE_EQUIPMENT.map((e) => e.label)];
