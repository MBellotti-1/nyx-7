import '@fontsource/oxanium/400.css';
import '@fontsource/oxanium/500.css';
import '@fontsource/oxanium/600.css';
import '@fontsource/oxanium/700.css';
import '@fontsource/share-tech-mono/400.css';

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { U, PALETTES, clamp, lerp, ease, smooth } from './shared.js';
import { createParticles } from './particles.js';
import { createRain, createDeck, createPanels } from './environment.js';
import { createTerra, gmst, fmtLL, llToVec, sunAltAz, earthNow, greatCircleKm, energyText, RE, RE_KM } from './terra.js';
import { createCity, CITY_SPAN } from './city.js';
import { CITIES, CITY_SIZE } from './cities.js';
import { feeds, onFeed, startFeeds, loadCity, kpNow, kpWord, quakeStats, ago } from './data.js';
import { createPost } from './post.js';
import { audio } from './audio.js';
import * as hud from './hud.js';

/* ---------- renderer / scene ---------- */

const canvas = document.getElementById('scene');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance' });
let pixelRatio = Math.min(window.devicePixelRatio || 1, 1.5);
renderer.setPixelRatio(pixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.setClearColor(0x01030a);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.95;

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 600);
camera.position.set(13, 11, 29);

const controls = new OrbitControls(camera, canvas);
controls.enableDamping = true;
controls.dampingFactor = 0.06;
controls.enablePan = false;
controls.enableZoom = false;
controls.rotateSpeed = 0.6;
controls.minPolarAngle = Math.PI * 0.06;
controls.maxPolarAngle = Math.PI * 0.94;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.28;

const PARTICLES = innerWidth * innerHeight < 700000 ? 50000 : 80000;
const swarm = createParticles(PARTICLES);
const rain = createRain();
const deck = createDeck();
const panels = createPanels();
const terra = createTerra();
const city = createCity(terra.uScale);
swarm.uniforms.uSun.value = terra.sun;
scene.add(rain.mesh, deck, terra.group, city.group, swarm.points, panels.group);

const post = createPost(renderer, scene, camera, pixelRatio);
hud.addCallouts(terra.labels);
hud.addCallouts(city.labels);
hud.setView('orbit');

/* ---------- state ---------- */

const S = {
  online: false, onlineAt: 0, introPulse: false, intro: 0,
  mode: 'holo',
  view: 'orbit', orbitK: 1, cityK: 0, cityId: null, descend: null, mag: 7,
  split: 0, splitTarget: 0,
  simOffset: 0, warp: 1, // seconds ahead of the real clock; time multiplier
  dilate: false, dilation: 0,
  zoom: 0, camGoal: null,
  glitch: 0, waveR: 2, waveAmp: 0, energy: 0,
  hovered: null, selected: null,
  fps: 60,
};
const target = {
  a: new THREE.Color(PALETTES.holo.a), b: new THREE.Color(PALETTES.holo.b), rain: new THREE.Color(PALETTES.holo.rain),
  rainI: PALETTES.holo.rainI, damp: PALETTES.holo.damp,
};

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2(0, 0);
const pointerPx = { down: false, moved: 0, lastMove: -10, inside: false };
const sph = new THREE.Spherical();
const origin = new THREE.Vector3();
const UP = new THREE.Vector3(0, 1, 0);
const simNow = () => Date.now() + S.simOffset * 1000;
const num = (n) => n.toLocaleString('en-US');
const cityById = (id) => terra.cities.find((c) => c.id === id);
let landYaw = 0;

/* ---------- actions ---------- */

function pulse(strength = 1) {
  U.burstR.value = 0;
  U.burstAmp.value = strength;
  S.waveR = 0;
  S.waveAmp = strength;
  S.energy = Math.min(1.5, S.energy + strength);
  audio.pulse();
}

function setMode(mode) {
  if (mode === S.mode) return;
  S.mode = mode;
  const p = PALETTES[mode];
  target.a.set(p.a); target.b.set(p.b); target.rain.set(p.rain);
  target.rainI = p.rainI; target.damp = p.damp;
  S.glitch = 1;
  hud.setMode(mode, p);
  document.querySelectorAll('#modes button').forEach((b) => b.classList.toggle('active', b.dataset.m === mode));
  audio.shift();
  if (mode === 'construct') hud.banner('CONSTRUCT', 'the world behind the world');
  else if (mode === 'breach') { hud.banner('SIGNAL BREACH', 'planetary link unstable'); pulse(1); }
  else hud.banner('HOLO', 'projection layer restored');
  hud.log(`reality layer → ${p.label}`, 'hi');
}

function select(part) {
  S.selected = part;
  if (part) { hud.log(`target locked: ${part.info.tag || part.info.id}`, 'hi'); audio.select(); }
}

