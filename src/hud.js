import * as THREE from 'three';
import { clamp } from './shared.js';

const $ = (id) => document.getElementById(id);
const pad = (n, l = 2) => String(n).padStart(l, '0');

const el = {
  clock: $('clock'), date: $('date'), status: $('statusText'), mode: $('modeName'), ts: $('timeScale'),
  log: $('log'), wave: $('wave'), inspector: $('inspector'),
  inspId: $('inspId'), inspName: $('inspName'), inspDesc: $('inspDesc'), inspBars: $('inspBars'), inspLock: $('inspLock'),
  az: $('rAz'), elv: $('rEl'), dist: $('rDist'), swarm: $('rSwarm'), swarmLabel: $('rSwarmLabel'), fps: $('rFps'), up: $('rUp'),
  explode: $('explode'), explodeVal: $('explodeVal'), simClock: $('simClock'), hints: $('hints'),
  banner: $('banner'), reticle: $('reticle'), reticleDot: $('reticleDot'), reticleTag: $('reticleTag'),
  labels: $('labels'), leaders: $('leaders'),
  boot: $('boot'), bootText: $('bootText'), bootBar: $('bootBar'),
};

/* ---------- log ---------- */
const stamp = () => {
  const d = new Date();
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
};
export function log(msg, cls = '') {
  const p = document.createElement('p');
  if (cls) p.className = cls;
  const i = document.createElement('i');
  i.textContent = stamp();
  p.append(i, msg);
  el.log.appendChild(p);
  while (el.log.children.length > 16) el.log.firstChild.remove();
}

const CHATTER = {
  holo: [
    'field coil 02 — phase lock 99.97%', 'lattice node 41 resynchronised', 'swarm coherence nominal',
    'zenith uplink handshake ok', 'injector 05 pulse width 82 fs', 'thermal bleed → ground anchor',
    'operator gaze vector tracked', 'memory lattice defrag pass 7/9', 'psi-band carrier stable',
    'harmonic 17 damped', 'telemetry ring sweep complete', 'neural bridge latency 0.4 ms',
  ],
  construct: [
    'loading construct geometry…', 'residual self-image rendered', 'glyph stream decoded 1:1',
    'there is no deck plate', 'white-room subroutine idle', 'carrier signal traced to source',
    'operator jacked in', 'reality checksum mismatch — ignored', 'follow the white signal',
  ],
  breach: [
    'CORE PRESSURE 140% OF RATED', 'lattice node 12 OFFLINE', 'injector 03 runaway',
    'shell 06 delaminating', 'coolant loop B — NO FLOW', 'containment field collapsing',
    'recommend manual separation', 'ground anchor saturated', 'evacuate deck 4',
  ],
};

/* ---------- gauges ---------- */
const gauges = {};
document.querySelectorAll('.gauge').forEach((g) => {
  gauges[g.dataset.g] = { ring: g.querySelector('.val'), num: g.querySelector('b'), label: g.querySelector('label'), v: 0 };
});
function setGauge(name, v, text) {
  const g = gauges[name];
  g.v += (v - g.v) * 0.12;
  g.ring.style.strokeDashoffset = (201 * (1 - clamp(g.v))).toFixed(1);
  g.num.textContent = text != null ? text : pad(Math.round(clamp(g.v) * 99));
}
const GAUGE_LABELS = {
  core: { output: 'OUTPUT', stability: 'STABILITY', entropy: 'ENTROPY' },
  terra: { output: 'Kp INDEX', stability: 'SOLAR KM/S', entropy: 'MAX M · 24H' },
};

/* ---------- planetary feed rows ---------- */
const feedRows = {};
document.querySelectorAll('#feeds li').forEach((li) => { feedRows[li.dataset.feed] = { li, val: li.querySelector('span') }; });
const FEED_TIPS = {
  live: 'live feed', cached: 'cached copy — refresh pending', snapshot: 'bundled snapshot — live source unavailable',
  offline: 'no signal', pending: 'connecting',
};
export function setFeed(name, status, text) {
  const r = feedRows[name];
  if (!r) return;
  r.li.dataset.status = status;
  r.val.textContent = text;
  r.li.title = FEED_TIPS[status] || '';
}

