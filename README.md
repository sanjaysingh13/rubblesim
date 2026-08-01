# RubbleSim Web

Browser-based Urban Search & Rescue rubble simulator — **the primary, go-forward
implementation**. Models and collapses multi-story buildings, then detects the
confined-space voids (survivable pockets) inside the resulting rubble.

Built with [three.js](https://threejs.org) (rendering) and
[Rapier](https://rapier.rs) (WASM rigid-body physics). The original Unity project
(`../`) is kept only as a reference for ideas and higher-fidelity rendering; all new
development happens here.

> Status: proof-of-concept. Single-page, **100% client-side** — no backend, no
> accounts, no server-side state. Exports (STL / voids JSON) are browser downloads.

---

## Contents

- [Quick start (local)](#quick-start-local)
- [Production build](#production-build)
- [Deployment](#deployment) — Netlify · Vercel · Cloudflare Pages · GitHub Pages · Docker/nginx · S3+CDN
- [Hosting requirements](#hosting-requirements)
- [Caching & headers](#caching--headers)
- [CI verification](#ci-verification)
- [Performance notes](#performance-notes)
- [Browser support](#browser-support)
- [Troubleshooting](#troubleshooting)

---

## Quick start (local)

```bash
cd web
npm install
npm run dev        # → http://localhost:5173
```

Controls: **drag** orbit · **scroll** zoom · **P** rebuild · **C** collapse · **F** freeze ·
**V** toggle void markers. The GUI panel (top-right) tunes the building, collapse, and
void-detection parameters.

---

## Production build

```bash
npm ci             # reproducible install from package-lock.json
npm run build      # → dist/
npm run preview    # optional: serve dist/ locally at http://localhost:4173
```

`dist/` is a **static bundle** — `index.html` plus one hashed, minified JS file with the
Rapier WebAssembly **inlined as base64** (there is no separate `.wasm` to serve). Copy
`dist/` to any static host and it runs.

`vite.config.js` sets `base: './'` (relative asset paths), so the same build works at a
domain root **or** any sub-path (e.g. a GitHub Pages project page) with no changes.

---

## Deployment

All targets below serve the static `dist/`. Build command: `npm ci && npm run build`,
publish directory: `dist`.

### Netlify

`web/netlify.toml`:

```toml
[build]
  base    = "web"
  command = "npm ci && npm run build"
  publish = "web/dist"

[[headers]]
  for = "/assets/*"
  [headers.values]
    Cache-Control = "public, max-age=31536000, immutable"

[[headers]]
  for = "/index.html"
  [headers.values]
    Cache-Control = "no-cache"
```

### Vercel

`web/vercel.json`:

```json
{
  "buildCommand": "npm ci && npm run build",
  "outputDirectory": "dist",
  "headers": [
    { "source": "/assets/(.*)", "headers": [
      { "key": "Cache-Control", "value": "public, max-age=31536000, immutable" } ] }
  ]
}
```

Set the project **Root Directory** to `web` in the Vercel dashboard.

### Cloudflare Pages

- Build command: `npm ci && npm run build`
- Build output directory: `dist`
- Root directory: `web`

No extra config needed; Pages serves the static bundle directly.

### GitHub Pages (via Actions)

`.github/workflows/deploy.yml` (repo root):

```yaml
name: Deploy web
on:
  push:
    branches: [rescue-training]   # adjust to your default/deploy branch
permissions:
  contents: read
  pages: write
  id-token: write
jobs:
  build:
    runs-on: ubuntu-latest
    defaults: { run: { working-directory: web } }
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20, cache: npm, cache-dependency-path: web/package-lock.json }
      - run: npm ci
      - run: node verify.mjs           # headless physics smoke test
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with: { path: web/dist }
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment: { name: github-pages, url: "${{ steps.deployment.outputs.page_url }}" }
    steps:
      - id: deployment
        uses: actions/deploy-pages@v4
```

Because `base` is relative, this works at `https://<user>.github.io/<repo>/` unchanged.

### Docker + nginx (self-hosted)

`web/Dockerfile`:

```dockerfile
# build
FROM node:20-alpine AS build
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

# serve
FROM nginx:alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
```

`web/nginx.conf`:

```nginx
server {
  listen 80;
  root /usr/share/nginx/html;
  index index.html;

  gzip on;
  gzip_types application/javascript text/css application/json image/svg+xml;

  location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
  }
  location / {
    add_header Cache-Control "no-cache";
    try_files $uri /index.html;   # single-page fallback
  }
}
```

```bash
docker build -t rubblesim-web web
docker run --rm -p 8080:80 rubblesim-web    # → http://localhost:8080
```

### Amazon S3 + CloudFront (or any object store + CDN)

```bash
npm ci && npm run build
aws s3 sync dist/ s3://YOUR_BUCKET/ --delete \
  --cache-control "public, max-age=31536000, immutable" \
  --exclude index.html
aws s3 cp dist/index.html s3://YOUR_BUCKET/index.html \
  --cache-control "no-cache"
# then invalidate the CloudFront distribution:
aws cloudfront create-invalidation --distribution-id YOUR_DIST_ID --paths "/index.html"
```

Set the CloudFront/bucket **default root object** to `index.html`.

---

## Hosting requirements

Deliberately minimal — this is a static client-side app:

- **No server runtime, database, or API** to deploy.
- **No environment variables / secrets.**
- **No special COOP/COEP headers and no `SharedArrayBuffer`.** We use Rapier's
  single-threaded `-compat` build with the WASM inlined, so cross-origin isolation is
  *not* required. (Only relevant if you later switch to Rapier's multithreaded/SIMD
  build, which needs `Cross-Origin-Opener-Policy: same-origin` +
  `Cross-Origin-Embedder-Policy: require-corp`.)
- **HTTPS** recommended (required by some browsers for full WebGL/WebGL2 features).

---

## Caching & headers

`dist/assets/*` filenames are content-hashed, so they're safe to cache forever:

| Path | `Cache-Control` |
|------|-----------------|
| `/assets/*` | `public, max-age=31536000, immutable` |
| `/index.html` | `no-cache` (always revalidate so new builds are picked up) |

Serve with **gzip or brotli** compression enabled (see the size note below).

Optional hardening — a Content-Security-Policy. The app loads no third-party origins and
uses no inline event handlers, but it does create WebGL/WASM contexts:

```
Content-Security-Policy: default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' data: blob:; worker-src 'self' blob:; connect-src 'self'
```

`'wasm-unsafe-eval'` is required because the Rapier WASM is instantiated from the inlined
bundle. Test before enforcing; tighten as the app grows.

---

## CI verification

`verify.mjs` runs the collapse + void-detection pipeline **headless in Node** (Rapier runs
without a browser) — a fast, deterministic smoke test with no WebGL needed:

```bash
node verify.mjs        # exits 0 on PASS, 1 on FAIL
```

It builds a 4-story structure, collapses it, settles the physics, and asserts that
internal (buried) voids are detected. Wire it into CI before the build step (see the
GitHub Actions example above).

---

## Performance notes

- The bundle is ~2.5 MB raw / ~0.9 MB gzipped — mostly three.js + inlined Rapier WASM.
  **Enable server compression** and it's a sub-1 MB transfer. The Vite "chunk > 500 kB"
  warning is expected and harmless for a single-bundle PoC.
- **The rebar lattice is the vertex-count knob.** Stirrups scale as *n²* in the grid resolution,
  so halving `rebarSpacing` is far costlier than doubling `rebarLayers`. At defaults it is
  ~22k rods / ~880k vertices for a 4-storey building, merged into one mesh per part (draw calls
  stay flat). Widen the spacing first if the frame rate drops.
- To split vendor code for better caching, add `build.rollupOptions.output.manualChunks`
  in `vite.config.js` (e.g. separate `three` and `@dimforge/rapier3d-compat`). Not
  required for correctness.
- Physics cost scales with piece count (`stories` × `grid²` + furniture). Defaults settle
  smoothly on a laptop; raising `stories`/`grid` a lot will lower the frame rate during
  the collapse.

---

## Browser support

Requires an evergreen browser (Chrome/Edge/Firefox/Safari, ~2021+):

- **WebGL2** (three.js rendering)
- **WebAssembly** (Rapier physics)
- **ES2022 / top-level `await`** — the build targets `esnext`; the app will not run on
  legacy browsers. If you must support older targets, lower `build.target` in
  `vite.config.js` and wrap the top-level `await RAPIER.init()` in an async bootstrap.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| Blank canvas, console `RAPIER is not defined` / WASM error | Browser lacks WebAssembly, or an over-aggressive CSP blocks `wasm-unsafe-eval`. Loosen CSP or update the browser. |
| Assets 404 under a sub-path | Ensure `base: './'` in `vite.config.js` (already set) and rebuild. |
| `top-level await` build/runtime error | Keep `build.target: 'esnext'` (and `esbuild`/`optimizeDeps` targets) in `vite.config.js`. |
| Choppy collapse | Lower `stories` / `grid` in the GUI, or reduce `settleSeconds`. |
| Stale app after redeploy | `index.html` must be served `no-cache`; hashed assets can be `immutable`. |

---

## Project layout

```
web/
├── index.html          # app shell + HUD + tool ring
├── vite.config.js      # base './', esnext target
├── package.json        # npm run dev | build | verify | measure | shoot
├── measure.mjs         # threshold measurement rig (mode=force | mode=folds)
├── verify*.mjs         # headless CI tests — drive sim.js, no browser
├── shoot*.mjs          # Playwright drivers — catch load-time / invisible-geometry bugs
└── src/
    ├── sim.js          # physics core (framework-agnostic): build → collapse →
    │                   #   crack/snap/tear → settle → detect internal voids.
    │                   #   Shared by main.js and every verify*.mjs.
    ├── structure.js    # structural engineering layer: tributary loads, axial crush +
    │                   #   Euler buckling, progressive redistribution (FrameModel);
    │                   #   contact-graph load paths through the pile (DebrisSupport)
    ├── rescue.js       # lifting bags + shoring, and their capacity/stall physics
    ├── equipment.js    # tool registry = the active-tool enum + raycast pick rules
    ├── main.js         # renderer: mirrors each sim part as a three.js mesh + GUI + HUD
    ├── audio.js        # Web Audio contact tick / grind (no assets)
    └── rng.js          # seeded deterministic RNG (mirrors -randomseed)
```

### Units

Length **m**, mass **tonnes (Mg)**, time **s** ⇒ force in **kN**, stress and moduli in **kPa**.
Gravity is real (9.81); the heavy, non-bouncy collapse comes from restitution, damping and mass.
Keeping real units is what lets the structural layer report loads a rescuer could act on.

### Collapse model (in `sim.js`)

- **Columns & beams** are stiff linear members (chains of box segments held by fixed
  joints). They barely flex (~0.9° max) and **snap** at an overstressed joint into two
  pieces — they never shatter. True large-deflection *bending* needs soft-body/FEM, which
  a rigid-body engine can't do; members are stiff-then-fail, like real RC.
- **Slabs** are concrete tiles **tied together by rebar** into coherent panels. A hard impact
  cracks one seam into a rebar **hinge** (pieces fold but stay connected); only an extreme fold
  tears the rebar through. Sparse cracks ⇒ a few large panels that pancake and lean, not a heap
  of cubes.
- Heavy densities, low restitution and damping make it collapse like a building.
- After settling, **voids are detected** (not placed) by ray-marching vertical lines and
  finding enclosed empty gaps — so they are genuinely inside the rubble.

Impact thresholds (`slabCrackForce`, `beamSnapForce`, `slabTearAngle`, …) are a deliberately
calibrated *numerical proxy* — a solver's peak contact force over one dt is far spikier than a
sustained flexural load. Pick them off a measured distribution with `npm run measure`, never by
guessing. All are tunable live in the GUI and documented as `DEFAULTS` in `sim.js`.

### Reinforcement — an endo-skeleton you only see where it breaks

Every slab tile carries a **3D rebar lattice**, not a single mid-plane grid: `rebarLayers`
planar X–Z mats stacked between the cover faces, tied by a **vertical stirrup at each grid
node**. Defaults (`rebarSpacing` 0.10 m, rod radius 0.008 m, `rebarCover` 0.022 m) are a real
light floor mat — ~16 mm bars at ~10 cm centres — and work out to **609 rods per tile**
(84 + 84 mat bars, 441 stirrups). Columns and beams keep their 4-bar cage.

The cage is **hidden inside intact concrete**, exactly as in life. It is revealed only when
something actually opens the concrete — a seam **cracks**, a joint **snaps or tears**, the cutter
opens a **hole**, the saw **slices** a tile, or the hammer **spalls** a face. The sim raises
`onExpose` for that part and the renderer reveals the rods and swaps the concrete to a
translucent "chipped cover" material, so the lattice reads through like a broken bone. A default
collapse exposes ~30 of 177 settled parts — steel appears at the fractures and nowhere else.

Rebar is **visual only** (descriptors merged into one child mesh per part); mass and the collapse
tuning come from densities, so changing the lattice cannot change the physics. Tune it live in the
GUI's **Rebar lattice** folder.

### Structural model (in `structure.js`)

The code checks that actually decide things are **static** evaluations, so they live here:

- **Load matrix** — `W = ∫(D_L + L_L) dA` per tributary bay. A default 4-storey frame carries
  6.7 kPa dead + 2.0 kPa live per bay, ≈200 kN on a ground column.
- **Capacity** — axial crush `0.85 f'c A_g + f_y A_s` alongside Euler buckling
  `P_cr = π²EI/(KL)²`; the model reports which governs. Spalling shrinks `A` linearly and `I`
  *quadratically*, so damage collapses buckling capacity fast. Note a 0.4 m × 2.6 m RC column is a
  **short** column — crush governs until spalling is severe.
- **Progressive collapse** — a failed column sheds its load onto the **adjacent ring** (load
  follows the beam lines), then the frame is re-evaluated, and the cascade repeats. At
  `designSafetyFactor` 1.8 the frame survives losing a column; below ~1.3 it doesn't.
- **Failure profiles** — `softStory`, `pancake`, `progressive` apply an initiating damage; which
  columns then fail is an outcome of the load path, not a script.

### Rescue tools

Select with the tool ring or keys **0–7**; right-click to use. Left-drag still orbits.

| Tool | Key | Effect |
| --- | --- | --- |
| Concrete cutter | 1 | Square hole in a slab; the plug drops, keeping its momentum |
| Rebar cutter | 2 | Long pliers, short blades; snips rebar exposed at a fracture |
| Cutting torch | 3 | Removes any structural joint in reach, including embedded ties |
| Demolition hammer | 4 | Hold right-click: chips a widening, deepening hole; rebar stays for the snips |
| Lifting bag | 5 | 4/10/20 t; **stalls** if the debris outweighs its rating, capped at 50 cm |
| Shoring | 6 | T-shore / lace shore; carries measured load and offloads the column it braces |
| Extension ladder | 7 | Lean against a wall/slab face; mount with **E** in rescuer mode |

(The concrete saw that once sliced a tile clean through is kept in code as a vestige but is not on the roster.)

The training loop is the real one: an under-rated bag stalls, and the way out is to shore the load
(or cut weight away) and lift again. Press **S** for the stress map (grey → red), **V** for the
ground-truth void volumes.