// the swarm puts the continents back on, wherever the planet has turned to
function landSwarm() {
  landYaw = gmst(simNow()) - swarm.points.rotation.y;
  swarm.morphTo('terra', terra.landPoints(swarm.count, landYaw));
  swarm.follow = () => terra.spin.rotation.y - landYaw;
}

function lookAtSurface(dir, phi) {
  // aim for where that spot will be once the clock has settled back to live
  const d = dir.clone().applyAxisAngle(UP, gmst(S.warp === 1 ? Date.now() : simNow()));
  S.camGoal = { theta: Math.atan2(d.x, d.z), phi: phi != null ? phi : Math.acos(clamp(d.y, -1, 1)), t: 0 };
}

function setSplit(x) {
  x = clamp(x);
  if (S.view !== 'orbit' || S.descend) return;
  if (x > 0.05 && S.splitTarget <= 0.05) {
    // first crack: turn to face the opening, flash the core
    lookAtSurface(new THREE.Vector3().crossVectors(terra.uCutN.value, UP), 1.2);
    terra.flashCore();
    pulse(1);
    S.glitch = 0.8;
    hud.banner('FRACTURE', terra.section.through ? `section through ${terra.section.through}` : 'opening the planet');
    hud.log(`fracture plane set${terra.section.through ? ` through ${terra.section.through}` : ''}`, 'hi');
    hud.log(`${terra.section.count} hypocentres on the section, deepest ${terra.section.deepest.toFixed(0)} km`);
    select(null);
  } else if (x <= 0.05 && S.splitTarget > 0.05) {
    hud.log('planet resealed', 'hi');
  }
  S.splitTarget = x;
}

function enterCity(id) {
  const c = cityById(id);
  if (!c || (S.descend && S.descend.id === id) || (S.view === 'city' && S.cityId === id && !S.descend)) return;
  S.splitTarget = 0;
  select(null);
  const d = { id, t: 0, data: null, failed: false, fromOrbit: S.view === 'orbit' };
  S.descend = d;
  loadCity(id).then((data) => { d.data = data; }, () => { d.failed = true; });
  if (d.fromOrbit) { lookAtSurface(c.dir); S.zoom = -7.5; }
  hud.banner(c.name, `${c.district} · descending`);
  hud.log(`city uplink → ${c.name}`, 'hi');
  audio.shift();
}

function arriveCity(d) {
  const c = cityById(d.id);
  city.build(c, d.data);
  S.view = 'city';
  S.cityId = d.id;
  S.descend = null;
  S.zoom = 0;
  S.glitch = 1;
  hud.setView('city');
  hud.setCityUI(c.name, S.mag);
  const yaw = swarm.points.rotation.y;
  swarm.follow = () => yaw;
  swarm.morphTo('city', city.groundPoints(swarm.count));
  controls.minPolarAngle = Math.PI * 0.1;
  controls.maxPolarAngle = Math.PI * 0.47;
  S.camGoal = { theta: sph.setFromVector3(camera.position).theta + 0.6, phi: 1.08, t: 0 };
  const st = city.state;
  hud.banner(c.name, `${num(st.count)} structures · ${Math.round((st.measured / st.count) * 100)}% surveyed heights`);
  hud.log(`${c.name}: ${num(st.count)} structures from OpenStreetMap (${st.fetched})`, 'hi');
  if (st.tallestName) hud.log(`tallest: ${st.tallestName}, ${st.tallest.toFixed(0)} m`);
  cityPart = null;
  pulse(0.8);
}

function exitCity() {
  if (S.view !== 'city') { S.descend = null; return; }
  S.view = 'orbit';
  S.descend = null;
  const c = cityById(S.cityId);
  S.cityId = null;
  S.zoom = 0;
  S.glitch = 1;
  select(null);
  city.reset();
  hud.setView('orbit');
  landSwarm();
  controls.minPolarAngle = Math.PI * 0.06;
  controls.maxPolarAngle = Math.PI * 0.94;
  if (c) lookAtSurface(c.dir);
  hud.banner('ORBIT', 'planetary link');
  hud.log('returning to orbit', 'hi');
  pulse(0.7);
}

function stepCity(step) {
  const i = CITIES.findIndex((c) => c.id === (S.descend ? S.descend.id : S.cityId));
  enterCity(CITIES[(i + step + CITIES.length) % CITIES.length].id);
}

function triggerQuake() {
  if (S.view !== 'city' || S.descend || !city.ready) return;
  city.trigger(S.mag);
  const sim = city.state.sim;
  hud.banner(`M ${S.mag.toFixed(1)} · SIMULATED`, 'illustrative stress test — not a prediction');
  hud.log(`stress test M${S.mag.toFixed(1)} beneath ${city.state.meta.name}`, 'hi');
  hud.log(`simulated: ${num(sim.collapsed)} collapsed · ${num(sim.damaged)} damaged of ${num(city.state.count)}`, 'warn');
  S.energy = 1.5;
  audio.pulse();
  audio.quake(S.mag);
  cityPart = null;
}

