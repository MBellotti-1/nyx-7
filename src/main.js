import '@fontsource/oxanium/400.css';
import '@fontsource/oxanium/500.css';
import '@fontsource/oxanium/600.css';
import '@fontsource/oxanium/700.css';
import '@fontsource/share-tech-mono/400.css';

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { U, PALETTES, clamp, lerp, ease, smooth } from './shared.js';
import { createCore } from './core.js';
import { createParticles, FORMATIONS } from './particles.js';
import { createRain, createDeck, createPanels } from './environment.js';
import { createTerra, gmst, fmtLL, llToVec, RE } from './terra.js';
import { feeds, onFeed, startFeeds, kpNow, kpWord, quakeStats, ago } from './data.js';
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
controls.minPolarAngle = Math.PI * 0.18;
controls.maxPolarAngle = Math.PI * 0.72;
controls.autoRotate = true;
controls.autoRotateSpeed = 0.45;

const PARTICLES = innerWidth * innerHeight < 700000 ? 50000 : 80000;
const core = createCore();
const swarm = createParticles(PARTICLES);
const rain = createRain();
const deck = createDeck();
const panels = createPanels();
const terra = createTerra();
swarm.uniforms.uSun.value = terra.sun;
scene.add(rain.mesh, deck, terra.group, swarm.points, panels.group, core.root);

const post = createPost(renderer, scene, camera, pixelRatio);
hud.addCallouts(core.labels, 'core');
hud.addCallouts(terra.labels, 'terra');
hud.setView('core');

/* ---------- state ---------- */

const S = {
  online: false, onlineAt: 0, introPulse: false, autoTerra: false, touched: false,
  mode: 'holo',
  view: 'core', terra: 0, terraSeen: false, camGoal: null,
  simOffset: 0, warp: 1, // seconds ahead of the real clock; time multiplier
  explode: 1, explodeTarget: 1,
  timeScale: 1, dilate: false, dilation: 0,
  zoom: 0,
  glitch: 0, waveR: 2, waveAmp: 0,
  energy: 0,
  hovered: null,
  fps: 60,
};
const target = {
  a: new THREE.Color(PALETTES.holo.a), b: new THREE.Color(PALETTES.holo.b), rain: new THREE.Color(PALETTES.holo.rain),
  rainI: PALETTES.holo.rainI, damp: PALETTES.holo.damp,
};

const pickables = [...core.pickables, ...panels.pickables];
const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2(0, 0);
const pointerPx = { x: innerWidth / 2, y: innerHeight / 2, down: false, moved: 0, lastMove: -10, inside: false };
const sph = new THREE.Spherical();
const origin = new THREE.Vector3();
const simNow = () => Date.now() + S.simOffset * 1000;

/* ---------- actions ---------- */

function pulse(strength = 1) {
  U.burstR.value = 0;
  U.burstAmp.value = strength;
  S.waveR = 0;
  S.waveAmp = strength;
  S.energy = Math.min(1.5, S.energy + strength);
  core.flash(strength);
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
  const planet = S.view === 'terra'; // the swarm is busy being continents
  if (mode === 'construct') {
    hud.banner('CONSTRUCT', 'the world behind the world');
    hud.log('reality layer → CONSTRUCT', 'hi');
    if (!planet) setFormation('lattice');
  } else if (mode === 'breach') {
    hud.banner('CONTAINMENT BREACH', planet ? 'planetary link unstable' : 'manual separation advised');
    hud.log('!! CONTAINMENT BREACH !!', 'hi');
    if (!planet) S.explodeTarget = Math.max(S.explodeTarget, 0.55);
    pulse(1);
  } else {
    hud.banner('HOLO', 'projection layer restored');
    hud.log('reality layer → HOLO', 'hi');
    if (!planet) setFormation('nebula');
  }
}

function setFormation(name) {
  if (!swarm.setFormation(name)) return;
  swarm.follow = null;
  document.querySelectorAll('#formations button').forEach((b) => b.classList.toggle('active', b.dataset.f === name));
  hud.log(`swarm re-forming → ${name.toUpperCase()}`, 'hi');
  S.energy = Math.min(1.5, S.energy + 0.4);
  audio.select();
}

function select(part) {
  core.select(part);
  if (part) {
    hud.log(`target isolated: ${part.info.tag || part.info.id} ${part.info.name}`, 'hi');
    if (!part.isPanel && !part.static) S.explodeTarget = Math.max(S.explodeTarget, 0.6);
    audio.select();
  }
}

