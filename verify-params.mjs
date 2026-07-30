// Guardrail from DEVLOG "Gotchas": lil-gui THROWS if you bind a property that doesn't exist on
// the target object, which kills main.js before the render loop and shows a black screen with no
// obvious cause. Any DEFAULTS rename/removal must therefore be matched in the GUI.
// This asserts every `X.add(params, 'name')` in main.js resolves to a real key.
// Run: node verify-params.mjs

import { readFileSync } from 'node:fs';
import { DEFAULTS } from './src/sim.js';

const src = readFileSync(new URL('./src/main.js', import.meta.url), 'utf8');

// keys declared in main.js's own `const params = { ...DEFAULTS, a: 1, b: 2 }` literal
const block = src.match(/const params = \{([\s\S]*?)\n\};/);
if (!block) { console.log('FAIL: could not locate the `const params` literal in src/main.js'); process.exit(1); }
const localKeys = [...block[1].matchAll(/^\s{2}([A-Za-z_$][\w$]*)\s*:/gm)].map((m) => m[1]);

const available = new Set([...Object.keys(DEFAULTS), ...localKeys]);
const bound = [...src.matchAll(/\b(?:gui|f[A-Za-z]*)\.add\(\s*params\s*,\s*'([^']+)'/g)].map((m) => m[1]);

const missing = bound.filter((k) => !available.has(k));
const unused = [...available].filter((k) => !bound.includes(k) && typeof DEFAULTS[k] !== 'function');

console.log(`params available: ${available.size} (${Object.keys(DEFAULTS).length} from DEFAULTS + ${localKeys.length} local)`);
console.log(`GUI bindings:     ${bound.length}`);
if (missing.length) {
  console.log(`\nFAIL: ${missing.length} GUI binding(s) reference a non-existent param — lil-gui will throw:`);
  for (const k of missing) console.log(`   gui.add(params, '${k}')`);
  process.exit(1);
}
console.log(`unbound params:   ${unused.length} (fine — not everything needs a control)`);
console.log('\nPASS: every GUI binding resolves to a real param.');
