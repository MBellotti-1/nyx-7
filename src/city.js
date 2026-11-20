import * as THREE from 'three';
import { U, clamp } from './shared.js';
import { CITY_SIZE } from './cities.js';

/* A square of real city, extruded from OpenStreetMap building footprints.
   x = east, z = south, y = up. Heights come from OSM where surveyed; the rest are
   estimated and drawn fainter so the two are never confused. */

export const CITY_SPAN = 24; // scene units across the modelled square
export const CITY_Y = -4; // ground level in the scene
const M = CITY_SPAN / CITY_SIZE; // scene units per metre
const WAVE_SPEED = 8; // scene units per second
const WAVE_LEAD = 17;

// shared by faces, edges: rise-from-the-ground animation and the seismic response
const BUILDING_CHUNK = /* glsl */ `
attribute vec4 aB;   // centroid x, centroid z, height, id
attribute vec2 aF;   // fragility 0..1, height-is-estimated flag
uniform float uRise, uTime, uQT, uAmp, uCollapse, uCrack; uniform vec2 uQDir;
varying float vCollapse; varying float vCrack; varying float vHf; varying float vId; varying float vEst;
vec3 cityPos(vec3 pos){
  float rise = clamp(uRise * 2.4 - length(aB.xy) / 13. - aF.x * .25, 0., 1.);
  rise = rise * rise * (3. - 2. * rise);
  vec3 p = pos;
  float hf = aB.z > 0. ? pos.y / aB.z : 0.;
  p.y *= rise;
  float tq = uQT - (dot(aB.xy, uQDir) + ${WAVE_LEAD.toFixed(1)}) / ${WAVE_SPEED.toFixed(1)};   // time since the wavefront arrived here
  float on = step(0., tq) * step(0., uQT);
  float env = on * exp(-tq * .42) * (1. - exp(-tq * 7.));
  vec2 perp = vec2(-uQDir.y, uQDir.x);
  vec2 sway = perp * sin(tq * 9. + aF.x * 6.28) + uQDir * sin(tq * 13. + aF.x * 3.) * .6;
  p.xz += sway * env * uAmp * hf * hf * (.05 + aB.z * .045);
  p.y += sin(tq * 11. + aB.w) * env * uAmp * .035;
  float col = on * step(aF.x, uCollapse) * smoothstep(.25, 2.4, tq);
  p.y = mix(p.y, p.y * (.04 + aF.x * .3), col);                      // pancake to rubble
  p.xz = mix(p.xz, aB.xy + (p.xz - aB.xy) * (1.16 + hf * .22), col); // and spread
  vCollapse = col;
  vCrack = on * step(aF.x, uCrack) * smoothstep(0., 1.2, tq);
  vHf = hf; vId = aB.w; vEst = aF.y;
  return p;
}`;

const FACE_VERT = /* glsl */ `
${BUILDING_CHUNK}
attribute vec2 aV;   // metres along the wall, metres above ground
varying vec3 vN; varying vec2 vV; varying vec3 vW;
void main(){
  vec4 wp = modelMatrix * vec4(cityPos(position), 1.);
  vW = wp.xyz; vN = normal; vV = aV;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const FACE_FRAG = /* glsl */ `
