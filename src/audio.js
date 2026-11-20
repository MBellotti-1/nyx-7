// Tiny synthesised soundscape — no samples, all oscillators. Off until the operator asks.
let ctx = null;
let master = null;
let drone = null;
let on = false;

function ensure() {
  if (ctx) return;
  ctx = new (window.AudioContext || window.webkitAudioContext)();
  master = ctx.createGain();
  master.gain.value = 0;
  master.connect(ctx.destination);

  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 220;
  lp.Q.value = 6;
  const g = ctx.createGain();
  g.gain.value = 0.22;
  [55, 55.4, 82.6, 110.3].forEach((f, i) => {
    const o = ctx.createOscillator();
    o.type = i < 2 ? 'sawtooth' : 'sine';
    o.frequency.value = f;
    o.connect(lp);
    o.start();
  });
  const lfo = ctx.createOscillator();
  const lfoG = ctx.createGain();
  lfo.frequency.value = 0.11;
  lfoG.gain.value = 90;
  lfo.connect(lfoG).connect(lp.frequency);
  lfo.start();
  lp.connect(g).connect(master);
  drone = { lp };
}

function tone(freq, to, dur, vol, type = 'sine') {
  if (!on) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  o.frequency.exponentialRampToValueAtTime(to, t + dur);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + dur + 0.02);
}

export const audio = {
  get on() { return on; },
  toggle() {
    ensure();
    on = !on;
    ctx.resume();
    master.gain.cancelScheduledValues(ctx.currentTime);
    master.gain.linearRampToValueAtTime(on ? 0.55 : 0, ctx.currentTime + 0.4);
    return on;
  },
  blip() { tone(1400, 2200, 0.05, 0.05, 'square'); },
  select() { tone(660, 1320, 0.14, 0.09, 'triangle'); },
  pulse() { tone(220, 28, 1.1, 0.5, 'sine'); tone(1800, 200, 0.5, 0.06, 'sawtooth'); },
  shift() { tone(90, 720, 0.5, 0.14, 'sawtooth'); tone(1440, 180, 0.6, 0.06, 'square'); },
  // sonified seismicity: bigger quakes ring lower and longer
  quake(mag) { tone(Math.max(70, 980 - mag * 125), 50, 0.08 + mag * 0.07, 0.015 + mag * 0.014, mag >= 5.5 ? 'sawtooth' : 'sine'); },
  dilate(v) {
    if (!on || !drone) return;
    drone.lp.frequency.setTargetAtTime(220 + v * 900, ctx.currentTime, 0.2);
  },
};
