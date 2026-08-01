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

// --- demolition hammer (electric breaker) -------------------------------------------------------
// A rhythmic train of low thuds + grit bursts while RMB is held. Cleared on mouse-up.

let hammerTimer = null;

/** One percussive strike — low body thud plus a short noise slap. */
function playHammerStrike() {
  const c = ensureAudio();
  if (!c) return;
  const t = c.currentTime;

  // Body of the hit: descending sine, like a mass striking concrete.
  const o = c.createOscillator(), g = c.createGain();
  o.type = 'sine';
  o.frequency.setValueAtTime(140, t);
  o.frequency.exponentialRampToValueAtTime(55, t + 0.07);
  o.connect(g).connect(c.destination);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(0.14, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + 0.09);
  o.start(t); o.stop(t + 0.1);

  // Grit / bit chatter on the surface.
  if (noiseBuf) {
    const src = c.createBufferSource(); src.buffer = noiseBuf;
    const f = c.createBiquadFilter(); f.type = 'bandpass';
    f.frequency.value = 900; f.Q.value = 0.8;
    const ng = c.createGain();
    src.connect(f).connect(ng).connect(c.destination);
    ng.gain.setValueAtTime(0.0001, t);
    ng.gain.exponentialRampToValueAtTime(0.09, t + 0.003);
    ng.gain.exponentialRampToValueAtTime(0.0001, t + 0.06);
    src.start(t); src.stop(t + 0.07);
  }
}

/**
 * Start the breaker loop. Idempotent — holding the mouse down longer does not stack timers.
 * `intervalMs` defaults to ~8 strikes/sec (a busy electric hammer).
 */
export function startHammer(intervalMs = 125) {
  ensureAudio();
  if (hammerTimer != null) return;
  // NaN / 0 would schedule setInterval(..., 0) and flood the main thread with oscillators —
  // that is what made right-click appear to hang the whole sim.
  const ms = Math.max(50, Number(intervalMs) || 125);
  playHammerStrike();
  hammerTimer = setInterval(playHammerStrike, ms);
}

/** Silence the breaker — call on pointerup / tool change / lost engagement if desired. */
export function stopHammer() {
  if (hammerTimer != null) {
    clearInterval(hammerTimer);
    hammerTimer = null;
  }
}