// CORE: the reactor. TERRA: the reactor folds away and the swarm becomes the planet.
function setView(view, auto = false) {
  if (view === S.view) return;
  if (!auto) S.touched = true;
  S.view = view;
  S.zoom = 0;
  S.glitch = 1;
  select(null);
  hud.setView(view);
  document.querySelectorAll('#views button').forEach((b) => b.classList.toggle('active', b.dataset.v === view));
  audio.shift();
  if (view === 'terra') {
    S.explodeTarget = 0;
    if (!S.terraSeen) { S.terraSeen = true; S.simOffset = -3 * 3600; } // arrive from three hours ago, catch up to now
    const yaw = gmst(simNow()) - swarm.points.rotation.y;
    swarm.setFormationData('terra', terra.landPoints(swarm.count, yaw));
    swarm.follow = () => terra.spin.rotation.y - yaw;
    controls.minPolarAngle = Math.PI * 0.06;
    controls.maxPolarAngle = Math.PI * 0.94;
    // swing round to the visitor's own side of the planet (longitude from their clock, no permission needed)
    const lon = clamp(-new Date().getTimezoneOffset() / 4, -180, 180);
    const d = llToVec(24, lon, 1).applyAxisAngle(THREE.Object3D.DEFAULT_UP, gmst(Date.now()));
    S.camGoal = { theta: Math.atan2(d.x, d.z), phi: Math.acos(clamp(d.y, -1, 1)), t: 0 };
    const st = quakeStats();
    hud.banner('PLANETARY LINK', `${terra.census.total ? `${terra.census.total.toLocaleString('en-US')} objects in orbit` : 'acquiring orbital catalog'}${st ? ` · ${st.n} earthquakes this week` : ''}`);
    hud.log('planetary link established', 'hi');
    hud.log('synchronising orbital catalog to present…');
  } else {
    setFormation('nebula');
    controls.minPolarAngle = Math.PI * 0.18;
    controls.maxPolarAngle = Math.PI * 0.72;
    hud.banner('COGNITIVE CORE', 'planetary link on standby');
    hud.log('returning to core', 'hi');
  }
  pulse(0.8);
}

function setWarp(rate) {
  S.warp = rate;
  S.touched = true;
  document.querySelectorAll('#warp button').forEach((b) => b.classList.toggle('active', +b.dataset.w === rate));
  hud.log(rate === 1 ? 'time lock → LIVE' : `time warp ×${rate}`, 'hi');
  audio.select();
}

/* ---------- live data ---------- */

const num = (n) => n.toLocaleString('en-US');
const staleNote = (f) => (f.status === 'snapshot' ? ` · SNAPSHOT ${ago(f.at).replace(' AGO', '')} OLD` : f.status === 'cached' ? ' · CACHED' : '');

onFeed((name, f, extra) => {
  if (!f.data) { hud.setFeed(name, 'offline', 'NO SIGNAL'); return; }
  if (name === 'quakes') {
    terra.setQuakes(f.data);
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
});
startFeeds();

const hooks = {
  // fired as the seven-day replay sweeps past each real earthquake
  onQuake(q) {
    audio.quake(q.mag);
    if (q.mag >= 4.5) hud.log(`M${q.mag.toFixed(1)} · ${q.place}`, q.mag >= 6 ? 'hi' : 'warn');
    if (q.mag >= 6) pulse(0.5 + (q.mag - 6) * 0.3);
    else S.energy = Math.min(1.5, S.energy + q.mag * 0.02);
  },
};

/* ---------- input ---------- */

addEventListener('pointermove', (e) => {
  pointerPx.x = e.clientX; pointerPx.y = e.clientY;
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
  S.touched = true;
  if (S.hovered) select(core.selected === S.hovered ? null : S.hovered);
  else if (core.selected) select(null);
  else pulse(1);
});

let resumeTimer = 0;
controls.addEventListener('start', () => { controls.autoRotate = false; S.camGoal = null; clearTimeout(resumeTimer); });
controls.addEventListener('end', () => { resumeTimer = setTimeout(() => { controls.autoRotate = true; }, 5000); });

canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (S.view === 'terra') S.zoom = clamp(S.zoom + e.deltaY * 0.03, -8.5, 46);
  else if (e.ctrlKey || e.metaKey) S.zoom = clamp(S.zoom + e.deltaY * 0.04, -12, 22);
  else { S.explodeTarget = clamp(S.explodeTarget + e.deltaY * 0.0011); S.touched = true; }
}, { passive: false });

