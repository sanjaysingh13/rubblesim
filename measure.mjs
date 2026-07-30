// Threshold measurement rig — DEVLOG ground rule: "measure, then tune".
// Runs the collapse with every failure trigger DISABLED (threshold = 1e12) and reports the
// distribution of per-contact force magnitudes (split by part kind) and joint bend angles.
// Pick fracture/snap thresholds off these percentiles instead of guessing.
//
//   node measure.mjs                 # current DEFAULTS
//   node measure.mjs gravity=9.81 restitution=0.1 densityMember=2.5
//
// Units follow src/sim.js: m, tonnes (Mg), s  =>  force in kN.

import RAPIER from '@dimforge/rapier3d-compat';
import { RubbleSim, relAngle } from './src/sim.js';

const overrides = {};
let mode = 'force';
for (const arg of process.argv.slice(2)) {
  const [k, v] = arg.split('=');
  if (k === 'mode') mode = v;
  else if (k && v !== undefined) overrides[k] = Number(v);
}

// Disable every failure trigger so the run records the UNCLIPPED distribution: nothing snaps,
// cracks or tears, so no force is "used up" early and the tail is the true impact spectrum.
const OFF = 1e12;
// mode=force: nothing fails at all -> true impact-force spectrum (sets the *Force thresholds).
// mode=folds: cracking ENABLED, tearing/snapping disabled -> how far a cracked rebar hinge
//   actually folds, which is the only thing that can set slabTearAngle/beamSnapAngle. The
//   force-mode run can't: with no cracks there are no hinges, so bend stays ~1° and any angle
//   threshold looks unreachable.
const params = mode === 'folds'
  ? { seed: 1, slabTearAngle: OFF, beamSnapAngle: OFF, ...overrides }
  : { seed: 1, beamSnapForce: OFF, beamSnapAngle: OFF, slabCrackForce: OFF, slabTearAngle: OFF,
      contactEventThreshold: 0.01, ...overrides };

// Record contact forces AND still apply the real trigger logic (mirrors sim._processContacts).
// It must do both: the event queue is consumed by one drain, so we can't delegate to super.
// Triggers are then disabled purely by the 1e12 thresholds, which keeps `mode=folds` — where
// cracking must actually happen — honest instead of silently inert.
class Measured extends RubbleSim {
  constructor(...a) { super(...a); this.samples = { slab: [], column: [], beam: [], furniture: [], fragment: [] }; }
  _processContacts() {
    const o = this.opts;
    this.events.drainContactForceEvents((e) => {
      const mag = e.maxForceMagnitude();
      if (mag > this.stats.maxForce) this.stats.maxForce = mag;
      const p = this.colliderToPart.get(e.collider1()) || this.colliderToPart.get(e.collider2());
      if (!p || p.dead) return;
      (this.samples[p.kind] || (this.samples[p.kind] = [])).push(mag);
      if ((p.kind === 'beam' || p.kind === 'column') && p.member && mag > o.beamSnapForce) this._snapMember(p.member);
      else if (p.kind === 'slab' && mag > o.slabCrackForce) this._crackTilesOf(p);
    });
  }
}

const pct = (sorted, q) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] : 0);
const fmt = (n) => (n >= 1000 ? n.toFixed(0) : n >= 10 ? n.toFixed(1) : n.toFixed(2));

await RAPIER.init();
const sim = new Measured(RAPIER, params);
const built = sim.build();
sim.collapse();

let maxAbs = 0;
const folds = [], memberBends = [];
const frames = Math.round(9 * 60);
for (let f = 0; f < frames; f++) {
  sim.step();
  for (const p of sim.parts) {
    const t = p.body.translation();
    maxAbs = Math.max(maxAbs, Math.abs(t.x), Math.abs(t.y), Math.abs(t.z));
  }
  if (mode === 'folds') {
    for (const rec of sim.joints) {
      if (rec.broken || rec.a.dead || rec.b.dead) continue;
      const ang = relAngle(rec.a.body.rotation(), rec.b.body.rotation());
      if (rec.type === 'tie' && rec.cracked) folds.push(ang);
      else if (rec.type === 'member') memberBends.push(ang);
    }
  }
}
let top = 0;
for (const p of sim.parts) top = Math.max(top, p.body.translation().y);

const o = sim.opts;
console.log(`gravity ${o.gravity} m/s²  ·  restitution ${o.restitution}  ·  damping ${o.linearDamping}/${o.angularDamping}`);
console.log(`density concrete ${o.densityConcrete} · member ${o.densityMember} (Mg/m³)  ·  substeps ${o.substeps}`);
console.log(`built ${built} pieces  ·  settled ${sim.parts.length}  ·  pile top ${top.toFixed(2)} m  ·  max |coord| ${maxAbs.toFixed(1)} m`);

if (mode === 'folds') {
  const deg = (r) => `${(r * 180 / Math.PI).toFixed(1)}°`;
  const rep = (name, arr) => {
    if (!arr.length) return console.log(`${name}: no samples`);
    const s = arr.slice().sort((a, b) => a - b);
    console.log(`${name.padEnd(22)} n=${String(s.length).padStart(7)}  ` +
      [0.5, 0.9, 0.99, 0.999].map((q) => `p${q * 100}=${pct(s, q).toFixed(3)}`).join('  ') +
      `  max=${s[s.length - 1].toFixed(3)} rad (${deg(s[s.length - 1])})`);
  };
  console.log(`\ncracks formed: ${sim.stats.cracks} · snaps: ${sim.stats.snaps} (tear/snap ANGLE triggers disabled)`);
  console.log(`bend-angle distribution over the whole run:`);
  rep('cracked tie (hinge) fold', folds);
  rep('member joint bend', memberBends);
  console.log(`\nPick slabTearAngle above the fold p99.9 to keep tears RARE (panels stay coherent),`);
  console.log(`and beamSnapAngle near the member-bend p99 to keep it an ACTIVE trigger.`);
  process.exit(0);
}

console.log(`\ncontact force magnitude by part kind (kN), triggers disabled:`);
console.log(`kind        n      p50     p75     p90     p95     p99      max`);
for (const [kind, arr] of Object.entries(sim.samples)) {
  if (!arr.length) continue;
  const s = arr.slice().sort((a, b) => a - b);
  console.log(`${kind.padEnd(10)} ${String(s.length).padStart(6)}  ${[0.5, 0.75, 0.9, 0.95, 0.99].map((q) => fmt(pct(s, q)).padStart(6)).join('  ')}  ${fmt(s[s.length - 1]).padStart(7)}`);
}
console.log(`\nmax joint bend seen: ${sim.stats.maxBend.toFixed(4)} rad (${(sim.stats.maxBend * 180 / Math.PI).toFixed(2)}°)`);
console.log(`\nsuggested thresholds (p90 of the driving kind):`);
const slab = sim.samples.slab.slice().sort((a, b) => a - b);
const mem = [...sim.samples.column, ...sim.samples.beam].sort((a, b) => a - b);
console.log(`  slabCrackForce ≈ ${fmt(pct(slab, 0.9))}   (p90 slab contact)`);
console.log(`  beamSnapForce  ≈ ${fmt(pct(mem, 0.9))}   (p90 column/beam contact)`);
console.log(`  contactEventThreshold ≈ ${fmt(Math.min(pct(slab, 0.5), pct(mem, 0.5)))}   (p50 — below this is noise)`);
if (maxAbs > 60) console.log('\nWARNING: explosion (max |coord| > 60 m) — the run is unstable, distribution is meaningless.');
