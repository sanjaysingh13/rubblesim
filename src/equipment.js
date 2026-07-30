// Rescue-equipment registry (framework-agnostic; no three.js).
// Tools act on the settled rubble at a chosen 3D point via the physics core (src/sim.js) and the
// rescue-ops layer (src/rescue.js). specs.md §4B wants a single global active-tool enum driving
// both the HUD ring and the raycaster's layer filtering, so `id` IS that enum and every tool
// declares what it is allowed to hit:
//
//   picks: 'concrete' — only structural concrete geometry (raycast layer 0)
//          'rebar'    — only exposed reinforcement (raycast layer 1); a torch cannot cut concrete
//          'gap'      — an interface / floor position rather than a surface (bags, shoring)
//
// `kind` tells the renderer which cursor to draw.

export const TOOL_NONE = 'NONE';

export const EQUIPMENT = [
  {
    id: 'CONCRETE_CUTTER', label: 'Concrete cutter', short: 'Cutter', kind: 'hole', picks: 'concrete', key: '1',
    hint: 'Cut a square hole in a slab — the plug drops into the void below.',
    holeSize: 0.6,        // default square side (m)
    // completion handled by main.js -> sim.cutHoleInSlab (removes plug, leaves a hole)
  },
  {
    id: 'CONCRETE_SAW', label: 'Concrete saw', short: 'Saw', kind: 'slice', picks: 'concrete', key: '2',
    hint: 'Slice a slab clean through — it splits into two bodies that keep their momentum.',
    apply(sim, { part, local, axis }) {
      if (!part || part.kind !== 'slab') return { severed: 0, points: [] };
      const res = sim.sliceSlab(part, axis, axis === 'x' ? local.x : local.z);
      if (!res || !res.spawned) return { severed: 0, points: [] };
      const t = res.spawned.body.translation();
      return { severed: 1, points: [{ x: t.x, y: t.y, z: t.z }], spawned: res.spawned };
    },
  },
  {
    id: 'REBAR_CUTTER', label: 'Rebar cutter', short: 'Rebar', kind: 'rebar', picks: 'rebar', reach: 0.55, key: '3',
    hint: 'Hydraulic pliers: snip exposed rebar in a fracture so the pieces separate.',
    apply(sim, { point }) { return sim.cutRebar(point, this.reach); },
  },
  {
    id: 'TORCH', label: 'Cutting torch', short: 'Torch', kind: 'torch', picks: 'rebar', reach: 0.8, key: '4',
    hint: 'Burns through any structural joint in reach — including still-embedded ties.',
    apply(sim, { point }) { return sim.cutJointNear(point, this.reach); },
  },
  {
    id: 'BREACHING_HAMMER', label: 'Breaching hammer', short: 'Hammer', kind: 'hammer', picks: 'concrete', reach: 0.6, key: '5',
    hint: 'Spalls concrete: removes section (collapsing buckling capacity) and exposes rebar.',
    apply(sim, { point }) {
      const res = sim.spallAt(point, this.reach);
      return { severed: res.spalled || res.exposed ? 1 : 0, points: [point], ...res };
    },
  },
  {
    id: 'LIFT_BAG', label: 'Lifting bag', short: 'Bag', kind: 'bag', picks: 'gap', key: '6',
    hint: 'Place at an interface and inflate. Stalls if the debris outweighs its rating.',
    apply(sim, { point, bagId }) {
      const bag = sim.rescue.placeBag(point, bagId || 'bag10t');
      return { severed: bag ? 1 : 0, points: bag ? [point] : [], bag };
    },
  },
  {
    id: 'SHORE', label: 'Shoring', short: 'Shore', kind: 'shore', picks: 'gap', key: '7',
    hint: 'Erect a T-shore or lace shore to carry load before you lift.',
    apply(sim, { point, shoreId }) {
      const shore = sim.rescue.placeShore({ x: point.x, y: 0, z: point.z }, shoreId || 'tShore');
      return { severed: shore ? 1 : 0, points: shore ? [point] : [], shore };
    },
  },
];

export const equipmentById = (id) => EQUIPMENT.find((e) => e.id === id) || null;
export const equipmentByLabel = (label) => EQUIPMENT.find((e) => e.label === label) || null;
export const TOOL_LABELS = ['None', ...EQUIPMENT.map((e) => e.label)];
