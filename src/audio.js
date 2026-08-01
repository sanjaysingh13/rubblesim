// Minimal Web Audio SFX for equipment — synthesized, no asset files.
// Browsers require a user gesture before audio starts; ensureAudio() resumes on first call.

let ctx, noiseBuf, grindGain, grindSrc, grindFilter, lfo, lfoGain, failed = false;

export function ensureAudio() {
  if (failed) return null;
  try {
    if (!ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) { failed = true; return null; }
      ctx = new AC();
      const n = Math.floor(ctx.sampleRate * 1.5);
      noiseBuf = ctx.createBuffer(1, n, ctx.sampleRate);
      const d = noiseBuf.getChannelData(0);
      for (let i = 0; i < n; i++) d[i] = Math.random() * 2 - 1;
    }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  } catch (e) { failed = true; return null; }
}

// short metallic tick when the blade touches a solid
export function playContact() {
  const c = ensureAudio();
  if (!c) return;
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'square'; o.frequency.value = 480;
  o.connect(g).connect(c.destination);
  const t = c.currentTime;
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.06, t + 0.008);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
  o.start(t); o.stop(t + 0.09);
}

/**
 * Soft thud — rescuer trunk/boot glancing concrete. Lower and shorter than the blade tick
 * so it reads as a body bump, not a tool strike.
 */
export function playBodyBump() {
  const c = ensureAudio();
  if (!c) return;
  const t = c.currentTime;
  // Low oscillator for the "boot on concrete" body of the hit.
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'sine'; o.frequency.setValueAtTime(90, t);
  o.frequency.exponentialRampToValueAtTime(55, t + 0.12);
  o.connect(g).connect(c.destination);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.09, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.14);
  o.start(t); o.stop(t + 0.15);
  // Brief noise layer for grit / scuff.
  if (noiseBuf) {
    const src = c.createBufferSource(); src.buffer = noiseBuf;
    const f = c.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = 600;
    const ng = c.createGain();
    src.connect(f).connect(ng).connect(c.destination);
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.05, t + 0.005);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.08);
    src.start(t); src.stop(t + 0.09);
  }
}

// looping grinding noise (bandpassed white noise with a slow wobble); gain-gated on/off
export function startGrind() {
  const c = ensureAudio();
  if (!c) return;
  if (!grindSrc) {
    grindSrc = c.createBufferSource(); grindSrc.buffer = noiseBuf; grindSrc.loop = true;
    grindFilter = c.createBiquadFilter(); grindFilter.type = 'bandpass';
    grindFilter.frequency.value = 2400; grindFilter.Q.value = 0.7;
    grindGain = c.createGain(); grindGain.gain.value = 0.0001;
    // wobble the filter for a rougher grind
    lfo = c.createOscillator(); lfo.frequency.value = 30; lfoGain = c.createGain(); lfoGain.gain.value = 700;
    lfo.connect(lfoGain).connect(grindFilter.frequency);
    grindSrc.connect(grindFilter).connect(grindGain).connect(c.destination);
    grindSrc.start(); lfo.start();
  }
  const t = c.currentTime;
  grindGain.gain.cancelScheduledValues(t);
  grindGain.gain.setTargetAtTime(0.11, t, 0.02);
}

export function stopGrind() {
  if (!ctx || !grindGain) return;
  const t = ctx.currentTime;
  grindGain.gain.cancelScheduledValues(t);
  grindGain.gain.setTargetAtTime(0.0001, t, 0.06);
}