/* ---------- waveform ---------- */
const wctx = el.wave.getContext('2d');
function drawWave(t, energy, color) {
  const w = el.wave.width, h = el.wave.height;
  wctx.clearRect(0, 0, w, h);
  wctx.strokeStyle = color;
  wctx.shadowColor = color;
  wctx.shadowBlur = 8;
  wctx.lineWidth = 2;
  wctx.beginPath();
  for (let x = 0; x <= w; x += 4) {
    const env = Math.sin((x / w) * Math.PI);
    const y = h / 2 + (Math.sin(x * 0.045 + t * 5) * 0.5 + Math.sin(x * 0.13 - t * 8.5) * 0.3 + Math.sin(x * 0.31 + t * 14) * 0.2) * env * (10 + energy * 40);
    x ? wctx.lineTo(x, y) : wctx.moveTo(x, y);
  }
  wctx.stroke();
  wctx.shadowBlur = 0;
  wctx.globalAlpha = 0.35;
  wctx.lineWidth = 1;
  wctx.beginPath();
  wctx.moveTo(0, h / 2);
  wctx.lineTo(w, h / 2);
  wctx.stroke();
  wctx.globalAlpha = 1;
}

/* ---------- inspector ---------- */
let shown = null;
let shownStats = null;
let bars = [];
function buildBars(stats) {
  shownStats = stats;
  el.inspBars.replaceChildren();
  bars = stats.map(([label, v, text]) => {
    const row = document.createElement('div');
    row.className = 'bar';
    const l = document.createElement('label');
    l.textContent = label;
    const track = document.createElement('div');
    const fill = document.createElement('i');
    track.appendChild(fill);
    const num = document.createElement('span');
    row.append(l, track, num);
    if (text != null) {
      row.classList.add('real');
      fill.style.width = `${(clamp(v) * 100).toFixed(0)}%`;
      num.textContent = text;
    }
    el.inspBars.appendChild(row);
    return { fill, num, v, real: text != null };
  });
}
export function inspect(part, locked) {
  el.inspLock.textContent = locked ? 'TARGET ISOLATED' : 'SCANNING';
  el.inspLock.classList.toggle('locked', !!locked);
  if (part === shown) {
    if (part && part.info.stats !== shownStats) buildBars(part.info.stats); // live telemetry refreshed
    return;
  }
  shown = part;
  el.inspector.classList.toggle('has', !!part);
  if (!part) return;
  const { id, name, desc, stats } = part.info;
  el.inspId.textContent = id;
  el.inspName.textContent = name;
  el.inspDesc.textContent = desc;
  buildBars(stats);
}

/* ---------- callouts (exploded-view parts, and things on / around the planet) ---------- */
const SVG = 'http://www.w3.org/2000/svg';
const callouts = [];
export function addCallouts(labels, group) {
  labels.forEach((L, i) => {
    const node = document.createElement('div');
    node.className = 'callout';
    const inner = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = L.title;
    const s = document.createElement('small');
    s.textContent = L.sub;
    inner.append(b, s);
    node.appendChild(inner);
    el.labels.appendChild(node);
    const line = document.createElementNS(SVG, 'polyline');
    const dot = document.createElementNS(SVG, 'circle');
    dot.setAttribute('r', 4);
    el.leaders.append(line, dot);
    callouts.push({ L, group, node, b, s, line, dot, i, x: 0, y: 0, lx: 0, ly: 0, side: 1, vis: 0, w: 0, shownVis: '' });
  });
}