uniform vec3 uColorA; uniform vec3 uColorB; uniform vec3 uSunDir;
uniform float uDay; uniform float uTime; uniform float uHoverId;
varying vec3 vN; varying vec2 vV; varying vec3 vW;
varying float vCollapse; varying float vCrack; varying float vHf; varying float vId; varying float vEst;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  vec3 N = normalize(vN);
  float roof = step(.7, N.y);
  float lit = .3 + .7 * max(dot(N, uSunDir), 0.) * uDay;
  float night = 1. - uDay;
  vec3 col = uColorA * (.018 + .06 * lit);
  // walls: one cell per window bay, lit at random — far more of them after dark
  vec2 w = vec2(vV.x / 3.4, vV.y / 3.5);
  vec2 wf = fract(w), wi = floor(w);
  float aa = clamp(1. - max(fwidth(w.x), fwidth(w.y)) * 1.6, 0., 1.);
  float pane = step(.14, wf.x) * step(wf.x, .86) * step(.2, wf.y) * step(wf.y, .8);
  float lamp = pane * step(1. - (.1 + .5 * night), hash(wi + vId * 3.7));
  vec3 wall = uColorA * (1. - pane) * .09 * aa * (.5 + .5 * lit)
            + mix(uColorA, vec3(1., .8, .5), .75) * lamp * (.1 + .55 * night) * aa
            + uColorA * (1. - aa) * .03
            + uColorB * pow(vHf, 3.) * .12;
  col += mix(wall, uColorA * (.05 + .1 * lit), roof);
  col += uColorA * smoothstep(.97, 1., sin(vW.y * .9 - uTime * 1.4) * .5 + .5) * .22;   // survey sweep
  col *= mix(1., .55, vEst);                                                             // unsurveyed heights drawn fainter
  float hov = 1. - step(.5, abs(vId - uHoverId));
  col += uColorA * hov * .35 + vec3(.08) * hov;
  vec3 hot = vec3(1., .22, .06);
  col = mix(col, hot * (.35 + .25 * sin(uTime * 8. + vId)), vCollapse * .9);
  col += hot * vCrack * (1. - vCollapse) * .07 * (.6 + .4 * sin(vV.y * 2. + vId));
  gl_FragColor = vec4(col, 1.);
}`;

const EDGE_VERT = /* glsl */ `
${BUILDING_CHUNK}
void main(){ gl_Position = projectionMatrix * modelViewMatrix * vec4(cityPos(position), 1.); }`;
const EDGE_FRAG = /* glsl */ `
uniform vec3 uColorA; uniform float uHoverId;
varying float vCollapse; varying float vCrack; varying float vHf; varying float vId; varying float vEst;
void main(){
  float hov = 1. - step(.5, abs(vId - uHoverId));
  vec3 col = uColorA * (.34 + vHf * .3) * mix(1., .45, vEst) + vec3(.8) * hov;
  col = mix(col, vec3(1., .3, .08), max(vCollapse, vCrack * .22));
  gl_FragColor = vec4(col, 1.);
}`;

const GROUND_FRAG = /* glsl */ `
uniform vec3 uColorA; uniform vec3 uColorB; uniform float uQT; uniform float uAmp; uniform vec2 uQDir; uniform float uRise;
varying vec2 vP;
void main(){
  vec2 p = vP;
  float half_ = ${(CITY_SPAN / 2).toFixed(1)};
  float d = length(p);
  vec2 g = abs(fract(p - .5) - .5) / (fwidth(p) + 1e-5);
  float fine = 1. - min(min(g.x, g.y), 1.);
  vec2 g5 = abs(fract(p / 6. - .5) - .5) / (fwidth(p / 6.) + 1e-5);
  float major = 1. - min(min(g5.x, g5.y), 1.);
  float box = max(abs(p.x), abs(p.y));
  float inside = 1. - smoothstep(half_, half_ + .05, box);
  float edge = 1. - smoothstep(0., .08, abs(box - half_));
  float fade = exp(-d * .045);
  vec3 col = vec3(.002, .005, .012) * inside;
  col += uColorA * (fine * mix(.05, .1, inside) + major * .14) * fade;
  col += uColorB * edge * .7;
  // the seismic wavefront crossing the ground
  float front = dot(p, uQDir) - (uQT * ${WAVE_SPEED.toFixed(1)} - ${WAVE_LEAD.toFixed(1)});
  float wave = step(0., uQT) * (exp(-front * front * 2.5) + exp(-pow(front + 2.2, 2.) * 3.) * .5) * clamp(uAmp, 0., 1.5);
  col += vec3(1., .35, .1) * wave * fade * 1.4;
  gl_FragColor = vec4(col * uRise, 1.);
}`;

const DUST_VERT = /* glsl */ `
attribute vec4 aB; attribute vec4 aSeed;
uniform float uQT, uCollapse, uScale; uniform vec2 uQDir;
varying float vA;
void main(){
  float tq = uQT - (dot(aB.xy, uQDir) + ${WAVE_LEAD.toFixed(1)}) / ${WAVE_SPEED.toFixed(1)} - .3 - aSeed.w * .8;
  float live = step(0., tq) * step(0., uQT) * step(aSeed.z, uCollapse);
  float life = clamp(tq / (4. + aSeed.x * 4.), 0., 1.);
  vec3 p = vec3(aB.x + (aSeed.x - .5) * (.25 + life * 1.8), aSeed.y * aB.z * (1. - life * .5) + life * 1.6, aB.y + (aSeed.w - .5) * (.25 + life * 1.8));
  vec4 mv = modelViewMatrix * vec4(p, 1.);
  gl_Position = projectionMatrix * mv;
  vA = live * (1. - life) * smoothstep(0., .08, life);
  gl_PointSize = clamp((.18 + life * .5) * uScale / -mv.z, 1., 40.) * live;
}`;
const DUST_FRAG = /* glsl */ `
varying float vA;
void main(){
  float d = length(gl_PointCoord - .5);
  float a = smoothstep(.5, 0., d);
  gl_FragColor = vec4(vec3(1., .5, .22) * a * a * vA * .32, 1.);
}`;

// deterministic per-building randomness, so a city looks the same on every visit
const rnd = (i, salt) => { const s = Math.sin(i * 127.1 + salt * 311.7) * 43758.5453; return s - Math.floor(s); };

export function createCity(uScale) {
  const group = new THREE.Group();
  group.position.y = CITY_Y;
  group.visible = false;

  const u = {
    uColorA: U.colorA, uColorB: U.colorB, uTime: U.time,
    uRise: { value: 0 }, uQT: { value: -1 }, uAmp: { value: 0 }, uCollapse: { value: 0 }, uCrack: { value: 0 },
    uQDir: { value: new THREE.Vector2(1, 0) }, uSunDir: { value: new THREE.Vector3(0.4, 0.8, 0.3) },
    uDay: { value: 1 }, uHoverId: { value: -9 }, uScale,
  };

  const faces = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.ShaderMaterial({ uniforms: u, vertexShader: FACE_VERT, fragmentShader: FACE_FRAG, side: THREE.DoubleSide }));
  const edges = new THREE.LineSegments(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
    uniforms: u, vertexShader: EDGE_VERT, fragmentShader: EDGE_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(160, 160), new THREE.ShaderMaterial({
    uniforms: u,
    vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
    fragmentShader: GROUND_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  ground.rotation.x = -Math.PI / 2; // plane y → scene −z, i.e. north
  ground.scale.y = -1; // …flip so plane y maps to scene +z, matching uQDir (x, z)
  ground.position.y = -0.01;
  const dust = new THREE.Points(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
    uniforms: u, vertexShader: DUST_VERT, fragmentShader: DUST_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  for (const o of [faces, edges, dust]) o.frustumCulled = false;
  group.add(ground, faces, edges, dust);

  // callouts: the tallest named buildings, plus a north marker
  const labels = [0, 1, 2, 3].map(() => ({ anchor: new THREE.Object3D(), title: '', sub: '', front: 0, group: 'city', dirty: true }));
  const north = { anchor: new THREE.Object3D(), title: 'N', sub: '', front: 0, group: 'city', mini: true, dirty: true };
  north.anchor.position.set(0, 0, -CITY_SPAN / 2 - 0.4);
  for (const L of [...labels, north]) group.add(L.anchor);

  const state = {
    meta: null, count: 0, measured: 0, tallest: 0, tallestName: '', fetched: '',
    sim: { active: false, mag: 0, collapsed: 0, damaged: 0, t: -1 },
  };
  let boxes = null; // per building: minX, maxX, minZ, maxZ, height (scene units)
  let info = []; // per building: { h (m), est, name, area }
  let frag = null;
  let partCache = new Map();

  function build(meta, data) {
    const P = [], N = [], B = [], F = [], V = [], I = [];
    const eP = [], eB = [], eF = [];
    const n = data.b.length;
    boxes = new Float32Array(n * 5);
    frag = new Float32Array(n);
    info = [];
    partCache = new Map();
    const contour = [];
    let measured = 0;

    data.b.forEach((row, id) => {
      const [h0, name, flat, baseM = 0] = row;
      const y0 = baseM * M; // parts that start above ground (bridges, spires, upper tiers)
      const m = flat.length / 2;
      // signed area → counter-clockwise ring, so wall normals point outward
      let area = 0;
      for (let i = 0; i < m; i++) { const j = (i + 1) % m; area += flat[i * 2] * flat[j * 2 + 1] - flat[j * 2] * flat[i * 2 + 1]; }
      const ccw = area > 0;
      area = Math.abs(area) / 2;
      const est = !h0;
      if (!est) measured++;
      const hM = est ? 8 + rnd(id, 1) * 13 + (area > 1500 ? rnd(id, 2) * 9 : 0) : h0;
      const h = hM * M;
      const ring = [];
      let cx = 0, cz = 0, minX = 1e9, maxX = -1e9, minZ = 1e9, maxZ = -1e9;
      for (let i = 0; i < m; i++) {
        const k = ccw ? i : m - 1 - i;
        const x = flat[k * 2] * M, z = -flat[k * 2 + 1] * M;
        ring.push([x, z, flat[k * 2], flat[k * 2 + 1]]);
        cx += x; cz += z;
        minX = Math.min(minX, x); maxX = Math.max(maxX, x); minZ = Math.min(minZ, z); maxZ = Math.max(maxZ, z);
      }
      cx /= m; cz /= m;
      boxes.set([minX, maxX, minZ, maxZ, h], id * 5);
      const f = rnd(id, 3);
      frag[id] = f;
      info.push({ h: hM, est, name: name || '', area, cx, cz });
      const push = (x, y, z, nx, ny, nz, vu, vv) => {
        P.push(x, y, z); N.push(nx, ny, nz); B.push(cx, cz, h, id); F.push(f, est ? 1 : 0); V.push(vu, vv);
        return P.length / 3 - 1;
      };
      // walls
      let run = 0;
      for (let i = 0; i < m; i++) {
        const a = ring[i], b = ring[(i + 1) % m];
        const dxm = b[2] - a[2], dym = b[3] - a[3];
        const len = Math.hypot(dxm, dym) || 1;
        const nx = dym / len, nz = dxm / len; // outward normal (east, −north) → scene (x, z)
        const i0 = push(a[0], y0, a[1], nx, 0, nz, run, baseM);
        const i1 = push(b[0], y0, b[1], nx, 0, nz, run + len, baseM);
        const i2 = push(b[0], h, b[1], nx, 0, nz, run + len, hM);
        const i3 = push(a[0], h, a[1], nx, 0, nz, run, hM);
        I.push(i0, i1, i2, i0, i2, i3);
        run += len;
        eP.push(a[0], h, a[1], b[0], h, b[1]);
        eB.push(cx, cz, h, id, cx, cz, h, id);
        eF.push(f, est ? 1 : 0, f, est ? 1 : 0);
        if (hM > 55) { // corner lines on towers only — the skyline reads better for it
          eP.push(a[0], y0, a[1], a[0], h, a[1]);
          eB.push(cx, cz, h, id, cx, cz, h, id);
          eF.push(f, est ? 1 : 0, f, est ? 1 : 0);
        }
      }
      // roof
      contour.length = 0;
      for (let i = 0; i < m; i++) contour.push(new THREE.Vector2(ring[i][2], ring[i][3]));
      const base = P.length / 3;
      for (let i = 0; i < m; i++) push(ring[i][0], h, ring[i][1], 0, 1, 0, 0, hM);
      for (const t of THREE.ShapeUtils.triangulateShape(contour, [])) I.push(base + t[0], base + t[1], base + t[2]);
    });

    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(N, 3));
    g.setAttribute('aB', new THREE.Float32BufferAttribute(B, 4));
    g.setAttribute('aF', new THREE.Float32BufferAttribute(F, 2));
    g.setAttribute('aV', new THREE.Float32BufferAttribute(V, 2));
    g.setIndex(I);
    faces.geometry.dispose();
    faces.geometry = g;
    const eg = new THREE.BufferGeometry();
    eg.setAttribute('position', new THREE.Float32BufferAttribute(eP, 3));
    eg.setAttribute('aB', new THREE.Float32BufferAttribute(eB, 4));
    eg.setAttribute('aF', new THREE.Float32BufferAttribute(eF, 2));
    edges.geometry.dispose();
    edges.geometry = eg;

    // dust: a few motes parked on every building, shown only where one comes down
    const D = Math.min(9000, n * 3);
    const dB = new Float32Array(D * 4), dS = new Float32Array(D * 4);
    for (let i = 0; i < D; i++) {
      const id = i % n;
      dB.set([info[id].cx, info[id].cz, boxes[id * 5 + 4], id], i * 4);
      dS.set([Math.random(), Math.random(), frag[id], Math.random()], i * 4);
    }
    const dg = new THREE.BufferGeometry();
    dg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(D * 3), 3));
    dg.setAttribute('aB', new THREE.BufferAttribute(dB, 4));
    dg.setAttribute('aSeed', new THREE.BufferAttribute(dS, 4));
    dust.geometry.dispose();
    dust.geometry = dg;

    const named = info.map((b, id) => ({ ...b, id })).filter((b) => !b.est && b.name).sort((a, b) => b.h - a.h);
    const seen = new Set();
    const top = named.filter((b) => !seen.has(b.name) && seen.add(b.name)).slice(0, 4);
    labels.forEach((L, i) => {
      const b = top[i];
      L.active = !!b;
      if (!b) return;
      L.anchor.position.set(b.cx, b.h * M + 0.05, b.cz);
      L.title = b.name.toUpperCase().slice(0, 34);
      L.sub = `${b.h.toFixed(0)} M · ≈${Math.max(1, Math.round(b.h / 3.6))} FLOORS`;
      L.dirty = true;
    });
    const tallest = info.reduce((a, b) => (!b.est && b.h > a.h ? b : a), { h: 0, name: '' });
    Object.assign(state, { meta, count: n, measured, tallest: tallest.h, tallestName: tallest.name, fetched: data.fetched });
    reset();
    u.uRise.value = 0;
  }

  function trigger(mag) {
    // Illustrative only: a smooth curve from "nothing falls" at M5 to "most of it" at M9.
    const I = clamp((mag - 4.8) / 3.7);
    const collapse = 0.55 * Math.pow(I, 2.6);
    const crack = Math.min(1, 1.1 * Math.pow(I, 1.3));
    const a = Math.random() * Math.PI * 2;
    u.uQDir.value.set(Math.cos(a), Math.sin(a));
    u.uQT.value = 0;
    u.uAmp.value = 0.25 + I * 2.2;
    u.uCollapse.value = collapse;
    u.uCrack.value = crack;
    let c = 0, d = 0;
    for (let i = 0; i < frag.length; i++) { if (frag[i] <= collapse) c++; else if (frag[i] <= crack) d++; }
    Object.assign(state.sim, { active: true, mag, collapsed: c, damaged: d, t: 0 });
    partCache = new Map();
  }
  function reset() {
    u.uQT.value = -1; u.uAmp.value = 0; u.uCollapse.value = 0; u.uCrack.value = 0;
    Object.assign(state.sim, { active: false, mag: 0, collapsed: 0, damaged: 0, t: -1 });
    partCache = new Map();
  }

  const inv = new THREE.Matrix4();
  const lray = new THREE.Ray();
  function pick(ray) {
    if (!boxes || u.uRise.value < 0.9) return null;
    inv.copy(group.matrixWorld).invert();
    lray.copy(ray).applyMatrix4(inv);
    const o = lray.origin, d = lray.direction;
    let best = -1, bestT = Infinity;
    for (let i = 0; i < state.count; i++) {
      const j = i * 5;
      // slab test against the building's bounding box
      let t0 = 0, t1 = bestT;
      const lo = [boxes[j], 0, boxes[j + 2]], hi = [boxes[j + 1], boxes[j + 4], boxes[j + 3]];
      const oo = [o.x, o.y, o.z], dd = [d.x, d.y, d.z];
      let ok = true;
      for (let a = 0; a < 3 && ok; a++) {
        if (Math.abs(dd[a]) < 1e-9) { ok = oo[a] >= lo[a] && oo[a] <= hi[a]; continue; }
        let ta = (lo[a] - oo[a]) / dd[a], tb = (hi[a] - oo[a]) / dd[a];
        if (ta > tb) [ta, tb] = [tb, ta];
        t0 = Math.max(t0, ta); t1 = Math.min(t1, tb);
        ok = t0 <= t1;
      }
      if (ok && t0 < bestT) { bestT = t0; best = i; }
    }
    if (best < 0) return null;
    if (!partCache.has(best)) {
      const b = info[best];
      const sim = state.sim;
      const status = !sim.active ? 'INTACT' : frag[best] <= u.uCollapse.value ? 'COLLAPSED' : frag[best] <= u.uCrack.value ? 'DAMAGED' : 'STANDING';
      partCache.set(best, {
        static: true, building: best,
        info: {
          id: `OSM · ${state.meta.name}`, tag: `${b.h.toFixed(0)} M`, name: (b.name || `STRUCTURE ${String(best + 1).padStart(4, '0')}`).toUpperCase(),
          desc: b.est ? 'No surveyed height in OpenStreetMap — drawn at an estimate, and fainter for it.' : 'Footprint and height from OpenStreetMap.',
          stats: [
            ['HEIGHT', clamp(b.h / 400), `${b.est ? '≈' : ''}${b.h.toFixed(0)} M`], ['FLOORS', clamp(b.h / 400), `≈${Math.max(1, Math.round(b.h / 3.6))}`],
            ['FOOTPRINT', clamp(b.area / 6000), `${Math.round(b.area).toLocaleString('en-US')} M²`], ['STATUS', status === 'COLLAPSED' ? 1 : status === 'DAMAGED' ? 0.5 : 0, status],
          ],
        },
      });
    }
    return partCache.get(best);
  }

  // where the swarm goes while we are down here: a survey grid running to the horizon, and an uplink overhead
  function groundPoints(count) {
    const arr = new Float32Array(count * 3);
    const top = CITY_Y + state.tallest * M + 2;
    for (let i = 0; i < count; i++) {
      const r = Math.random();
      let x, y = CITY_Y + 0.02, z;
      if (r < 0.6) {
        const ring = 13.5 + Math.floor(Math.pow(Math.random(), 1.6) * 30) * 2.3;
        const a = Math.random() * Math.PI * 2;
        x = Math.cos(a) * ring; z = Math.sin(a) * ring;
      } else if (r < 0.86) {
        const a = (Math.round(Math.random() * 72) / 72) * Math.PI * 2;
        const rr = 13.5 + Math.pow(Math.random(), 1.4) * 70;
        x = Math.cos(a) * rr; z = Math.sin(a) * rr;
      } else {
        const t = Math.random();
        const a = t * 40 + (i % 3) * 2.094;
        const rr = 0.25 + t * 2.4;
        x = Math.cos(a) * rr; z = Math.sin(a) * rr; y = top + t * 46;
      }
      arr[i * 3] = x; arr[i * 3 + 1] = y; arr[i * 3 + 2] = z;
    }
    return arr;
  }

  function update(rawDt, k, sun) {
    group.visible = k > 0.002 && !!boxes;
    if (!group.visible) return 0;
    group.scale.setScalar(Math.max(0.0001, k));
    u.uRise.value = Math.min(1, u.uRise.value + rawDt / 2.6);
    if (u.uQT.value >= 0) { u.uQT.value += rawDt; state.sim.t = u.uQT.value; }
    // light the model from where the sun really is over this city right now
    const alt = (sun.alt * Math.PI) / 180, az = (sun.az * Math.PI) / 180;
    u.uSunDir.value.set(Math.sin(az) * Math.cos(alt), Math.max(Math.sin(alt), 0.08), -Math.cos(az) * Math.cos(alt)).normalize();
    u.uDay.value = clamp((sun.alt + 6) / 14);
    const show = k > 0.9 && u.uRise.value > 0.6 ? 1 : 0;
    for (const L of labels) L.front += ((L.active ? show : 0) - L.front) * Math.min(1, rawDt * 6);
    north.front += (show - north.front) * Math.min(1, rawDt * 6);
    // how hard the ground at the centre is moving right now (drives camera shake and sound)
    const tq = u.uQT.value - WAVE_LEAD / WAVE_SPEED;
    return tq > 0 ? Math.exp(-tq * 0.42) * (1 - Math.exp(-tq * 7)) * u.uAmp.value : 0;
  }

  return {
    group, state, labels: [...labels, north], build, trigger, reset, pick, groundPoints, update,
    setHover: (part) => { u.uHoverId.value = part && part.building != null ? part.building : -9; },
    get ready() { return !!boxes; },
  };
}