function setWarp(rate) {
  S.warp = rate;
  document.querySelectorAll('#warp button').forEach((b) => b.classList.toggle('active', +b.dataset.w === rate));
  hud.log(rate === 1 ? 'time lock → LIVE' : `time warp ×${rate}`, 'hi');
  audio.select();
}

/* ---------- live data ---------- */

const staleNote = (f) => (f.status === 'snapshot' ? ` · SNAPSHOT ${ago(f.at).replace(' AGO', '')} OLD` : f.status === 'cached' ? ' · CACHED' : '');
const kmText = (km) => (km < 1000 ? `${Math.round(km)} KM` : `${(km / 1000).toFixed(1)}K KM`);

function nearestQuakes() {
  const list = feeds.quakes.data || [];
  for (const c of terra.cities) {
    let best = null, bestKm = Infinity;
    for (const q of list) {
      const km = greatCircleKm(c.lat, c.lon, q.lat, q.lon);
      if (km < bestKm) { bestKm = km; best = q; }
    }
    c.near = best ? { q: best, km: bestKm } : null;
  }
}

function buildTicker() {
  const items = [];
  const st = quakeStats();
  const list = feeds.quakes.data;
  if (st && list) {
    const top = [...list].sort((a, b) => b.mag - a.mag).slice(0, 5);
    top.forEach((q, i) => items.push([i ? `M${q.mag.toFixed(1)}` : `STRONGEST THIS WEEK · M${q.mag.toFixed(1)}`, `${q.place.toUpperCase()} · ${ago(q.time)}`]));
    items.push(['SEISMIC ENERGY · 7 DAYS', energyText(st.joules)], ['EARTHQUAKES · 24H', `${st.n24}`]);
  }
  const c = terra.census;
  if (c.total) items.push(['ACTIVE SATELLITES', num(c.total)], ['STARLINK', num(c.starlink)], ['GEOSTATIONARY', num(c.geo)]);
  const iss = terra.stations[0];
  if (iss.el) items.push(['ISS', `${iss.alt.toFixed(0)} KM OVER ${fmtLL(iss.ll.lat, iss.ll.lon)}`]);
  if (feeds.wind.data && Number.isFinite(feeds.wind.data.speed)) items.push(['SOLAR WIND', `${Math.round(feeds.wind.data.speed)} KM/S`]);
  const k = kpNow();
  if (k != null) items.push(['GEOMAGNETIC Kp', `${k.toFixed(1)} · ${kpWord(k)}`]);
  if (feeds.events.data) items.push(['WILDFIRES BURNING', `${feeds.events.data.filter((e) => e.cat === 'wildfires').length}`]);
  const e = earthNow(simNow());
  items.push(['MOON', `${e.moon} · ${(e.moonLit * 100).toFixed(0)}% LIT`], ['SUN OVERHEAD AT', fmtLL(e.subLat, e.subLon)]);
  if (terra.section.through) items.push(['FRACTURE PLANE THROUGH', terra.section.through]);
  if (items.length) hud.setTicker(items);
}

onFeed((name, f, extra) => {
  if (!f.data) { hud.setFeed(name, 'offline', 'NO SIGNAL'); return; }
  if (name === 'quakes') {
    terra.setQuakes(f.data);
    nearestQuakes();
    const st = quakeStats();
    hud.setFeed('quakes', f.status, st ? `${st.n} IN 7 DAYS · MAX M${st.max.mag.toFixed(1)}${staleNote(f)}` : 'NO EVENTS');
    // something just happened on the real planet
    const fresh = (extra && extra.fresh) || [];
    if (fresh.length && S.online) {
      const q = fresh.reduce((a, b) => (b.mag > a.mag ? b : a));
      hud.log(`NEW · M${q.mag.toFixed(1)} · ${q.place}`, 'hi');
      if (q.mag >= 4.5) { hud.banner('SEISMIC EVENT', `M${q.mag.toFixed(1)} · ${q.place}`); pulse(clamp(q.mag / 7, 0.4, 1.2)); }
    }
  } else if (name === 'sats') {
    terra.setSatellites(f.data, simNow());
    f.census = terra.census;
    hud.setFeed('sats', f.status, `${num(f.data.length)} TRACKED${staleNote(f)}`);
    hud.log(`orbital catalog: ${num(f.data.length)} objects`, 'hi');
  } else if (name === 'kp') {
    const k = kpNow();
    if (k != null) { terra.auroraU.uKp.value = k; hud.setFeed('kp', f.status, `Kp ${k.toFixed(1)} · ${kpWord(k)}${staleNote(f)}`); }
  } else if (name === 'wind') {
    hud.setFeed('wind', Number.isFinite(f.data.speed) ? f.status : 'offline', Number.isFinite(f.data.speed) ? `${Math.round(f.data.speed)} KM/S${staleNote(f)}` : 'NO SIGNAL');
  } else if (name === 'events') {
    terra.setEvents(f.data);
    const fires = f.data.filter((e) => e.cat === 'wildfires').length;
    hud.setFeed('events', f.status, `${f.data.length} ACTIVE · ${fires} WILDFIRES${staleNote(f)}`);
  }
  buildTicker();
});
startFeeds();
setInterval(buildTicker, 45e3);

