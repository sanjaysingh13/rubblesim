# RubbleSim Web (three.js + Rapier PoC)

A browser proof-of-concept of RubbleSim's **rubble + confined-space void** generation,
reimplemented with [three.js](https://threejs.org) (rendering) and
[Rapier](https://rapier.rs) (WASM rigid-body physics). It mirrors the Unity pipeline
(`DebrisSpawner` + `VoidSeeder`) but runs anywhere, with no Unity license.

## Pipeline

```
seed voids (static obstacles)  ->  rain weighted debris  ->  settle under gravity
   ->  freeze pile  ->  remove void obstacles (cavities remain)  ->  export STL + voids JSON
```

## Run

```bash
cd web
npm install
npm run dev      # open the printed http://localhost:5173
```

Production build: `npm run build` → static files in `dist/` (host anywhere).

## Controls

- **Drag** orbit · **Scroll** zoom
- **P** regenerate · **F** freeze now · **V** toggle void markers
- GUI panel (top-right): seed, pile size, void count/size, and export buttons

Cyan wireframe spheres mark **ground-truth voids** (survivable pockets) left in the pile.

## Parameter ↔ Unity CLI-arg mapping

| Web param | Unity arg |
|---|---|
| `seed` | `-randomseed` |
| `numLayers` | `-numlayers` |
| `numPerLayer` | `-numobjs` |
| `footprint` | `-spawnboundx/z` |
| `numVoids` | `-numvoids` |
| `voidSizeMin/Max` | `-voidsizemin/max` |
| `voidBandHeight` | `-voidbandheight` |
| `voidCoreFraction` | `-voidcorefrac` |

## PoC limitations (vs. the Unity build)

- **No photorealism / sensor sim / ROS** — this is the generation core only.
- Visual `scale` is cosmetic; colliders use each piece's base size (fine for pile shape,
  approximate for exact contacts). Bake scale into collider dims for physical accuracy.
- Realtime browser physics isn't bit-for-bit deterministic across machines; the **seed**
  fixes spawn/void placement, and the settle is approximately reproducible. For strict
  determinism, step a fixed substep count headlessly.
- Capsule "tunnel" voids from the Unity version aren't implemented yet (spheres only).
