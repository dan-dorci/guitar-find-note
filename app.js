'use strict';

// ---------------------------------------------------------------------------
// Instrument definition
// ---------------------------------------------------------------------------
// Strings listed from high e (row 0, top of the board) to low E (row 5),
// like tab. Acoustic-style set: E A D G wound, B and high e plain.
// Timbre params are the knobs to tweak when validating against a real guitar:
//   excitationDamp  - lowpass on the pluck noise burst (higher = darker attack)
//   loopDamp        - high-frequency loss per cycle (higher = duller, rounder)
//   sustain         - approximate ring time in seconds for the open string
//   dispStages      - string-stiffness allpasses (inharmonicity; wound > plain)
const STRINGS = [
  { name: 'e', midi: 64, freq: 329.63, excitationDamp: 0.28, loopDamp: 0.16, sustain: 2.6, dispStages: 1 },
  { name: 'B', midi: 59, freq: 246.94, excitationDamp: 0.35, loopDamp: 0.20, sustain: 2.9, dispStages: 1 },
  { name: 'G', midi: 55, freq: 196.00, excitationDamp: 0.55, loopDamp: 0.34, sustain: 3.1, dispStages: 2 },
  { name: 'D', midi: 50, freq: 146.83, excitationDamp: 0.62, loopDamp: 0.38, sustain: 3.3, dispStages: 3 },
  { name: 'A', midi: 45, freq: 110.00, excitationDamp: 0.68, loopDamp: 0.42, sustain: 3.5, dispStages: 3 },
  { name: 'E', midi: 40, freq: 82.41,  excitationDamp: 0.72, loopDamp: 0.46, sustain: 3.6, dispStages: 4 },
];
const NUM_FRETS = 15; // includes your open-e vs D-14 example
const SCALE_M = 0.648;          // 25.5" scale length
const PLUCK_FROM_BRIDGE = 0.13; // metres; fixed hand position near the bridge
const DISP_A = 0.55;            // allpass coefficient for stiffness dispersion
const DETUNE = 1.0009;          // ~1.5 cents between the two string polarizations
const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