const hooks = {
  // fired as the seven-day replay sweeps past each real earthquake
  onQuake(q) {
    if (S.view !== 'orbit') return;
    audio.quake(q.mag);
    if (q.mag >= 4.5) hud.log(`M${q.mag.toFixed(1)} · ${q.place}`, q.mag >= 6 ? 'hi' : 'warn');
    if (q.mag >= 6) pulse(0.5 + (q.mag - 6) * 0.3);
    else S.energy = Math.min(1.5, S.energy + q.mag * 0.02);
  },
};

/* ---------- city bookkeeping (once a second) ---------- */

const clocks = new Map(CITIES.map((c) => [c.id, new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', timeZone: c.tz })]));
let cityPart = null;

function refreshCities(simMs) {
  const when = new Date(simMs);
  const rows = [];
  for (const c of terra.cities) {
    c.time = clocks.get(c.id).format(when);
    c.sun = sunAltAz(c.lat, c.lon, simMs);
    const title = `${c.name} · ${c.time}`;
    if (c.label.title !== title) { c.label.title = title; c.label.dirty = true; }
    const near = c.near ? `M${c.near.q.mag.toFixed(1)} · ${kmText(c.near.km)}` : '—';
    rows.push({ id: c.id, time: c.time, night: c.sun.alt < -0.8, near, tip: `${c.district} — nearest quake this week: ${c.near ? `M${c.near.q.mag.toFixed(1)}, ${kmText(c.near.km).toLowerCase()} away` : 'none'}` });
    c.part.info.stats = cityStats(c, false);
  }
  hud.updateCities(rows, S.descend ? S.descend.id : S.cityId);
  if (S.view === 'city' && city.ready) {
    const c = cityById(S.cityId);
    const sim = city.state.sim;
    cityPart = {
      static: true,
      info: {
        id: `${c.country} · ${fmtLL(c.lat, c.lon)}`, tag: c.name, name: c.name,
        desc: sim.active
          ? `SIMULATED M${sim.mag.toFixed(1)} directly beneath ${c.district}. Illustrative only — not an engineering model or a forecast.`
          : `${c.district}. ${c.note}`,
        stats: cityStats(c, true),
      },
    };
  }
}

function cityStats(c, full) {
  const [hh, mm] = (c.time || '00:00').split(':').map(Number);
  const rows = [
    ['POPULATION', c.pop / 38, `≈${c.pop.toFixed(1)}M METRO`],
    ['LOCAL TIME', (hh + mm / 60) / 24, c.time || '—'],
    ['SUN', clamp((c.sun.alt + 90) / 180), c.sun.alt > -0.8 ? `ALT ${c.sun.alt.toFixed(0)}° · AZ ${c.sun.az.toFixed(0)}°` : `NIGHT · ${Math.abs(c.sun.alt).toFixed(0)}° BELOW`],
    ['NEAREST QUAKE', c.near ? clamp(1 - c.near.km / 3000) : 0, c.near ? `M${c.near.q.mag.toFixed(1)} · ${kmText(c.near.km)}` : '—'],
  ];
  if (!full) return rows;
  const st = city.state;
  rows.push(['STRUCTURES', 1, num(st.count)], ['SURVEYED', st.measured / st.count, `${Math.round((st.measured / st.count) * 100)}% OF HEIGHTS`]);
  if (st.sim.active) rows.push(['COLLAPSED', st.sim.collapsed / st.count, `${num(st.sim.collapsed)} · SIM`], ['DAMAGED', st.sim.damaged / st.count, `${num(st.sim.damaged)} · SIM`]);
  return rows;
}

hud.buildCityList(CITIES, (id) => enterCity(id));

/* ---------- input ---------- */

addEventListener('pointermove', (e) => {
  pointer.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  pointerPx.lastMove = performance.now() / 1000;
  pointerPx.inside = e.target === canvas;
  if (pointerPx.down) pointerPx.moved += Math.abs(e.movementX) + Math.abs(e.movementY);
  hud.reticleTo(e.clientX, e.clientY);
});
canvas.addEventListener('pointerdown', () => { pointerPx.down = true; pointerPx.moved = 0; });
addEventListener('pointerup', (e) => {
  if (!pointerPx.down) return;
  pointerPx.down = false;
  if (pointerPx.moved > 6 || e.target !== canvas || !S.online) return;
  if (S.hovered && S.hovered.city) enterCity(S.hovered.city.id);
  else if (S.hovered) select(S.selected === S.hovered ? null : S.hovered);
  else if (S.selected) select(null);
  else pulse(1);
});

let resumeTimer = 0;
controls.addEventListener('start', () => { controls.autoRotate = false; S.camGoal = null; clearTimeout(resumeTimer); });
controls.addEventListener('end', () => { resumeTimer = setTimeout(() => { controls.autoRotate = true; }, 5000); });

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  S.zoom = S.view === 'city' ? clamp(S.zoom + e.deltaY * 0.03, -20, 40) : clamp(S.zoom + e.deltaY * 0.03, -8.5, 46);
}, { passive: false });

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.code !== 'Space') return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) { S.dilate = true; hud.log('temporal fast-forward engaged', 'hi'); }
    return;
  }
  if (e.repeat || e.metaKey || e.ctrlKey) return;
  const k = e.key.toLowerCase();
  const inCity = S.view === 'city';
  if (k === 'x' && !inCity) setSplit(S.splitTarget > 0.5 ? 0 : 1);
  else if (k === 'q' && inCity) triggerQuake();
  else if (k === 'r' && inCity) { city.reset(); cityPart = null; hud.log('simulation reset'); }
  else if (k === 'arrowright' && inCity) stepCity(1);
  else if (k === 'arrowleft' && inCity) stepCity(-1);
  else if (k === 'm') { const order = ['holo', 'construct', 'breach']; setMode(order[(order.indexOf(S.mode) + 1) % 3]); }
  else if (k === 'l') setWarp(1);
  else if (k === 'h') document.body.classList.toggle('hud-off');
  else if (k === 'p') pulse(1);
  else if (k === 'escape') { if (S.selected) select(null); else if (inCity || S.descend) exitCity(); else setSplit(0); }
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space' && S.dilate) { S.dilate = false; pulse(0.6 + S.dilation * 0.9); }
});
addEventListener('blur', () => { S.dilate = false; });

