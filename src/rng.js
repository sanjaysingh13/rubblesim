// Seeded, deterministic RNG (mulberry32) — mirrors RubbleSim's -randomseed philosophy
// so that a given seed reproduces the same debris/void placement.

export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  const next = () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    float: (min, max) => min + (max - min) * next(),
    int: (min, maxExclusive) => Math.floor(min + (maxExclusive - min) * next()),
    // uniform point in a unit sphere (rejection sampling)
    inUnitSphere: () => {
      let x, y, z;
      do {
        x = next() * 2 - 1; y = next() * 2 - 1; z = next() * 2 - 1;
      } while (x * x + y * y + z * z > 1);
      return [x, y, z];
    },
  };
}
