import * as THREE from 'three';
import { clamp } from './shared.js';

const $ = (id) => document.getElementById(id);
const pad = (n, l = 2) => String(n).padStart(l, '0');

const el = {
  clock: $('clock'), date: $('date'), status: $('statusText'), mode: $('modeName'), ts: $('timeScale'),
  log: $('log'), wave: $('wave'), inspector: $('inspector'), ticker: $('ticker'),
  inspId: $('inspId'), inspName: $('inspName'), inspDesc: $('inspDesc'), inspBars: $('inspBars'), inspLock: $('inspLock'),
  az: $('rAz'), elv: $('rEl'), dist: $('rDist'), cursor: $('rCursor'), fps: $('rFps'), up: $('rUp'),
  nSub: $('nSub'), nSun: $('nSun'), nMoon: $('nMoon'), nQ24: $('nQ24'), nEnergy: $('nEnergy'), nStar: $('nStar'),
  split: $('split'), splitVal: $('splitVal'), simClock: $('simClock'), hints: $('hints'),
  mag: $('mag'), magVal: $('magVal'), cityName: $('cityName'), cityList: $('cityList'),
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

// flavour only — the two fictional reality layers talk; HOLO stays strictly factual
const CHATTER = {
  construct: [
    'loading construct geometry…', 'residual self-image rendered', 'glyph stream decoded 1:1',
    'there is no ground', 'carrier signal traced to source', 'operator jacked in',
    'reality checksum mismatch — ignored', 'follow the white signal',
  ],
  breach: [
    'PLANETARY LINK UNSTABLE', 'telemetry checksum failed', 'uplink 03 dropped',
    'projection lattice desynchronised', 'signal integrity 41%', 'rerouting through backup relay',
  ],
};

/* ---------- gauges ---------- */
const gauges = {};
document.querySelectorAll('.gauge').forEach((g) => {
  gauges[g.dataset.g] = { ring: g.querySelector('.val'), num: g.querySelector('b'), v: 0 };
});
function setGauge(name, v, text) {
  const g = gauges[name];
  g.v += (clamp(v) - g.v) * 0.12;
  g.ring.style.strokeDashoffset = (201 * (1 - g.v)).toFixed(1);
  g.num.textContent = text;
}

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

/* ---------- ticker: one scrolling line of whatever is true right now ---------- */
let tickX = 0;
let tickW = 0;
let tickNext = null;
function applyTicker() {
  const frag = document.createDocumentFragment();
  for (let pass = 0; pass < 2; pass++) { // doubled, so the loop point is seamless
    for (const [label, value] of tickNext) {
      const sep = document.createElement('i');
      sep.textContent = '◆';
      const b = document.createElement('b');
      b.textContent = value;
      frag.append(sep, `${label} `, b);
    }
  }
  el.ticker.replaceChildren(frag);
  tickW = el.ticker.scrollWidth / 2;
  tickNext = null;
}
export function setTicker(items) {
  tickNext = items;
  if (!tickW) applyTicker();
}

/* ---------- waveform ---------- */
const wctx = el.wave.getContext('2d');
function drawWave(t, energy, color) {
  if (!el.wave.offsetParent) return; // hidden on short screens
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
}

/* ---------- inspector ---------- */
let shown = null;
let shownStats = null;
function buildBars(stats) {
  shownStats = stats;
  el.inspBars.replaceChildren(...stats.map(([label, v, text]) => {
    const row = document.createElement('div');
    row.className = 'bar real';
    const l = document.createElement('label');
    l.textContent = label;
    const track = document.createElement('div');
    const fill = document.createElement('i');
    fill.style.width = `${(clamp(v) * 100).toFixed(0)}%`;
    track.appendChild(fill);
    const num = document.createElement('span');
    num.textContent = text;
    row.append(l, track, num);
    return row;
  }));
}
export function inspect(part, locked) {
  el.inspLock.textContent = locked ? 'TARGET LOCKED' : 'SCANNING';
  el.inspLock.classList.toggle('locked', !!locked);
  if (part === shown) {
    if (part && part.info.stats !== shownStats) buildBars(part.info.stats); // live values refreshed
    return;
  }
  shown = part;
  el.inspector.classList.toggle('has', !!part);
  if (!part) return;
  el.inspId.textContent = part.info.id;
  el.inspName.textContent = part.info.name;
  el.inspDesc.textContent = part.info.desc;
  buildBars(part.info.stats);
}

/* ---------- callouts: labelled leader lines to things in the 3D scene ---------- */
const SVG = 'http://www.w3.org/2000/svg';
const callouts = [];
export function addCallouts(labels) {
  labels.forEach((L) => {
    const node = document.createElement('div');
    node.className = L.mini ? 'callout mini' : 'callout';
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
    dot.setAttribute('r', L.mini ? 2.5 : 4);
    el.leaders.append(line, dot);
    callouts.push({ L, node, b, s, line, dot, x: 0, y: 0, lx: 0, ly: 0, side: 1, vis: 0, w: 0, shownVis: '', hgt: L.mini ? 22 : 42 });
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
    const want = (groupVis[c.L.group] || 0) * c.L.front;
    if (want <= 0.01) { c.vis = 0; continue; }
    if (c.L.dirty) { c.b.textContent = c.L.title; c.s.textContent = c.L.sub; c.L.dirty = false; c.w = 0; }
    c.L.anchor.getWorldPosition(v).project(camera);
    c.x = (v.x * 0.5 + 0.5) * w;
    c.y = (-v.y * 0.5 + 0.5) * h;
    const on = v.z < 1 && c.x > zone.l && c.x < zone.r && c.y > 104 && c.y < h - 112;
    c.vis = on ? clamp(want) : 0;
    if (!c.vis) continue;
    const reach = c.L.mini ? 44 : 84;
    // hysteresis so labels don't flip sides while the scene turns
    if (c.x > w / 2 + 30) c.side = 1; else if (c.x < w / 2 - 30) c.side = -1;
    c.lx = c.x + c.side * reach;
    if (!c.w) c.w = c.node.firstChild.offsetWidth;
    if (c.side > 0 && c.lx + c.w > zone.r) c.side = -1;
    else if (c.side < 0 && c.lx - c.w < zone.l) c.side = 1;
    c.lx = c.x + c.side * reach;
    c.ly = c.y - (c.L.mini ? 24 : 44);
    sides[c.side].push(c);
  }
  for (const key of [-1, 1]) {
    const list = sides[key].sort((a, b) => a.ly - b.ly);
    for (let i = 1; i < list.length; i++) {
      const gap = (list[i].hgt + list[i - 1].hgt) / 2;
      if (list[i].ly - list[i - 1].ly < gap) list[i].ly = list[i - 1].ly + gap;
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
    c.node.style.transform = `translate(${c.lx.toFixed(1)}px, ${(c.ly - (c.L.mini ? 9 : 17)).toFixed(1)}px)`;
    c.line.setAttribute('points', `${c.x.toFixed(1)},${c.y.toFixed(1)} ${(c.x + c.side * (c.L.mini ? 18 : 34)).toFixed(1)},${c.ly.toFixed(1)} ${c.lx.toFixed(1)},${c.ly.toFixed(1)}`);
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
  'CITY MODELS  [OPENSTREETMAP] ....... STANDING BY',
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
  orbit: [['DRAG', 'orbit'], ['SCROLL', 'zoom'], ['X', 'split the planet'], ['HOLD SPACE', 'fast-forward time'], ['CLICK A CITY', 'descend'], ['M', 'layer'], ['H', 'hide HUD']],
  city: [['DRAG', 'orbit'], ['SCROLL', 'zoom'], ['Q', 'trigger stress test'], ['R', 'reset'], ['← →', 'next city'], ['ESC', 'back to orbit']],
};
let hintTimer = 0;
export function setView(view) {
  document.body.classList.toggle('view-city', view === 'city');
  document.body.classList.toggle('view-orbit', view !== 'city');
  el.hints.replaceChildren(...HINTS[view].map(([k, t]) => {
    const s = document.createElement('span');
    const b = document.createElement('b');
    b.textContent = k;
    s.append(b, t);
    return s;
  }));
  document.body.classList.remove('hints-off');
  clearTimeout(hintTimer);
  hintTimer = setTimeout(() => document.body.classList.add('hints-off'), 20000);
}

export function setSplitUI(x) {
  const pct = Math.round(x * 100);
  if (document.activeElement !== el.split || Math.abs(el.split.value - pct) > 1) el.split.value = pct;
  el.splitVal.textContent = `${pad(pct, 3)}%`;
}

/* ---------- city list ---------- */
const cityRows = new Map();
export function buildCityList(cities, onPick) {
  el.cityList.replaceChildren(...cities.map((c) => {
    const li = document.createElement('li');
    const btn = document.createElement('button');
    btn.type = 'button';
    const dot = document.createElement('i');
    const name = document.createElement('b');
    name.textContent = c.name;
    const time = document.createElement('span');
    const near = document.createElement('em');
    btn.append(dot, name, time, near);
    btn.addEventListener('click', () => onPick(c.id));
    li.appendChild(btn);
    cityRows.set(c.id, { li, dot, time, near, btn });
    return li;
  }));
}
/** rows: [{ id, time, night, near }], active: city id currently open (or null) */
export function updateCities(rows, active) {
  for (const r of rows) {
    const row = cityRows.get(r.id);
    if (!row) continue;
    row.time.textContent = r.time;
    row.near.textContent = r.near;
    row.dot.className = r.night ? 'night' : '';
    row.btn.title = r.tip;
    row.li.classList.toggle('active', r.id === active);
  }
}
export function setCityUI(name, mag) {
  el.cityName.textContent = name;
  el.magVal.textContent = `M ${mag.toFixed(1)}`;
}

/* ---------- per-frame ---------- */
let logTimer = 1.5;
let slow = 0;
const t0 = performance.now();

export function update(rawDt, s) {
  // reticle ring trails the pointer
  ret.x += (ret.tx - ret.x) * Math.min(1, rawDt * 16);
  ret.y += (ret.ty - ret.y) * Math.min(1, rawDt * 16);
  el.reticle.style.transform = `translate(${ret.x.toFixed(1)}px, ${ret.y.toFixed(1)}px)`;

  updateCallouts(s.camera, s.calloutVis, innerWidth, innerHeight);
  drawWave(s.time, s.energy, s.colorCss);

  if (tickW) {
    tickX += rawDt * 42;
    if (tickX >= tickW) { tickX -= tickW; if (tickNext) applyTicker(); }
    el.ticker.style.transform = `translateX(${(-tickX).toFixed(1)}px)`;
  }

  // everything below is text — 12 Hz is plenty
  slow += rawDt;
  if (slow < 0.08) return;
  slow = 0;

  // the planet runs on simulated UTC so the time-warp is legible
  const d = new Date(s.simMs);
  el.clock.firstChild.nodeValue = `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`;
  const off = s.simOffset;
  const a = Math.abs(off);
  const offTxt = a < 2 ? 'LIVE'
    : `T${off > 0 ? '+' : '−'}${a >= 86400 ? `${(a / 86400).toFixed(1)}D` : `${pad(Math.floor(a / 3600))}:${pad(Math.floor((a % 3600) / 60))}:${pad(Math.floor(a % 60))}`}`;
  el.date.textContent = `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())} · ${offTxt}`;
  el.simClock.textContent = offTxt;
  el.ts.textContent = s.rate >= 10 ? s.rate.toFixed(0) : s.rate.toFixed(2);
  el.status.textContent = s.status;

  const r = s.real;
  setGauge('kp', r.kp != null ? r.kp / 9 : 0, r.kp != null ? r.kp.toFixed(1) : '—');
  setGauge('wind', r.wind != null ? (r.wind - 250) / 600 : 0, r.wind != null ? Math.round(r.wind) : '—');
  setGauge('mag', r.maxMag != null ? r.maxMag / 9 : 0, r.maxMag != null ? r.maxMag.toFixed(1) : '—');

  const e = s.earth;
  el.nSub.textContent = e.sub; el.nSun.textContent = e.sun; el.nMoon.textContent = e.moon;
  el.nQ24.textContent = e.q24; el.nEnergy.textContent = e.energy; el.nStar.textContent = e.star;

  const sph = s.spherical;
  el.az.textContent = `${pad((((sph.theta * 180) / Math.PI + 360) % 360).toFixed(1), 5)}°`;
  const elev = 90 - (sph.phi * 180) / Math.PI;
  el.elv.textContent = `${elev >= 0 ? '+' : '−'}${pad(Math.abs(elev).toFixed(1), 4)}°`;
  el.dist.textContent = s.range;
  el.cursor.textContent = s.cursor;
  el.fps.textContent = `${pad(Math.round(s.fps))} FPS`;
  const up = Math.floor((performance.now() - t0) / 1000);
  el.up.textContent = `${pad(Math.floor(up / 60))}:${pad(up % 60)}`;

  logTimer -= 0.08;
  if (logTimer <= 0 && s.online && CHATTER[s.mode]) {
    const lines = CHATTER[s.mode];
    log(lines[(Math.random() * lines.length) | 0], s.mode === 'breach' ? 'warn' : '');
    logTimer = s.mode === 'breach' ? 0.8 + Math.random() : 2 + Math.random() * 3;
  }
}

export { el };