hud.el.split.addEventListener('input', () => setSplit(hud.el.split.value / 100));
hud.el.mag.addEventListener('input', () => { S.mag = hud.el.mag.value / 10; hud.setCityUI(city.state.meta ? city.state.meta.name : '—', S.mag); });
document.querySelectorAll('#modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.m)));
document.querySelectorAll('#warp button').forEach((b) => b.addEventListener('click', () => setWarp(+b.dataset.w)));
document.querySelectorAll('#layers button').forEach((b) => b.addEventListener('click', () => {
  const on = !terra.layerState[b.dataset.l];
  terra.setLayer(b.dataset.l, on);
  b.classList.toggle('active', on);
  b.setAttribute('aria-pressed', on);
  hud.log(`data layer ${b.textContent} ${on ? 'on' : 'off'}`);
  audio.select();
}));
document.getElementById('exitCity').addEventListener('click', exitCity);
document.getElementById('prevCity').addEventListener('click', () => stepCity(-1));
document.getElementById('nextCity').addEventListener('click', () => stepCity(1));
document.getElementById('trigger').addEventListener('click', triggerQuake);
document.getElementById('resetCity').addEventListener('click', () => { city.reset(); cityPart = null; hud.log('simulation reset'); });
document.getElementById('pulse').addEventListener('click', () => pulse(1));
const audioBtn = document.getElementById('audio');
audioBtn.addEventListener('click', () => {
  const on = audio.toggle();
  audioBtn.textContent = on ? 'AUDIO ON' : 'AUDIO OFF';
  audioBtn.classList.toggle('active', on);
});
document.querySelectorAll('.dock button, #cityList button').forEach((b) => b.addEventListener('pointerenter', () => audio.blip()));

function resize() {
  const w = innerWidth, h = innerHeight;
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // keep the post chain under ~3.6 MP so huge displays stay smooth
  const pr = Math.max(0.75, Math.min(pixelRatio, Math.sqrt(3.6e6 / (w * h))));
  renderer.setPixelRatio(pr);
  renderer.setSize(w, h);
  post.composer.setPixelRatio(pr);
  post.composer.setSize(w, h);
  post.lens.uAspect.value = w / h;
  const scale = (h * pr) / (2 * Math.tan((Math.PI * 50) / 360));
  swarm.uniforms.uScale.value = scale;
  terra.uScale.value = scale;
}
addEventListener('resize', resize);
resize();

/* ---------- loop ---------- */

const clock = new THREE.Clock();
const rotY = new THREE.Matrix4();
const rotYInv = new THREE.Matrix4();
let fpsAcc = 0, fpsN = 0, lowFor = 0;
let lastHover = null;
let lastFocus = null;
let secTick = 1;
let earth = { sub: '—', sun: '—', moon: '—', q24: '—', energy: '—', star: '—' };

function frame() {
  requestAnimationFrame(frame);
  tick();
}

function tick(forceDt) {
  const realDt = clock.getDelta();
  const rawDt = forceDt || Math.min(realDt, 0.05);
  const now = performance.now() / 1000;
  const inCity = S.view === 'city';

  if (S.online && !S.introPulse && now - S.onlineAt > 2.6) {
    S.introPulse = true;
    pulse(0.9);
    const st = quakeStats();
    hud.banner('PLANETARY LINK', `${terra.census.total ? `${num(terra.census.total)} objects in orbit` : 'acquiring orbital catalog'}${st ? ` · ${st.n} earthquakes this week` : ''}`);
  }

  // SPACE runs the planet's clock forward — orbits streak, the terminator sweeps, cities fall into night
  S.dilation += ((S.dilate ? 1 : 0) - S.dilation) * Math.min(1, rawDt * (S.dilate ? 2.5 : 5));
  const dt = rawDt * lerp(1, 0.6, S.dilation);
  U.time.value += dt;
  const t = U.time.value;
  const rate = S.warp + S.dilation * S.dilation * 5400;
  S.simOffset += rawDt * (rate - 1);
  if (S.warp === 1 && !S.dilate) S.simOffset *= Math.exp(-rawDt * 1.3); // drift back to the present
  const simMs = simNow();

  // palette drift toward the active layer
  const cf = 1 - Math.exp(-rawDt * 3.5);
  U.colorA.value.lerp(target.a, cf);
  U.colorB.value.lerp(target.b, cf);
  U.colorRain.value.lerp(target.rain, cf);
  rain.uniforms.uIntensity.value += ((S.online ? target.rainI * 0.7 : 0) - rain.uniforms.uIntensity.value) * cf * 0.6;

  // descent: fly at the city while its model loads, then cut to the street grid
  if (S.descend) {
    const d = S.descend;
    d.t += rawDt;
    if (d.failed) { hud.log(`city model unavailable: ${d.id}`, 'warn'); S.descend = null; if (S.view === 'orbit') S.zoom = 0; }
    else if (d.data && (d.fromOrbit ? d.t > 1.5 : S.cityK < 0.03)) arriveCity(d);
  }
  const wantCity = S.view === 'city' && !S.descend;
  S.cityK = clamp(S.cityK + ((wantCity ? 1 : -1) * rawDt) / 1.5);
  // (hopping city to city fades the model, not the planet back in)
  S.orbitK = clamp(S.orbitK + ((S.view === 'orbit' ? 1 : -1) * rawDt) / 0.8);
  S.intro = clamp(S.intro + (S.online ? rawDt / 2.6 : 0));
  const terraK = ease(S.intro) * ease(S.orbitK);
  const cityScale = ease(clamp((S.cityK - 0.3) / 0.7));

  S.split += (S.splitTarget - S.split) * (1 - Math.exp(-rawDt * 2.2));
  if (Math.abs(S.split - S.splitTarget) < 0.0005) S.split = S.splitTarget;
  hud.setSplitUI(S.splitTarget);

  // shockwaves
  U.burstR.value += dt * 26;
  U.burstAmp.value *= Math.exp(-dt * 1.5);
  S.waveR += rawDt * 0.85;
  S.waveAmp *= Math.exp(-rawDt * 2.2);
  S.glitch *= Math.exp(-rawDt * 5);
  S.energy *= Math.exp(-rawDt * 1.2);

  const breach = S.mode === 'breach';
  if (breach && Math.random() < rawDt * 0.9) S.glitch = Math.max(S.glitch, 0.5);

  // camera
  if (S.camGoal) {
    const g = S.camGoal;
    g.t += rawDt;
    sph.setFromVector3(camera.position);
    const dTheta = Math.atan2(Math.sin(g.theta - sph.theta), Math.cos(g.theta - sph.theta));
    const k = Math.min(1, rawDt * 2.2);
    sph.theta += dTheta * k;
    sph.phi += (clamp(g.phi, controls.minPolarAngle, controls.maxPolarAngle) - sph.phi) * k;
    camera.position.setFromSpherical(sph);
    if (g.t > 4 || Math.abs(dTheta) < 0.01) S.camGoal = null;
  }
  controls.update();
  // frame the planet plus its low-orbit shell in whichever screen axis is tighter
  const halfFov = Math.min((25 * Math.PI) / 180, Math.atan(Math.tan((25 * Math.PI) / 180) * camera.aspect));
  const fit = 9.4 / Math.sin(halfFov);
  const dist = Math.max(8, lerp(fit * 1.7, fit + S.split * 0.42 * fit, ease(S.orbitK)) + S.zoom);
  sph.setFromVector3(camera.position);
  sph.radius += (dist - sph.radius) * Math.min(1, rawDt * 3);
  camera.position.setFromSpherical(sph);
  camera.lookAt(origin);
  const fov = 50 + S.dilation * 10;
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  camera.updateMatrixWorld();

  // planet (before the swarm: the swarm follows its spin and its split)
  terra.update(rawDt, simMs, terraK, camera, hooks, S.split);
  const c = inCity ? cityById(S.cityId) : null;
  const shake = city.update(rawDt, cityScale, c && c.sun ? c.sun : { alt: 40, az: 150 });

  // picking + pointer ray
  raycaster.setFromCamera(pointer, camera);
  let hit = null;
  const canPick = S.online && pointerPx.inside && !(pointerPx.down && pointerPx.moved > 6) && !S.descend;
  if (canPick && inCity) hit = city.pick(raycaster.ray);
  else if (canPick && terraK > 0.7) hit = terra.pick(raycaster, pointer, camera, innerWidth, innerHeight);
  else terra.cursor.on = false;
  if (canPick && !hit) {
    const hits = raycaster.intersectObjects(panels.pickables, false);
    if (hits.length) hit = hits[0].object.userData.part;
  }
  if (hit !== lastHover) {
    if (lastHover) lastHover.hoverTarget = 0;
    if (hit) { hit.hoverTarget = 1; audio.blip(); }
    lastHover = hit;
    S.hovered = hit;
  }
  const focus = S.selected || hit || (inCity ? cityPart : null);
  if (focus !== lastFocus) {
    terra.setLock(inCity ? null : focus);
    city.setHover(focus);
    lastFocus = focus;
  }
  hud.reticleState(hit ? hit.info.tag || hit.info.id : '', pointerPx.down);
  hud.inspect(focus, !!S.selected);

  // swarm
  swarm.setRay(raycaster.ray);
  const su = swarm.uniforms;
  const landed = swarm.formation === 'terra';
  const moving = now - pointerPx.lastMove < 1.2 ? 1 : 0.3;
  const f4 = Math.min(1, rawDt * 4);
  const force = !pointerPx.inside || S.split > 0.02 ? 0 : moving * (landed ? 0.55 : 0.4);
  su.uMouseForce.value += (force - su.uMouseForce.value) * f4;
  su.uChaos.value += ((breach ? 0.06 : 0) - su.uChaos.value) * Math.min(1, rawDt * 2);
  su.uDrift.value += ((landed ? 0.012 : 0.03) - su.uDrift.value) * Math.min(1, rawDt * 1.5);
  su.uSunMix.value += ((landed ? 1 : 0) - su.uSunMix.value) * Math.min(1, rawDt * 1.5);
  su.uOpacity.value += ((landed ? 0.24 : 0.3) - su.uOpacity.value) * f4;
  su.uSize.value += ((landed ? 0.05 : 0.07) - su.uSize.value) * f4;
  su.uSplitMix.value = landed ? 1 : 0;
  if (landed) {
    // hemisphere transforms, carried from the planet's frame into the swarm's
    rotY.makeRotationY(landYaw);
    rotYInv.makeRotationY(-landYaw);
    su.uHalfP.value.copy(rotY).multiply(terra.halves[0].g.matrix).multiply(rotYInv);
    su.uHalfN.value.copy(rotY).multiply(terra.halves[1].g.matrix).multiply(rotYInv);
    su.uCutN.value.copy(terra.uCutN.value).applyAxisAngle(UP, landYaw);
  }
  swarm.update(dt);
  // the floating displays ring the scene just beyond the camera, however far it pulls back
  panels.update(dt, rawDt, t, 0, S.selected, clamp(((sph.radius + 15) / 13.5 - 1) / 1.15, 1, 3.2));
  rain.mesh.rotation.y += dt * 0.004;

  // lens
  const L = post.lens;
  L.uTime.value = now % 1000;
  L.uGlitch.value = S.glitch;
  L.uWarp.value = S.dilation * 0.45;
  L.uAberr.value = 0.0016 + (breach ? 0.0025 : 0) + S.energy * 0.002 + shake * 0.002;
  L.uWaveR.value = S.waveR;
  L.uWaveAmp.value = S.waveAmp;
  origin.set(0, 0, 0).project(camera);
  L.uCenter.value.set(origin.x * 0.5 + 0.5, origin.y * 0.5 + 0.5);
  origin.set(0, 0, 0);
  const jolt = (breach ? 0.0016 : 0) + S.waveAmp * 0.004 + shake * 0.006;
  L.uShake.value.set((Math.random() - 0.5) * jolt, (Math.random() - 0.5) * jolt);
  post.after.damp += (lerp(Math.min(target.damp, 0.62), 0.9, S.dilation) - post.after.damp) * Math.min(1, rawDt * 4);
  post.bloom.strength = 0.3 + S.energy * 0.3 + S.dilation * 0.3 + (breach ? 0.15 : 0);
  audio.dilate(S.dilation);

  post.composer.render(rawDt);

  // fps + adaptive resolution
  // (a throttled background tab reports single-digit fps — never downgrade for that)
  fpsAcc += forceDt || realDt; fpsN++;
  if (fpsAcc >= 0.5) {
    S.fps = fpsN / fpsAcc;
    lowFor = S.fps < 38 && S.fps > 12 && !document.hidden ? lowFor + 1 : 0;
    if (lowFor >= 4 && pixelRatio > 1) { pixelRatio = Math.max(1, pixelRatio - 0.25); resize(); lowFor = 0; }
    fpsAcc = 0; fpsN = 0;
  }

  // once a second: clocks, sun angles, whole-planet numbers
  secTick += rawDt;
  if (secTick > (S.dilation > 0.1 || S.warp > 1 ? 0.2 : 1)) {
    secTick = 0;
    refreshCities(simMs);
    const iss = terra.stations[0];
    if (iss.el) hud.setFeed('iss', feeds.sats.status, `${iss.alt.toFixed(0)} KM · ${fmtLL(iss.ll.lat, iss.ll.lon)}`);
    const e = earthNow(simMs);
    const st = quakeStats();
    const cs = terra.census;
    earth = {
      sub: fmtLL(e.subLat, e.subLon), sun: `${e.sunAU.toFixed(4)} AU`,
      moon: `${e.moon.replace('WAXING', 'WAX').replace('WANING', 'WAN')} ${(e.moonLit * 100).toFixed(0)}%`,
      q24: st ? `${st.n24}` : '—', energy: st ? energyText(st.joules) : '—',
      star: cs.total ? `${Math.round((cs.starlink / cs.total) * 100)}% OF ${num(cs.total)}` : '—',
    };
  }

  const st = quakeStats();
  sph.setFromVector3(camera.position);
  const cur = terra.cursor;
  hud.update(rawDt, {
    camera, time: t, energy: S.energy + S.dilation * 0.6 + (breach ? 0.5 : 0) + shake,
    mode: S.mode, spherical: sph, fps: S.fps, online: S.online, colorCss: PALETTES[S.mode].a,
    simMs, simOffset: S.simOffset, rate, earth,
    status: breach ? PALETTES.breach.status
      : inCity && city.ready ? `CITY UPLINK · ${city.state.meta.name} · ${num(city.state.count)} STRUCTURES`
        : S.split > 0.3 ? `FRACTURE ${Math.round(S.split * 100)}% · ${terra.section.count} HYPOCENTRES ON SECTION`
          : `PLANETARY LINK · ${terra.census.total ? `${num(terra.census.total)} OBJECTS` : 'ACQUIRING'}`,
    real: { kp: kpNow(), wind: feeds.wind.data && Number.isFinite(feeds.wind.data.speed) ? feeds.wind.data.speed : null, maxMag: st && st.max24 ? st.max24.mag : null },
    range: inCity ? `${num(Math.round((sph.radius / CITY_SPAN) * CITY_SIZE))} m` : `${num(Math.round(Math.max(0, (sph.radius / RE - 1) * RE_KM)))} km`,
    cursor: inCity ? (hit && hit.building != null ? hit.info.tag : '—')
      : !cur.on ? '—' : cur.depth >= 0 ? `DEPTH ${num(Math.round(cur.depth))} KM` : fmtLL(cur.lat, cur.lon),
    calloutVis: { terra: smooth(0.8, 1, terraK), city: smooth(0.85, 1, cityScale) },
  });
}

/* ---------- boot ---------- */

hud.boot(() => {
  S.online = true;
  S.onlineAt = performance.now() / 1000;
  S.simOffset = -3 * 3600; // arrive from three hours ago and catch up to now
  landSwarm();
  // swing round to the visitor's own side of the planet (longitude from their clock, no permission needed)
  lookAtSurface(llToVec(24, clamp(-new Date().getTimezoneOffset() / 4, -180, 180), 1));
  hud.log('operator authenticated', 'hi');
  hud.log('planetary link established');
  hud.log('synchronising orbital catalog to present…');
});
frame();

// handy for poking at things from the console
window.nyx = { S, camera, pulse, setMode, setSplit, setWarp, enterCity, exitCity, triggerQuake, select, tick, swarm, post, panels, terra, city, feeds };