const v = new THREE.Vector3();
const asideL = document.querySelector('aside.left');
const asideR = document.querySelector('aside.right');
let free = { l: 0, r: innerWidth, at: -1 };
function freeZone(w) {
  // callouts stay in the gap between the side panels
  const now = performance.now();
  if (now - free.at < 500) return free;
  const a = asideL.getBoundingClientRect();
  const b = asideR.getBoundingClientRect();
  free = { l: a.width ? a.right + 12 : 12, r: b.width ? b.left - 12 : w - 12, at: now };
  return free;
}
function updateCallouts(camera, groupVis, w, h) {
  const zone = freeZone(w);
  const sides = { '-1': [], 1: [] };
  for (const c of callouts) {
    const gv = groupVis[c.group] || 0;
    // parts stagger in as the assembly separates; planet labels follow their own line of sight
    const want = c.L.front != null ? gv * c.L.front : clamp(gv * 1.6 - c.i * 0.06);
    if (want <= 0.01) { c.vis = 0; continue; }
    if (c.L.dirty) { c.b.textContent = c.L.title; c.s.textContent = c.L.sub; c.L.dirty = false; c.w = 0; }
    c.L.anchor.getWorldPosition(v).project(camera);
    c.x = (v.x * 0.5 + 0.5) * w;
    c.y = (-v.y * 0.5 + 0.5) * h;
    const on = v.z < 1 && c.x > zone.l && c.x < zone.r && c.y > 70 && c.y < h - 110;
    c.vis = on ? clamp(want) : 0;
    // hysteresis so labels don't flip sides while the model turns
    if (c.x > w / 2 + 30) c.side = 1; else if (c.x < w / 2 - 30) c.side = -1;
    c.lx = c.x + c.side * 84;
    if (!c.w) c.w = c.node.firstChild.offsetWidth;
    if (c.side > 0 && c.lx + c.w > zone.r) c.side = -1;
    else if (c.side < 0 && c.lx - c.w < zone.l) c.side = 1;
    c.lx = c.x + c.side * 84;
    c.ly = c.y - 44;
    if (c.vis > 0) sides[c.side].push(c);
  }
  for (const key of [-1, 1]) {
    const list = sides[key].sort((a, b) => a.ly - b.ly);
    for (let i = 1; i < list.length; i++) {
      if (list[i].ly - list[i - 1].ly < 42) list[i].ly = list[i - 1].ly + 42;
    }
  }
  for (const c of callouts) {
    const o = c.vis.toFixed(2);
    if (c.shownVis !== o) {
      c.shownVis = o;
      c.node.style.opacity = o;
      c.line.style.opacity = o * 0.75;
      c.dot.style.opacity = o;
    }
    if (c.vis <= 0) continue;
    c.node.classList.toggle('flip', c.side < 0);
    c.node.style.transform = `translate(${c.lx.toFixed(1)}px, ${(c.ly - 17).toFixed(1)}px)`;
    c.line.setAttribute('points', `${c.x.toFixed(1)},${c.y.toFixed(1)} ${(c.x + c.side * 34).toFixed(1)},${c.ly.toFixed(1)} ${c.lx.toFixed(1)},${c.ly.toFixed(1)}`);
    c.dot.setAttribute('cx', c.x.toFixed(1));
    c.dot.setAttribute('cy', c.y.toFixed(1));
  }
}

/* ---------- banner ---------- */
export function banner(title, sub = '') {
  el.banner.replaceChildren(title);
  if (sub) {
    const s = document.createElement('small');
    s.textContent = sub;
    el.banner.appendChild(s);
  }
  el.banner.classList.remove('show');
  void el.banner.offsetWidth;
  el.banner.classList.add('show');
}

/* ---------- reticle ---------- */
const ret = { x: innerWidth / 2, y: innerHeight / 2, tx: innerWidth / 2, ty: innerHeight / 2 };
export function reticleTo(x, y) {
  ret.tx = x; ret.ty = y;
  el.reticleDot.style.transform = `translate(${x}px, ${y}px)`;
}
export function reticleState(tag, down) {
  el.reticle.classList.toggle('lock', !!tag);
  el.reticle.classList.toggle('down', !!down);
  if (tag) el.reticleTag.textContent = tag;
}

