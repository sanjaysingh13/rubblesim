// Rescue-equipment registry (framework-agnostic; no three.js).
// Tools are applied to the settled rubble at a chosen 3D point/orientation and act on the
// physics core (src/sim.js). `kind` tells the renderer which interaction/gizmo to use:
//   'hole'  — guided square: cut the 4 sides, then the plug drops (driven by main.js state)
//   'plane' — one-shot plane cut applied via apply()

export const EQUIPMENT = [
  {
    id: 'concreteCutter', label: 'Concrete cutter', kind: 'hole',
    holeSize: 0.6,        // default square side (m)
    segment: 0.1,         // straight-cut increment per stroke (~10 cm)
    // completion handled by main.js -> sim.cutHoleInSlab (removes plug, leaves a hole)
  },
  {
    id: 'rebarCutter', label: 'Rebar cutter', kind: 'plane', reach: 0.5,
    // cuts rebar/steel: breaks every joint crossing the plane, fully freeing pieces so they drop
    apply(sim, { point, normal }) { return sim.cut(point, normal, this.reach, { mode: 'rebar' }); },
  },
];

export const equipmentById = (id) => EQUIPMENT.find((e) => e.id === id) || null;
export const equipmentByLabel = (label) => EQUIPMENT.find((e) => e.label === label) || null;