function midiAt(s, f) { return STRINGS[s].midi + f; }
function noteName(midi) {
  return NOTE_NAMES[midi % 12] + (Math.floor(midi / 12) - 1);
}
function posLabel(s, f) {
  const str = STRINGS[s].name;
  return f === 0 ? `open ${str} string` : `${str} string, fret ${f}`;
}
function unisonPositions(midi) {
  const out = [];
  for (let s = 0; s < 6; s++) {
    const f = midi - STRINGS[s].midi;
    if (f >= 0 && f <= NUM_FRETS) out.push([s, f]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// DSP helpers
// ---------------------------------------------------------------------------
function applyBiquad(x, b0, b1, b2, a1, a2) {
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i] + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
    x[i] = y;
  }
}
function applyPeak(x, sr, f, Q, dbGain) {
  const A = Math.pow(10, dbGain / 40), w = 2 * Math.PI * f / sr;
  const alpha = Math.sin(w) / (2 * Q), cw = Math.cos(w);
  const a0 = 1 + alpha / A;
  applyBiquad(x, (1 + alpha * A) / a0, -2 * cw / a0, (1 - alpha * A) / a0,
    -2 * cw / a0, (1 - alpha / A) / a0);
}
function applyHighpass(x, sr, f, Q) {
  const w = 2 * Math.PI * f / sr;
  const alpha = Math.sin(w) / (2 * Q), cw = Math.cos(w);
  const a0 = 1 + alpha;
  applyBiquad(x, (1 + cw) / 2 / a0, -(1 + cw) / a0, (1 + cw) / 2 / a0,
    -2 * cw / a0, (1 - alpha) / a0);
}

// ---------------------------------------------------------------------------
// Extended Karplus-Strong synthesis
// ---------------------------------------------------------------------------
// One render per (string, fret), cached. Same pitch on different strings gets
// a genuinely different waveform: darker excitation and more per-cycle HF loss
// on wound strings, more stiffness dispersion (inharmonicity) on wound
// strings, and a pick-position comb whose notches depend on the vibrating
// length at that fret. On top of the raw string: two detuned polarizations
// (natural beating), a pick transient, and a modeled acoustic body EQ.
let ctx = null;
const bufferCache = new Map();

function ensureCtx() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// Single-polarization string loop with fractional delay + dispersion.
function ksString(sr, nSamples, f0, t60, dampC, excitationDamp, pluckFrac, dispStages) {
  const c = dampC / 2; // blend toward two-point average; low-freq phase delay ~= c
  const apDelay = (1 - DISP_A) / (1 + DISP_A); // per-stage low-freq group delay
  const L = sr / f0 - c - dispStages * apDelay; // total loop = sr/f0 samples
  const len = Math.ceil(L) + 4;
  const buf = new Float32Array(len);

  // Excitation: lowpassed noise burst + pick-position comb + short bright tick.
  const exLen = Math.max(4, Math.floor(L));
  const ex = new Float32Array(exLen);
  for (let i = 0; i < exLen; i++) ex[i] = Math.random() * 2 - 1;
  let lp = 0;
  for (let i = 0; i < exLen; i++) { lp = excitationDamp * lp + (1 - excitationDamp) * ex[i]; ex[i] = lp; }
  const combD = Math.max(1, Math.round(pluckFrac * L));
  for (let i = exLen - 1; i >= combD; i--) ex[i] -= 0.9 * ex[i - combD];
  const tickLen = Math.min(exLen, Math.floor(sr * 0.002));
  for (let i = 0; i < tickLen; i++) ex[i] += 0.4 * (Math.random() * 2 - 1) * (1 - i / tickLen);

  const g = Math.pow(0.001, 1 / (f0 * t60));
  const apX = new Float32Array(dispStages); // allpass state: x[n-1]
  const apY = new Float32Array(dispStages); // allpass state: y[n-1]
  const out = new Float32Array(nSamples);
  let w = 0, prevY = 0;

  for (let i = 0; i < nSamples; i++) {
    // Fractional-delay read at (w - L).
    let rp = w - L;
    rp = ((rp % len) + len) % len;
    const r0 = Math.floor(rp);
    const frac = rp - r0;
    const y = buf[r0] * (1 - frac) + buf[(r0 + 1) % len] * frac;

    // Loss filter (HF damping) then stiffness dispersion.
    let v = g * ((1 - c) * y + c * prevY);
    prevY = y;
    for (let st = 0; st < dispStages; st++) {
      const yn = DISP_A * (v - apY[st]) + apX[st];
      apX[st] = v; apY[st] = yn;
      v = yn;
    }

    buf[w] = v + (i < exLen ? ex[i] : 0);
    out[i] = y;
    w = (w + 1) % len;
  }
  return out;
}

function synthesize(s, f) {
  const key = s + ':' + f;
  if (bufferCache.has(key)) return bufferCache.get(key);

  const ac = ensureCtx();
  const sr = ac.sampleRate;
  const p = STRINGS[s];
  const f0 = p.freq * Math.pow(2, f / 12);

  // Shorter vibrating length up the neck rings a bit shorter.
  const t60 = p.sustain * Math.pow(2, -f / 24);
  const nSamples = Math.floor(sr * Math.min(4.0, t60 + 0.5));

  const vibLen = SCALE_M * Math.pow(2, -f / 12);
  const pluckFrac = Math.min(0.45, PLUCK_FROM_BRIDGE / vibLen);

  // Two string polarizations: slightly detuned, the quieter one decays faster.
  // Their beating is what makes a real string "sing" instead of buzz statically.
  const a = ksString(sr, nSamples, f0, t60, p.loopDamp, p.excitationDamp, pluckFrac, p.dispStages);
  const b = ksString(sr, nSamples, f0 * DETUNE, t60 * 0.65, p.loopDamp, p.excitationDamp, pluckFrac, p.dispStages);
  const out = new Float32Array(nSamples);
  for (let i = 0; i < nSamples; i++) out[i] = 0.65 * a[i] + 0.35 * b[i];

  // Acoustic body: Helmholtz air mode + top-plate modes, tame the extreme top.
  applyHighpass(out, sr, 65, 0.7);
  applyPeak(out, sr, 100, 4, 5);
  applyPeak(out, sr, 210, 3, 4);
  applyPeak(out, sr, 420, 2, 2.5);
  applyPeak(out, sr, 6000, 0.7, -4);

  // Normalize and fade edges to avoid clicks.
  let peak = 1e-6;
  for (let i = 0; i < nSamples; i++) peak = Math.max(peak, Math.abs(out[i]));
  const fadeIn = Math.floor(sr * 0.002);
  const fadeOut = Math.floor(sr * 0.08);
  for (let i = 0; i < nSamples; i++) {
    let gEnv = 0.8 / peak;
    if (i < fadeIn) gEnv *= i / fadeIn;
    if (i > nSamples - fadeOut) gEnv *= (nSamples - i) / fadeOut;
    out[i] *= gEnv;
  }

  const buf = ac.createBuffer(1, nSamples, sr);
  buf.copyToChannel(out, 0);
  bufferCache.set(key, buf);
  return buf;
}

// ---------------------------------------------------------------------------
// Real recorded samples (IDMT-SMT-Guitar dataset), synth as fallback
// ---------------------------------------------------------------------------
// samples/{string}-{fret}.m4a, keyed by position — never shared across
// strings, so unisons keep their true recorded timbre. Requires serving over
// http(s); on file:// the fetches fail and everything falls back to synth.
const sampleCache = new Map();    // 's:f' -> AudioBuffer
const samplePromises = new Map(); // 's:f' -> Promise<AudioBuffer>
let samplesLoaded = 0, samplesMissing = 0, prefetchStarted = false;

function prefetchSamples() {
  if (prefetchStarted) return;
  prefetchStarted = true;
  const ac = ensureCtx();
  for (let s = 0; s < 6; s++) {
    for (let f = 0; f <= NUM_FRETS; f++) {
      const key = s + ':' + f;
      const p = fetch(`samples/${s}-${f}.m4a`)
        .then(r => { if (!r.ok) throw new Error(r.status); return r.arrayBuffer(); })
        .then(ab => ac.decodeAudioData(ab))
        .then(buf => { sampleCache.set(key, buf); samplesLoaded++; updateSampleStatus(); return buf; });
      p.catch(() => { samplesMissing++; updateSampleStatus(); });
      samplePromises.set(key, p);
    }
  }
}

function updateSampleStatus() {
  const el = document.getElementById('samplestatus');
  const totalCells = 6 * (NUM_FRETS + 1);
  if (samplesLoaded === 0 && samplesMissing >= totalCells) {
    el.textContent = 'Sound: synthesized (no recorded samples found — serve over http with samples/ present)';
  } else if (samplesLoaded + samplesMissing < totalCells) {
    el.textContent = `Sound: loading recorded samples… ${samplesLoaded}/${totalCells}`;
  } else {
    el.textContent = samplesMissing === 0
      ? 'Sound: real recorded guitar (IDMT-SMT-Guitar dataset)'
      : `Sound: recorded guitar for ${samplesLoaded} positions, synth for ${samplesMissing}`;
  }
}

let activeSource = null;
function startBuffer(buffer, source) {
  const ac = ensureCtx();
  if (activeSource) { try { activeSource.stop(); } catch (e) { /* already stopped */ } }
  const src = ac.createBufferSource();
  src.buffer = buffer;
  src.connect(ac.destination);
  src.start();
  activeSource = src;
  const el = document.getElementById('lastsource');
  el.textContent = source === 'recorded' ? '♪ recorded' : '♪ SYNTH';
  el.style.color = source === 'recorded' ? '#6f665a' : '#d9534f';
}

function playNote(s, f) {
  ensureCtx();
  prefetchSamples();
  const key = s + ':' + f;
  const cached = sampleCache.get(key);
  if (cached) return startBuffer(cached, 'recorded');
  const pending = samplePromises.get(key);
  if (!pending) return startBuffer(synthesize(s, f), 'synth');
  // Sample still downloading: wait briefly for the real thing rather than
  // silently playing the synth; give up after 1.5s (offline / slow network).
  let done = false;
  const timer = setTimeout(() => { if (!done) { done = true; startBuffer(synthesize(s, f), 'synth'); } }, 1500);
  pending.then(
    buf => { if (!done) { done = true; clearTimeout(timer); startBuffer(buf, 'recorded'); } },
    () => { if (!done) { done = true; clearTimeout(timer); startBuffer(synthesize(s, f), 'synth'); } });
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------
let mode = 'explore';        // explore | pitch | exact | duel
let phase = 'idle';          // idle | listening | review
let target = null;           // [string, fret]
let candidates = [];         // active cells in duel mode
let correct = 0, total = 0, streak = 0;

const statusEl = document.getElementById('status');
const scoreEl = document.getElementById('score');
const playBtn = document.getElementById('playBtn');
const nextBtn = document.getElementById('nextBtn');
const hintEl = document.getElementById('hint');
const cells = []; // cells[s][f] -> td

const HINTS = {
  explore: 'Free play: tap any position to hear it. Use this to judge whether the synth timbres feel right against your real guitar.',
  pitch: 'A note plays. Tap ANY position with that pitch — any string counts. Trains pitch → fretboard mapping.',
  exact: 'A note plays. Tap the EXACT position it was played at. Same pitch on the wrong string is a miss — listen for the timbre.',
  duel: 'The core exercise: one pitch, several possible positions (highlighted). Which one did you just hear?',
};

function setStatus(msg, cls) {
  statusEl.textContent = msg;
  statusEl.className = cls || '';
}
function updateScore() {
  scoreEl.innerHTML = mode === 'explore' ? '' :
    `<b>${correct}</b>/${total} &nbsp; streak <b>${streak}</b>`;
}

function clearBoardMarks() {
  for (const row of cells) for (const td of row) {
    td.classList.remove('candidate', 'disabled', 'correct', 'wrong', 'played');
  }
}

function newRound() {
  clearBoardMarks();
  phase = 'listening';
  nextBtn.disabled = true;
  playBtn.disabled = false;

  if (mode === 'duel') {
    // Pick a pitch with at least 2 positions in range, then one position of it.
    let midi, positions;
    do {
      const s = Math.floor(Math.random() * 6);
      const f = Math.floor(Math.random() * (NUM_FRETS + 1));
      midi = midiAt(s, f);
      positions = unisonPositions(midi);
    } while (positions.length < 2);
    candidates = positions;
    target = positions[Math.floor(Math.random() * positions.length)];
    for (const row of cells) for (const td of row) td.classList.add('disabled');
    for (const [s, f] of candidates) {
      cells[s][f].classList.remove('disabled');
      cells[s][f].classList.add('candidate');
    }
    setStatus(`This pitch (${noteName(midi)}) lives at ${candidates.length} highlighted spots. Which one is playing?`);
  } else {
    candidates = [];
    const s = Math.floor(Math.random() * 6);
    const f = Math.floor(Math.random() * (NUM_FRETS + 1));
    target = [s, f];
    setStatus(mode === 'pitch'
      ? 'Listen… tap any position that matches this pitch.'
      : 'Listen… tap the exact position this was played at.');
  }
  playNote(target[0], target[1]);
}

function answer(s, f) {
  const [ts, tf] = target;
  const isRight = mode === 'pitch' ? midiAt(s, f) === midiAt(ts, tf) : (s === ts && f === tf);
  total++;
  phase = 'review';
  nextBtn.disabled = false;

  cells[ts][tf].classList.add('correct');
  cells[ts][tf].querySelector('.dot').textContent = noteName(midiAt(ts, tf));
  for (const row of cells) for (const td of row) td.classList.remove('disabled');

  if (isRight) {
    correct++; streak++;
    setStatus(`✓ Yes — that was ${posLabel(ts, tf)} (${noteName(midiAt(ts, tf))}).`, 'good');
  } else {
    streak = 0;
    cells[s][f].classList.add('wrong');
    cells[s][f].querySelector('.dot').textContent = noteName(midiAt(s, f));
    const samePitch = midiAt(s, f) === midiAt(ts, tf);
    setStatus(samePitch
      ? `✗ Right pitch, wrong spot. That was ${posLabel(ts, tf)}, you tapped ${posLabel(s, f)} — same ${noteName(midiAt(ts, tf))}, different timbre. Tap both to compare.`
      : `✗ That was ${posLabel(ts, tf)} (${noteName(midiAt(ts, tf))}), you tapped ${posLabel(s, f)} (${noteName(midiAt(s, f))}). Tap around to compare, then Next.`,
      'bad');
  }
  updateScore();
}

function onCellTap(s, f) {
  ensureCtx();
  if (mode === 'explore') {
    clearBoardMarks();
    cells[s][f].classList.add('played');
    cells[s][f].querySelector('.dot').textContent = noteName(midiAt(s, f));
    playNote(s, f);
    setStatus(`${posLabel(s, f)} — ${noteName(midiAt(s, f))}`);
    return;
  }
  if (phase === 'listening') {
    if (mode === 'duel' && !candidates.some(([cs, cf]) => cs === s && cf === f)) return;
    playNote(s, f); // hear your answer as feedback
    answer(s, f);
  } else if (phase === 'review') {
    playNote(s, f); // free comparison listening between rounds
  }
}

// ---------------------------------------------------------------------------
// Board construction + wiring
// ---------------------------------------------------------------------------
function buildBoard() {
  const wrap = document.getElementById('boardwrap');
  const table = document.createElement('table');

  const head = document.createElement('tr');
  head.appendChild(document.createElement('th'));
  for (let f = 0; f <= NUM_FRETS; f++) {
    const th = document.createElement('th');
    th.className = 'fretnum';
    th.textContent = f;
    head.appendChild(th);
  }
  table.appendChild(head);

  const inlayFrets = [3, 5, 7, 9, 12, 15];
  for (let s = 0; s < 6; s++) {
    const tr = document.createElement('tr');
    const label = document.createElement('th');
    label.className = 'stringname';
    label.textContent = STRINGS[s].name;
    tr.appendChild(label);
    cells[s] = [];
    for (let f = 0; f <= NUM_FRETS; f++) {
      const td = document.createElement('td');
      td.className = 'fret' + (f === 0 ? ' nut' : '');
      const wire = document.createElement('div');
      wire.className = 'str';
      wire.style.height = (1 + s * 0.5) + 'px'; // thicker lines for lower strings
      td.appendChild(wire);
      if (s === 2 && f !== 0 && inlayFrets.includes(f)) {
        const inlay = document.createElement('div');
        inlay.className = 'inlay';
        td.appendChild(inlay);
      }
      const dot = document.createElement('div');
      dot.className = 'dot';
      td.appendChild(dot);
      td.addEventListener('pointerdown', () => onCellTap(s, f));
      cells[s][f] = td;
      tr.appendChild(td);
    }
    table.appendChild(tr);
  }
  wrap.appendChild(table);
}

document.querySelectorAll('.modes button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.modes button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    mode = btn.dataset.mode;
    correct = 0; total = 0; streak = 0;
    hintEl.textContent = HINTS[mode];
    updateScore();
    clearBoardMarks();
    if (mode === 'explore') {
      phase = 'idle';
      playBtn.disabled = true;
      nextBtn.disabled = true;
      setStatus('Free play — tap any position to hear it.');
    } else {
      newRound();
    }
  });
});

playBtn.addEventListener('click', () => {
  if (target && phase !== 'idle') playNote(target[0], target[1]);
});
nextBtn.addEventListener('click', newRound);

buildBoard();
hintEl.textContent = HINTS.explore;
playBtn.disabled = true;
updateScore();