/* ---------- boot ---------- */
const BOOT = [
  'NYX-7 KERNEL 9.4.1 ................. OK',
  'HOLOGRAPHIC PROJECTORS ............. ONLINE',
  'PARTICLE SWARM  [80 000 UNITS] ..... LINKED',
  'USGS SEISMIC NETWORK ............... LISTENING',
  'ORBITAL CATALOG  [CELESTRAK] ....... TRACKING',
  'NOAA SPACE WEATHER ................. SYNCHRONISED',
  '',
  '> WAKE UP, OPERATOR. THE PLANET IS TALKING.',
];
export function boot(onDone) {
  const full = BOOT.join('\n');
  const start = performance.now();
  const DURATION = 2800;
  // clock-driven, so a throttled tab still finishes on time
  const step = () => {
    const i = Math.min(full.length, Math.floor(((performance.now() - start) / DURATION) * full.length));
    el.bootText.textContent = full.slice(0, i) + (i < full.length ? '█' : '');
    el.bootBar.style.width = `${(i / full.length) * 100}%`;
    if (i < full.length) setTimeout(step, 16);
    else setTimeout(() => {
      el.boot.classList.add('done');
      document.body.classList.add('online');
      onDone();
    }, 550);
  };
  step();
}

/* ---------- mode / view ---------- */
export function setMode(mode, palette) {
  document.body.classList.remove('mode-holo', 'mode-construct', 'mode-breach');
  document.body.classList.add(`mode-${mode}`);
  el.mode.textContent = palette.label;
}

const HINTS = {
  core: [['DRAG', 'orbit'], ['SCROLL', 'separate'], ['HOLD SPACE', 'dilate time'], ['CLICK', 'isolate / pulse'], ['T', 'planet'], ['M', 'layer'], ['H', 'hide HUD']],
  terra: [['DRAG', 'orbit'], ['SCROLL', 'zoom'], ['HOLD SPACE', 'fast-forward time'], ['HOVER', 'scan quakes + stations'], ['T', 'core'], ['M', 'layer'], ['H', 'hide HUD']],
};
let hintTimer = 0;
export function setView(view) {
  document.body.classList.toggle('view-terra', view === 'terra');
  document.body.classList.toggle('view-core', view !== 'terra');
  for (const [k, text] of Object.entries(GAUGE_LABELS[view])) gauges[k].label.textContent = text;
  el.swarmLabel.textContent = view === 'terra' ? 'CURSOR' : 'SWARM';
  el.hints.replaceChildren(...HINTS[view].map(([k, t]) => {
    const s = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = k;
    s.append(b, t);
    return s;
  }));
  document.body.classList.remove('hints-off');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => document.body.classList.add('hints-off'), 18000);
}

export function setExplodeUI(e) {
  const pct = Math.round(e * 100);
  if (document.activeElement !== el.explode || Math.abs(el.explode.value - pct) > 1) el.explode.value = pct;
  el.explodeVal.textContent = `${pad(pct, 3)}%`;
}

/* ---------- per-frame ---------- */
let logTimer = 1.5;
let slow = 0;
const t0 = performance.now();
const DAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];