addEventListener('keydown', (e) => {
  if (e.target instanceof HTMLInputElement && e.code !== 'Space') return;
  if (e.code === 'Space') {
    e.preventDefault();
    if (!e.repeat) { S.dilate = true; hud.log(S.view === 'terra' ? 'temporal fast-forward engaged' : 'temporal dilation engaged', 'hi'); }
    return;
  }
  if (e.repeat || e.metaKey || e.ctrlKey) return;
  const k = e.key.toLowerCase();
  if (k >= '1' && k <= '5' && S.view === 'core') setFormation(FORMATIONS[+k - 1]);
  else if (k === 't') setView(S.view === 'terra' ? 'core' : 'terra');
  else if (k === 'm') { const order = ['holo', 'construct', 'breach']; setMode(order[(order.indexOf(S.mode) + 1) % 3]); }
  else if (k === 'e' && S.view === 'core') S.explodeTarget = S.explodeTarget > 0.5 ? 0 : 1;
  else if (k === 'l' && S.view === 'terra') setWarp(1);
  else if (k === 'h') document.body.classList.toggle('hud-off');
  else if (k === 'p') pulse(1);
  else if (k === 'escape') select(null);
});
addEventListener('keyup', (e) => {
  if (e.code === 'Space' && S.dilate) { S.dilate = false; pulse(0.6 + S.dilation * 0.9); }
});
addEventListener('blur', () => { S.dilate = false; });

