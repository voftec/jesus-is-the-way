// arcade-audio.js — 100% procedural WebAudio SFX for the claw machine.
// No audio assets: every sound is synthesized (oscillators + filtered noise),
// which keeps the Web Lens package under the 8MB limit and fully offline.

let ctx = null;
let master = null;
let sfxBus = null;
let ambientOn = false;

function ensureCtx() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = 0.45;
    master.connect(ctx.destination);
    sfxBus = ctx.createGain();
    sfxBus.gain.value = 0.95; // SFX sit ~5% under before
    sfxBus.connect(master);
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// Resume the context on any gesture WITHOUT starting music/ambience —
// the flag screen must stay silent; sound only exists once you enter.
export function prewarmAudio() { ensureCtx(); }

// Duck the entire audio bus — silence while the Word is on screen.
export function duckAudio(on) {
  const c = ensureCtx();
  if (!c || !master) return;
  master.gain.setTargetAtTime(on ? 0 : 0.45, c.currentTime, 0.35);
}

// Debug probe for audio lifecycle issues
export function audioState() {
  return { state: ctx?.state, master: master?.gain.value, musicTimer: !!musicTimer, ambientOn };
}

// Call from the first user gesture (Snap requires audio to unlock post-gesture).
export function initAudio() {
  const c = ensureCtx();
  if (!c || ambientOn) return;
  ambientOn = true;
  startMusic();
  // Arcade room tone: very quiet filtered pink noise + a faint 55Hz mains hum.
  const noiseBuf = c.createBuffer(1, c.sampleRate * 2, c.sampleRate);
  const d = noiseBuf.getChannelData(0);
  let b0 = 0, b1 = 0, b2 = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    b0 = 0.997 * b0 + 0.029591 * w;
    b1 = 0.985 * b1 + 0.032534 * w;
    b2 = 0.95 * b2 + 0.048056 * w;
    d[i] = (b0 + b1 + b2 + w * 0.05) * 0.25;
  }
  const src = c.createBufferSource();
  src.buffer = noiseBuf; src.loop = true;
  const lp = c.createBiquadFilter(); lp.type = 'lowpass'; lp.frequency.value = 900;
  const ng = c.createGain(); ng.gain.value = 0.018;
  src.connect(lp); lp.connect(ng); ng.connect(master);
  src.start();
  const hum = c.createOscillator(); hum.type = 'sine'; hum.frequency.value = 55;
  const hg = c.createGain(); hg.gain.value = 0.012;
  hum.connect(hg); hg.connect(master);
  hum.start();
}

function noiseBurst(dur, type = 'lowpass', freq = 800, gain = 0.2, delay = 0) {
  const c = ensureCtx(); if (!c) return;
  const buf = c.createBuffer(1, Math.max(1, c.sampleRate * dur), c.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = c.createBufferSource(); s.buffer = buf;
  const f = c.createBiquadFilter(); f.type = type; f.frequency.value = freq;
  const g = c.createGain();
  const t = c.currentTime + delay;
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  s.connect(f); f.connect(g); g.connect(sfxBus || master);
  s.start(t); s.stop(t + dur);
}

function tone(freq0, freq1, dur, type = 'sine', gain = 0.2, delay = 0, lpFreq = 0) {
  const c = ensureCtx(); if (!c) return;
  _toneAt(freq0, freq1, dur, type, gain, c.currentTime + delay, lpFreq, sfxBus || master);
}

function _toneAt(freq0, freq1, dur, type, gain, t, lpFreq, dest) {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.setValueAtTime(freq0, t);
  if (freq1 !== freq0) o.frequency.exponentialRampToValueAtTime(Math.max(1, freq1), t + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.015);
  g.gain.exponentialRampToValueAtTime(0.001, t + dur);
  let out = o;
  if (lpFreq) {
    const f = ctx.createBiquadFilter(); f.type = 'lowpass'; f.frequency.value = lpFreq;
    o.connect(f); out = f;
  }
  out.connect(g); g.connect(dest);
  o.start(t); o.stop(t + dur + 0.02);
}

function _hatAt(t, dest, gain = 0.03) {
  const buf = ctx.createBuffer(1, ctx.sampleRate * 0.03, ctx.sampleRate);
  const d = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  const s = ctx.createBufferSource(); s.buffer = buf;
  const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.001, t + 0.03);
  s.connect(f); f.connect(g); g.connect(dest);
  s.start(t); s.stop(t + 0.03);
}