export function update(rawDt, s) {
  // reticle ring trails the pointer
  ret.x += (ret.tx - ret.x) * Math.min(1, rawDt * 16);
  ret.y += (ret.ty - ret.y) * Math.min(1, rawDt * 16);
  el.reticle.style.transform = `translate(${ret.x.toFixed(1)}px, ${ret.y.toFixed(1)}px)`;

  updateCallouts(s.camera, s.calloutVis, innerWidth, innerHeight);
  drawWave(s.time, s.energy, s.colorCss);

  // everything below is text — 12 Hz is plenty
  slow += rawDt;
  if (slow < 0.08) return;
  slow = 0;

  const terra = s.view === 'terra';
  if (terra) {
    // the planet runs on simulated UTC so the time-warp is legible
    const d = new Date(s.simMs);
    el.clock.firstChild.nodeValue = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
    el.clock.lastChild.textContent = ' UTC';
    const off = s.simOffset;
    const a = Math.abs(off);
    const offTxt = a < 2 ? 'LIVE'
      : `T${off > 0 ? '+' : '−'}${a >= 86400 ? `${(a / 86400).toFixed(1)}D` : `${pad(Math.floor(a / 3600))}:${pad(Math.floor((a % 3600) / 60))}:${pad(Math.floor(a % 60))}`}`;
    el.date.textContent = `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())} · ${offTxt}`;
    el.simClock.textContent = offTxt;
    el.ts.textContent = s.rate >= 10 ? s.rate.toFixed(0) : s.rate.toFixed(2);
  } else {
    const d = new Date();
    el.clock.firstChild.nodeValue = `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
    el.clock.lastChild.textContent = `.${pad(d.getMilliseconds(), 3)}`;
    el.date.textContent = `${DAYS[d.getDay()]} ${d.getFullYear()}.${pad(d.getMonth() + 1)}.${pad(d.getDate())} · SOL-3`;
    el.ts.textContent = s.timeScale.toFixed(2);
  }
  el.status.textContent = s.status;

  const breach = s.mode === 'breach';
  if (terra && s.real) {
    const r = s.real;
    setGauge('output', r.kp != null ? r.kp / 9 : 0, r.kp != null ? r.kp.toFixed(1) : '—');
    setGauge('stability', r.wind != null ? (r.wind - 250) / 600 : 0, r.wind != null ? Math.round(r.wind) : '—');
    setGauge('entropy', r.maxMag != null ? r.maxMag / 9 : 0, r.maxMag != null ? r.maxMag.toFixed(1) : '—');
  } else {
    const n = (k) => Math.sin(s.time * k) * 0.5 + 0.5;
    setGauge('output', 0.62 + 0.2 * n(0.9) + s.energy * 0.3 + (breach ? 0.25 : 0));
    setGauge('stability', (breach ? 0.22 : 0.93) - s.explode * 0.3 + 0.05 * n(1.7) - s.energy * 0.2);
    setGauge('entropy', 0.12 + s.explode * 0.35 + (breach ? 0.5 : 0) + 0.08 * n(2.3) + (1 - s.timeScale) * 0.3);
  }

  for (const b of bars) {
    if (b.real) continue; // measured values don't get cosmetic jitter
    const val = clamp(b.v + (Math.random() - 0.5) * 0.03);
    b.fill.style.width = `${(val * 100).toFixed(0)}%`;
    b.num.textContent = (val * 100).toFixed(1);
  }

  const sph = s.spherical;
  el.az.textContent = `${pad((((sph.theta * 180) / Math.PI + 360) % 360).toFixed(1), 5)}°`;
  const elev = 90 - (sph.phi * 180) / Math.PI;
  el.elv.textContent = `${elev >= 0 ? '+' : '−'}${pad(Math.abs(elev).toFixed(1), 4)}°`;
  el.dist.textContent = terra ? `${Math.round(s.rangeKm).toLocaleString('en-US')} km` : `${sph.radius.toFixed(1)} m`;
  el.swarm.textContent = terra ? s.cursor : s.formation.toUpperCase();
  el.fps.textContent = `${pad(Math.round(s.fps))} FPS`;
  const up = Math.floor((performance.now() - t0) / 1000);
  el.up.textContent = `${pad(Math.floor(up / 60))}:${pad(up % 60)}`;

  logTimer -= 0.08;
  if (logTimer <= 0 && s.online && (!terra || breach)) {
    const lines = CHATTER[s.mode];
    log(lines[(Math.random() * lines.length) | 0], breach ? 'warn' : '');
    logTimer = breach ? 0.35 + Math.random() * 0.5 : 0.9 + Math.random() * 2.2;
  }
}

export { el };