hud.el.explode.addEventListener('input', () => { S.explodeTarget = hud.el.explode.value / 100; S.touched = true; });
document.querySelectorAll('#views button').forEach((b) => b.addEventListener('click', () => setView(b.dataset.v)));
document.querySelectorAll('#formations button').forEach((b) => b.addEventListener('click', () => setFormation(b.dataset.f)));
document.querySelectorAll('#modes button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.m)));
document.querySelectorAll('#warp button').forEach((b) => b.addEventListener('click', () => setWarp(+b.dataset.w)));
document.querySelectorAll('#layers button').forEach((b) => b.addEventListener('click', () => {
  const layer = terra.layers[b.dataset.l];
  layer.visible = !layer.visible;
  b.classList.toggle('active', layer.visible);
  b.setAttribute('aria-pressed', layer.visible);
  hud.log(`data layer ${b.textContent} ${layer.visible ? 'on' : 'off'}`);
  audio.select();
}));
document.getElementById('pulse').addEventListener('click', () => pulse(1));
const audioBtn = document.getElementById('audio');
audioBtn.addEventListener('click', () => {
  const on = audio.toggle();
  audioBtn.textContent = on ? 'AUDIO ON' : 'AUDIO OFF';
  audioBtn.classList.toggle('active', on);
});
document.querySelectorAll('.dock button').forEach((b) => b.addEventListener('pointerenter', () => audio.blip()));

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
let fpsAcc = 0, fpsN = 0, lowFor = 0;
let lastHover = null;
let lastLock = null;
let feedTick = 0;

function frame() {
  requestAnimationFrame(frame);
  tick();
}

function tick(forceDt) {
  const realDt = clock.getDelta();
  const rawDt = forceDt || Math.min(realDt, 0.05);
  const now = performance.now() / 1000;
  const planet = S.view === 'terra';

  // intro: assemble the core, then open the link to the planet
  if (S.online) {
    if (!S.introPulse && now - S.onlineAt > 2.3) {
      S.introPulse = true;
      pulse(0.9);
      hud.banner('NYX-7 ONLINE', 'cognitive core at your command');
    }
    if (!S.autoTerra && now - S.onlineAt > 6.8) {
      S.autoTerra = true;
      if (!S.touched) setView('terra', true);
    }
  }

  // SPACE: in the core it slows the world down; over the planet it runs the clock forward
  S.dilation += ((S.dilate ? 1 : 0) - S.dilation) * Math.min(1, rawDt * (S.dilate ? 2.5 : 5));
  S.timeScale = lerp(1, planet ? 0.6 : 0.08, S.dilation);
  const dt = rawDt * S.timeScale;
  U.time.value += dt;
  const t = U.time.value;

  // simulated planetary time
  const rate = planet ? S.warp + S.dilation * S.dilation * 5400 : 1;
  S.simOffset += rawDt * (rate - 1);
  if (S.warp === 1 && !S.dilate) S.simOffset *= Math.exp(-rawDt * 1.3); // drift back to the present
  const simMs = simNow();

  // palette drift toward the active layer
  const cf = 1 - Math.exp(-rawDt * 3.5);
  U.colorA.value.lerp(target.a, cf);
  U.colorB.value.lerp(target.b, cf);
  U.colorRain.value.lerp(target.rain, cf);
  const rainT = S.online ? target.rainI * (planet ? 0.7 : 1) : 0;
  rain.uniforms.uIntensity.value += (rainT - rain.uniforms.uIntensity.value) * cf * 0.6;

  // view blend + exploded view
  S.terra = clamp(S.terra + ((planet ? 1 : -1) * rawDt) / 2.4);
  const coreK = 1 - ease(clamp(S.terra * 2.2));
  const terraK = ease(clamp((S.terra - 0.28) / 0.72));
  S.explode += (S.explodeTarget - S.explode) * (1 - Math.exp(-rawDt * 3.2));
  hud.setExplodeUI(S.explodeTarget);

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
  controls.autoRotateSpeed = planet ? 0.28 : 0.45;
  if (S.camGoal) {
    const g = S.camGoal;
    g.t += rawDt;
    sph.setFromVector3(camera.position);
    const dTheta = Math.atan2(Math.sin(g.theta - sph.theta), Math.cos(g.theta - sph.theta));
    const k = Math.min(1, rawDt * 2.2);
    sph.theta += dTheta * k;
    sph.phi += (g.phi - sph.phi) * k;
    camera.position.setFromSpherical(sph);
    if (g.t > 4 || Math.abs(dTheta) < 0.01) S.camGoal = null;
  }
  controls.update();
  // frame the planet plus its low-orbit shell in whichever screen axis is tighter
  const halfFov = Math.min(25 * Math.PI / 180, Math.atan(Math.tan(25 * Math.PI / 180) * camera.aspect));
  const dist = lerp(25 + S.explode * 11 + S.dilation * -2.5, 9.4 / Math.sin(halfFov), S.terra) + S.zoom;
  sph.setFromVector3(camera.position);
  sph.radius += (dist - sph.radius) * Math.min(1, rawDt * 3);
  camera.position.setFromSpherical(sph);
  camera.lookAt(origin);
  const fov = 50 + S.dilation * (planet ? 10 : 22);
  if (Math.abs(camera.fov - fov) > 0.01) { camera.fov = fov; camera.updateProjectionMatrix(); }
  camera.updateMatrixWorld();

  // planet (before the swarm: the swarm follows its spin)
  terra.update(rawDt, simMs, terraK, camera, hooks);

  // picking + pointer ray
  raycaster.setFromCamera(pointer, camera);
  let hit = null;
  if (S.online && pointerPx.inside && !(pointerPx.down && pointerPx.moved > 6)) {
    if (S.terra > 0.7) hit = terra.pick(raycaster, pointer, camera, innerWidth, innerHeight);
    if (!hit) {
      const hits = raycaster.intersectObjects(S.terra > 0.5 ? panels.pickables : pickables, false);
      if (hits.length) hit = hits[0].object.userData.part;
    }
  } else terra.cursor.on = false;
  if (hit !== lastHover) {
    if (lastHover) lastHover.hoverTarget = 0;
    if (hit) { hit.hoverTarget = 1; audio.blip(); }
    lastHover = hit;
    S.hovered = hit;
  }
  const focus = core.selected || hit;
  if (focus !== lastLock) { terra.setLock(focus); lastLock = focus; }
  hud.reticleState(hit ? hit.info.tag || hit.info.id : '', pointerPx.down);
  hud.inspect(focus, !!core.selected);

  swarm.setRay(raycaster.ray);
  const su = swarm.uniforms;
  const landed = swarm.formation === 'terra';
  const active = now - pointerPx.lastMove < 1.2 ? 1 : 0.3;
  const f4 = Math.min(1, rawDt * 4);
  su.uMouseForce.value += ((pointerPx.inside ? active * (landed ? 0.55 : 1) : 0) - su.uMouseForce.value) * f4;
  su.uChaos.value += ((breach ? (landed ? 0.06 : 0.4) : 0) + (planet ? 0 : S.dilation * 0.3) - su.uChaos.value) * Math.min(1, rawDt * 2);
  su.uDrift.value += ((landed ? 0.012 : 0.16) - su.uDrift.value) * Math.min(1, rawDt * 1.5);
  su.uSunMix.value += ((landed ? 1 : 0) - su.uSunMix.value) * Math.min(1, rawDt * 1.5);
  su.uOpacity.value += ((landed ? 0.24 : 0.34) - su.uOpacity.value) * f4;
  su.uSize.value += ((landed ? 0.05 : 0.085) - su.uSize.value) * f4;

  // world
  core.root.visible = coreK > 0.004;
  core.root.scale.setScalar(Math.max(0.001, coreK));
  core.update(dt, rawDt, t, S.explode, breach ? 1 : S.dilation * 0.5);
  swarm.update(dt);
  panels.update(dt, rawDt, t, S.explode, core.selected, ease(S.terra));
  rain.mesh.rotation.y += dt * 0.004;

  // lens
  const L = post.lens;
  L.uTime.value = now % 1000;
  L.uGlitch.value = S.glitch;
  L.uWarp.value = S.dilation * (planet ? 0.45 : 1);
  L.uAberr.value = 0.0016 + (breach ? 0.0025 : 0) + S.energy * 0.002;
  L.uWaveR.value = S.waveR;
  L.uWaveAmp.value = S.waveAmp;
  origin.set(0, 0, 0).project(camera);
  L.uCenter.value.set(origin.x * 0.5 + 0.5, origin.y * 0.5 + 0.5);
  origin.set(0, 0, 0);
  const shake = (breach ? 0.0016 : 0) + S.waveAmp * 0.004;
  L.uShake.value.set((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
  const dampT = lerp(planet ? Math.min(target.damp, 0.62) : target.damp, planet ? 0.9 : 0.94, S.dilation);
  post.after.damp += (dampT - post.after.damp) * Math.min(1, rawDt * 4);
  post.bloom.strength = lerp(0.42, 0.3, S.terra) + S.energy * 0.3 + S.dilation * 0.3 + (breach ? 0.15 : 0);
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

  // ISS readout rides on the orbital catalog
  feedTick += rawDt;
  const iss = terra.stations[0];
  if (feedTick > 0.5) {
    feedTick = 0;
    if (iss.el) hud.setFeed('iss', feeds.sats.status, `${iss.alt.toFixed(0)} KM · ${fmtLL(iss.ll.lat, iss.ll.lon)}`);
  }

  const st = quakeStats();
  sph.setFromVector3(camera.position);
  hud.update(rawDt, {
    camera, explode: S.explode, time: t, energy: S.energy + S.dilation * 0.6 + (breach ? 0.5 : 0),
    mode: S.mode, view: S.view, timeScale: S.timeScale, spherical: sph, formation: swarm.formation, fps: S.fps,
    online: S.online, colorCss: PALETTES[S.mode].a,
    simMs, simOffset: S.simOffset, rate,
    status: breach ? PALETTES.breach.status
      : planet ? `PLANETARY LINK · ${terra.census.total ? `${num(terra.census.total)} OBJECTS` : 'ACQUIRING'}`
        : PALETTES[S.mode].status,
    real: { kp: kpNow(), wind: feeds.wind.data && Number.isFinite(feeds.wind.data.speed) ? feeds.wind.data.speed : null, maxMag: st && st.max24 ? st.max24.mag : null },
    rangeKm: Math.max(0, (sph.radius / RE - 1) * 6378.137),
    cursor: terra.cursor.on ? fmtLL(terra.cursor.lat, terra.cursor.lon) : '—',
    calloutVis: { core: smooth(0.22, 0.5, S.explode) * coreK, terra: smooth(0.8, 1, terraK) },
  });
}

/* ---------- boot ---------- */

swarm.uniforms.uMorph.value = 0;
hud.boot(() => {
  S.online = true;
  S.onlineAt = performance.now() / 1000;
  S.explodeTarget = 0; // assemble from exploded
  hud.log('operator authenticated', 'hi');
  hud.log('core assembly sequence start');
});
frame();

// handy for poking at things from the console
window.nyx = { S, camera, pulse, setMode, setFormation, setView, setWarp, select, tick, core, swarm, post, panels, terra, feeds };