// ---------- procedural arcade music loop ----------
// Two phases like real UFO Catchers: a calm ATTRACT loop while idle, and a
// faster, denser GAMEPLAY loop (140 BPM, busier bass + hats every step, lead
// one octave up) the instant a grab cycle starts — it marks the countdown.
// Lookahead scheduler: notes are booked ~180ms ahead on the audio clock,
// so the loop stays tight even if the render frame hitches.
const ATTRACT_BPM = 112;
const PLAY_BPM = 140;
const BASS_SEQ = [0, null, 0, null, 3, null, 10, null, 0, null, 0, null, 5, 3, -2, null]; // semitones vs A2
const BASS_SEQ_PLAY = [0, 0, 3, 3, 10, 10, 7, 7, 0, 0, 3, 3, 12, 10, 7, 5]; // denser driving line
const LEAD_SEQ = [12, 15, 19, 24, 15, 19, 24, 27, 12, 15, 19, 24, 22, 19, 15, 12];
const A2 = 110;
const semi = (s) => A2 * Math.pow(2, s / 12);
let musicGain = null;
let musicTimer = null;
let nextStepT = 0;
let stepIdx = 0;
let musicMode = 'attract';

// 'attract' (idle, inviting melody) | 'play' (urgent countdown groove)
export function setMusicMode(mode) {
  musicMode = mode;
}

function startMusic() {
  if (musicTimer || !ctx) return;
  musicGain = ctx.createGain();
  musicGain.gain.value = 0.5; // audible groove — still under the SFX peaks
  musicGain.connect(master);
  nextStepT = ctx.currentTime + 0.1;
  stepIdx = 0;
  musicTimer = setInterval(() => {
    if (nextStepT < ctx.currentTime - 0.06) nextStepT = ctx.currentTime + 0.02;
    while (nextStepT < ctx.currentTime + 0.18) {
      const playing = musicMode === 'play';
      const step = 60 / (playing ? PLAY_BPM : ATTRACT_BPM) / 2; // 8th notes
      const i = stepIdx, t = nextStepT;
      const bass = playing ? BASS_SEQ_PLAY : BASS_SEQ;
      if (bass[i] !== null) _toneAt(semi(bass[i]) / 2, semi(bass[i]) / 2, step * 0.9, 'square', playing ? 0.06 : 0.055, t, 420, musicGain);
      const leadNote = LEAD_SEQ[i] + (playing ? 12 : 0); // gameplay lead jumps an octave
      if (LEAD_SEQ[i] !== null) _toneAt(semi(leadNote), semi(leadNote), step * 0.75, 'triangle', playing ? 0.05 : 0.045, t, 0, musicGain);
      // attract: hats on beats only; play: driving 8th-note hats
      if (playing ? true : i % 2 === 0) _hatAt(t, musicGain, i % 4 === 0 ? 0.045 : 0.022);
      nextStepT += step;
      stepIdx = (stepIdx + 1) % 16;
    }
  }, 60);
}

export const sfx = {
  // Gantry / drop motor
  whir()   { tone(85, 62, 0.45, 'sawtooth', 0.07, 0, 320); noiseBurst(0.3, 'bandpass', 500, 0.04); },
  // Bell lands on the pile
  thud()   { tone(120, 42, 0.16, 'sine', 0.5); noiseBurst(0.07, 'lowpass', 250, 0.25); },
  // Fingers snap shut
  clack()  { tone(520, 480, 0.045, 'square', 0.16); noiseBurst(0.03, 'highpass', 3000, 0.14); },
  // Winch reels the cable in
  hoist()  { tone(70, 135, 0.7, 'sawtooth', 0.06, 0, 380); },
  // Fingers open over the chute
  tick()   { tone(820, 760, 0.03, 'square', 0.1); },
  // Button press
  press()  { tone(660, 620, 0.04, 'square', 0.08); },
  // Prize slips out mid-flight — sad descending womp
  slip()   { tone(240, 170, 0.18, 'sine', 0.3); tone(170, 110, 0.3, 'sine', 0.26, 0.16); },
  // WIN: little neon arpeggio + sparkle
  win() {
    const seq = [523.25, 659.25, 783.99, 1046.5];
    seq.forEach((f, i) => tone(f, f, 0.14, 'triangle', 0.28, i * 0.085));
    tone(2093, 2093, 0.3, 'sine', 0.08, 0.34);
    noiseBurst(0.25, 'highpass', 6000, 0.05);
  },
  // Soft bell when the prize ball arrives at center — reverent, not casino
  chime() {
    tone(880, 880, 1.1, 'sine', 0.16);
    tone(1318.5, 1318.5, 1.3, 'sine', 0.07, 0.03);
    tone(1760, 1760, 0.9, 'sine', 0.05, 0.07);
  },
  // Paper rustle as the folded note unfolds
  paper() {
    noiseBurst(0.16, 'bandpass', 2400, 0.055);
    noiseBurst(0.12, 'bandpass', 3200, 0.04, 0.11);
  },
};
