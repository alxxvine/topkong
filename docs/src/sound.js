import { tuning as T } from 'tk/tuning.js';

// Sound. Everything is synthesized right here, in Web Audio — no files.
//
// Not only because the egress proxy has nowhere to download samples from:
// cardboard fighters on a plywood disc ask for arcade foley, and a real
// «meaty» impact sample would sit on this scene like a stock photo in a
// comic strip. Oscillators and filtered noise match the material.
//
// The context is created lazily on the first user gesture — browsers keep
// AudioContext suspended until one anyway. Every effect is fire-and-forget:
// build a tiny node graph, schedule an envelope, let it be garbage.

export class Sound {
  constructor() {
    this.ctx = null;
    this.master = null;
    this.noiseBuf = null;
    /** Per-effect counters, for the test stand: hearing is not automatable. */
    this.played = { whoosh: 0, impact: 0, thud: 0, fall: 0, respawn: 0, kill: 0 };
  }

  /** True when the context exists and the toggle is on. */
  get on() {
    return !!T.sound && !!this.ctx && this.ctx.state === 'running';
  }

  /** Create/resume on a user gesture. Safe to call every time. */
  unlock() {
    if (!this.ctx) {
      const AC = window.AudioContext || window.webkitAudioContext;
      if (!AC) return;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.4;
      this.master.connect(this.ctx.destination);
      // Half a second of white noise, reused by every noise-based effect.
      const len = Math.floor(this.ctx.sampleRate * 0.5);
      this.noiseBuf = this.ctx.createBuffer(1, len, this.ctx.sampleRate);
      const d = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
    }
    if (this.ctx.state === 'suspended') this.ctx.resume();
  }

  /** Filtered noise burst: the base of whooshes and crunches. */
  noise(type, freq0, freq1, dur, gain, q = 1) {
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noiseBuf;
    const f = c.createBiquadFilter();
    f.type = type;
    f.Q.value = q;
    f.frequency.setValueAtTime(freq0, c.currentTime);
    f.frequency.exponentialRampToValueAtTime(Math.max(40, freq1), c.currentTime + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(gain, c.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, c.currentTime + dur);
    src.connect(f).connect(g).connect(this.master);
    src.start();
    src.stop(c.currentTime + dur);
  }

  /** Pitched blip: sines and triangles for tones. */
  tone(type, freq0, freq1, dur, gain, delay = 0) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = type;
    const t0 = c.currentTime + delay;
    o.frequency.setValueAtTime(freq0, t0);
    o.frequency.exponentialRampToValueAtTime(Math.max(30, freq1), t0 + dur);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.01);
    g.gain.exponentialRampToValueAtTime(0.001, t0 + dur);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  /** Club sweep. Charge decides how much air it moves. */
  whoosh(power) {
    if (!this.on) return;
    this.played.whoosh++;
    const p = 0.4 + 0.6 * Math.min(1, power);
    this.noise('bandpass', 260, 900 + 500 * p, 0.18, 0.14 * p, 1.6);
  }

  /** Club connects. Strength drives the thump depth and the crack. */
  impact(strength) {
    if (!this.on) return;
    this.played.impact++;
    const s = Math.min(1, strength);
    this.tone('sine', 150 + 60 * s, 55, 0.13 + 0.05 * s, 0.5 + 0.3 * s);
    this.noise('highpass', 1400, 2600, 0.06, 0.18 + 0.15 * s, 0.8);
  }

  /** A body goes down without a club: the ram topple, softer than a hit. */
  thud() {
    if (!this.on) return;
    this.played.thud++;
    this.tone('sine', 110, 48, 0.14, 0.45);
    this.noise('lowpass', 500, 180, 0.1, 0.2);
  }

  /** Off the edge and into the well: a small comedic drop whistle. */
  fall() {
    if (!this.on) return;
    this.played.fall++;
    this.tone('triangle', 660, 140, 0.55, 0.16);
  }

  /** Back on the arena (deathmatch): two quick rising blips. */
  respawn() {
    if (!this.on) return;
    this.played.respawn++;
    this.tone('sine', 440, 660, 0.07, 0.12);
    this.tone('sine', 660, 990, 0.09, 0.12, 0.08);
  }

  /** The player scored a kill: one bright ding, only for the player. */
  kill() {
    if (!this.on) return;
    this.played.kill++;
    this.tone('sine', 880, 1320, 0.16, 0.2);
    this.tone('sine', 1760, 1760, 0.12, 0.08, 0.02);
  }
}
