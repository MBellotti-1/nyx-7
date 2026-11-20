import * as THREE from 'three';
import { feature, mesh as topoMesh } from 'topojson-client';
import land50 from 'world-atlas/land-50m.json';
import countries110 from 'world-atlas/countries-110m.json';
import { U, clamp } from './shared.js';
import { ago } from './data.js';

/* The scene frame is Earth-centred inertial (north = +Y). The globe itself spins
   inside it by sidereal time, so satellites, the sun and the ground all sit where
   they really are relative to each other at the simulated instant. */

export const RE = 6; // scene units per Earth radius
const RE_KM = 6378.137;
const KM = RE / RE_KM;
const MU = 398600.4418; // km^3/s^2
const D2R = Math.PI / 180;
const TAU = Math.PI * 2;

/* ---------- astronomy ---------- */
const daysJ2000 = (ms) => ms / 86400000 + 2440587.5 - 2451545.0;
export function gmst(ms) {
  const deg = 280.46061837 + 360.98564736629 * daysJ2000(ms);
  return (((deg % 360) + 360) % 360) * D2R;
}
export function sunDirection(ms, out) {
  const n = daysJ2000(ms);
  const L = (280.46 + 0.9856474 * n) * D2R;
  const g = (357.528 + 0.9856003 * n) * D2R;
  const lam = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * D2R;
  const eps = (23.439 - 0.0000004 * n) * D2R;
  // ECI (x, y, z) -> scene (x, z, -y)
  return out.set(Math.cos(lam), Math.sin(eps) * Math.sin(lam), -Math.cos(eps) * Math.sin(lam)).normalize();
}
export function llToVec(lat, lon, r, out = new THREE.Vector3()) {
  const phi = (lon + 180) * D2R;
  const cl = Math.cos(lat * D2R);
  return out.set(-r * cl * Math.cos(phi), r * Math.sin(lat * D2R), r * cl * Math.sin(phi));
}
function vecToLL(v) {
  const r = v.length();
  return { lat: Math.asin(clamp(v.y / r, -1, 1)) / D2R, lon: Math.atan2(-v.z, v.x) / D2R };
}
export const fmtLL = (lat, lon) => `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'} ${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`;

/* Kepler propagation from mean elements plus the J2 secular drift of the orbit
   plane and perigee (Earth's bulge turns the ISS's plane ~5° a day). Not full
   SGP4 — no drag, no periodic terms — but with element sets a day or two old it
   lands within a fraction of a degree. */
const J2 = 1.08263e-3;
function j2Rates(aKm, e, inc, n) {
  const p = aKm * (1 - e * e);
  const k = 1.5 * J2 * (RE_KM / p) * (RE_KM / p) * n;
  const si = Math.sin(inc);
  return { dO: -k * Math.cos(inc), dw: k * (2 - 2.5 * si * si) };
}
function kepler(o, t, out) {
  const M = o.M0 + o.n * t;
  let E = M;
  for (let k = 0; k < 6; k++) E = M + o.e * Math.sin(E);
  const xp = o.a * (Math.cos(E) - o.e);
  const yp = o.a * Math.sqrt(1 - o.e * o.e) * Math.sin(E);
  const w = o.w + (o.dw || 0) * t, O = o.O + (o.dO || 0) * t;
  const cw = Math.cos(w), sw = Math.sin(w), cO = Math.cos(O), sO = Math.sin(O), ci = Math.cos(o.i), si = Math.sin(o.i);
  const x = (cO * cw - sO * sw * ci) * xp + (-cO * sw - sO * cw * ci) * yp;
  const y = (sO * cw + cO * sw * ci) * xp + (-sO * sw + cO * cw * ci) * yp;
  const z = sw * si * xp + cw * si * yp;
  return out.set(x, z, -y);
}

/* ---------- shaders ---------- */
const GLOBE_VERT = /* glsl */ `
varying vec2 vUv; varying vec3 vNw; varying vec3 vPw;
void main(){
  vUv = uv;
  vNw = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.);
  vPw = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const GLOBE_FRAG = /* glsl */ `
uniform sampler2D uLand; uniform vec3 uSun; uniform vec3 uColorA; uniform vec3 uColorB; uniform float uTime;
varying vec2 vUv; varying vec3 vNw; varying vec3 vPw;
void main(){
  vec3 N = normalize(vNw);
  vec3 V = normalize(cameraPosition - vPw);
  float land = texture2D(uLand, vUv).r;
  float sd = dot(N, uSun);
  float day = smoothstep(-.1, .16, sd);
  float ndv = max(dot(N, V), 0.);
  vec2 g = vUv * vec2(24., 12.);
  vec2 gd = abs(fract(g - .5) - .5) / (fwidth(g) + 1e-5);
  float grat = 1. - min(min(gd.x, gd.y), 1.);
  float ry = vUv.y * 300.;
  float rows = smoothstep(.25, .6, abs(fract(ry) - .5) * 2.);
  rows = mix(.5, rows, clamp(1. - fwidth(ry) * 1.3, 0., 1.));
  float sweep = smoothstep(.992, 1., sin(vUv.y * 9. - uTime * .7) * .5 + .5);
  vec3 col = vec3(.002, .005, .012) + uColorA * .014 * day;
  col += mix(uColorB * .5, uColorA, day) * land * (.03 + rows * .075 + sweep * .25);
  col += mix(uColorB, uColorA, day) * grat * .05;
  col += uColorB * exp(-pow(sd * 10., 2.)) * .07;
  col += uColorA * pow(1. - ndv, 3.) * (.18 + .3 * day);
  gl_FragColor = vec4(col, 1.);
}`;

const ATMO_FRAG = /* glsl */ `
uniform vec3 uSun; uniform vec3 uColorA; uniform vec3 uColorB;
varying vec3 vNw; varying vec3 vPw;
void main(){
  vec3 N = normalize(vNw);
  vec3 V = normalize(cameraPosition - vPw);
  float f = pow(1. - max(dot(N, V), 0.), 2.6);
  float lit = .3 + .7 * smoothstep(-.35, .55, dot(N, uSun));
  gl_FragColor = vec4(mix(uColorB, uColorA, lit) * f * lit * .38, 1.);
}`;

const SAT_VERT = /* glsl */ `
attribute vec4 aOrb1; attribute vec4 aOrb2; attribute vec2 aOrb3;
uniform float uT; uniform float uScale; uniform float uSize;
varying float vKind;
void main(){
  float a = aOrb1.x, e = aOrb1.y, inc = aOrb1.z;
  float O = aOrb1.w + aOrb3.x * uT, w = aOrb2.x + aOrb3.y * uT;
  float M = aOrb2.y + aOrb2.z * uT;
  float E = M;
  for (int k = 0; k < 5; k++) E = M + e * sin(E);
  float xp = a * (cos(E) - e), yp = a * sqrt(1. - e * e) * sin(E);
  float cw = cos(w), sw = sin(w), cO = cos(O), sO = sin(O), ci = cos(inc), si = sin(inc);
  vec3 eci = vec3((cO * cw - sO * sw * ci) * xp + (-cO * sw - sO * cw * ci) * yp,
                  (sO * cw + cO * sw * ci) * xp + (-sO * sw + cO * cw * ci) * yp,
                  (sw * si) * xp + (cw * si) * yp);
  vec4 mv = modelViewMatrix * vec4(eci.x, eci.z, -eci.y, 1.);
  gl_Position = projectionMatrix * mv;
  vKind = aOrb2.w;
  float sz = vKind > 3.5 && vKind < 4.5 ? 3.2 : (vKind < .5 ? .8 : 1.35);
  gl_PointSize = clamp(uSize * sz * uScale / -mv.z, 1.6, 14.);
}`;

const SAT_FRAG = /* glsl */ `
uniform vec3 uColorA; uniform vec3 uColorB; uniform float uOpacity;
varying float vKind;
void main(){
  float d = length(gl_PointCoord - .5);
  float a = smoothstep(.5, .1, d);
  vec3 col = uColorA * .78;                                        // megaconstellations
  if (vKind > .5) col = mix(uColorA, vec3(1.), .8);                // other low orbit
  if (vKind > 1.5) col = vec3(1., .72, .28);                       // medium orbit (navigation)
  if (vKind > 2.5) col = mix(uColorB, vec3(1.), .35);              // geostationary belt
  if (vKind > 3.5) col = vec3(1.);                                 // crewed stations
  if (vKind > 4.5) col = vec3(1., .42, .72);                       // highly elliptical
  gl_FragColor = vec4(col * a * uOpacity, 1.);
}`;

const QUAKE_VERT = /* glsl */ `
attribute vec3 iDir; attribute vec3 iData;
uniform float uReplay; uniform float uR;
varying vec2 vUv; varying float vMag; varying float vPhase;
void main(){
  vec3 n = normalize(iDir);
  vec3 up = abs(n.y) > .98 ? vec3(1., 0., 0.) : vec3(0., 1., 0.);
  vec3 t = normalize(cross(up, n));
  vec3 b = cross(n, t);
  vMag = iData.x;
  vPhase = fract(uReplay - iData.y);
  float burst = 1. - smoothstep(0., .05, vPhase);
  float s = .12 * pow(1.72, vMag - 2.5) * (1. + burst * 2.6);
  vec3 p = n * uR * 1.004 + (t * position.x + b * position.y) * s;
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.);
}`;

const QUAKE_FRAG = /* glsl */ `
uniform vec3 uColorA; uniform float uOpacity;
varying vec2 vUv; varying float vMag; varying float vPhase;
vec3 ramp(float m){
  vec3 c = mix(uColorA, vec3(1., .72, .28), smoothstep(3.6, 5., m));
  c = mix(c, vec3(1., .22, .2), smoothstep(5.3, 6.6, m));
  return c + vec3(.7) * smoothstep(6.6, 7.6, m);
}
void main(){
  float r = length(vUv - .5) * 2.;
  if (r > 1.) discard;
  float core = smoothstep(.2, 0., r);
  float ring = smoothstep(.07, 0., abs(r - .5));
  float rp = clamp(vPhase / .05, 0., 1.);
  float live = step(vPhase, .05) * (1. - rp);
  float ripple = (smoothstep(.1, 0., abs(r - rp)) + smoothstep(.08, 0., abs(r - rp * .55)) * .6) * live * 2.2;
  float recent = exp(-vPhase * 4.);
  float a = core * (.3 + recent * .8) + ring * (.14 + .45 * recent) + ripple;
  gl_FragColor = vec4(ramp(vMag) * a * uOpacity, 1.);
}`;

const EVENT_VERT = /* glsl */ `
attribute vec3 color; uniform float uScale; uniform float uTime;
varying vec3 vCol; varying float vTw;
void main(){
  vec4 mv = modelViewMatrix * vec4(position, 1.);
  gl_Position = projectionMatrix * mv;
  vCol = color;
  vTw = .6 + .4 * sin(uTime * 3. + position.x * 37. + position.z * 91.);
  gl_PointSize = clamp(.11 * uScale / -mv.z, 2., 12.);
}`;
const EVENT_FRAG = /* glsl */ `
uniform float uOpacity; varying vec3 vCol; varying float vTw;
void main(){
  vec2 c = abs(gl_PointCoord - .5);
  float d = c.x + c.y;
  if (d > .5) discard;
  float a = smoothstep(.5, .34, d) * (.35 + smoothstep(.2, .0, d));
  gl_FragColor = vec4(vCol * a * vTw * uOpacity, 1.);
}`;

const AURORA_VERT = /* glsl */ `
uniform vec3 uPole; uniform float uKp; uniform float uR; uniform float uTime;
varying vec2 vUv; varying vec3 vNw;
void main(){
  float a = uv.x * 6.28318;
  vec3 p = normalize(uPole);
  vec3 e1 = normalize(cross(p, vec3(1., 0., 0.)));
  vec3 e2 = cross(p, e1);
  float colat = radians(mix(18., 37., clamp(uKp / 9., 0., 1.))) + sin(a * 3. + uTime * .25) * .035 + sin(a * 7. - uTime * .4) * .012;
  vec3 dir = cos(colat) * p + sin(colat) * (cos(a) * e1 + sin(a) * e2);
  vec3 pos = dir * uR * (1.012 + uv.y * .14);
  vec4 wp = modelMatrix * vec4(pos, 1.);
  vNw = normalize(wp.xyz);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const AURORA_FRAG = /* glsl */ `
uniform float uKp; uniform float uTime; uniform vec3 uSun; uniform float uOpacity;
varying vec2 vUv; varying vec3 vNw;
void main(){
  float a = vUv.x * 6.28318;
  float c = .5 + .5 * sin(a * 46. + sin(a * 9. + uTime * .8) * 3. + uTime * 1.6);
  c *= .55 + .45 * sin(a * 13. - uTime * .7);
  c = .25 + c * c;
  float fade = pow(1. - vUv.y, 1.5) * smoothstep(0., .06, vUv.y);
  vec3 col = mix(vec3(.15, 1., .5), vec3(.8, .25, 1.), smoothstep(.15, .95, vUv.y));
  float night = 1. - smoothstep(-.25, .3, dot(normalize(vNw), uSun));
  float I = (.22 + uKp / 5.5) * mix(.3, 1., night);
  gl_FragColor = vec4(col * c * fade * I * uOpacity, 1.);
}`;

/* ---------- construction ---------- */

function landCanvas(W, H) {
  const c = document.createElement('canvas');
  c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.fillStyle = '#fff';
  const geo = feature(land50, land50.objects.land);
  const polys = [];
  for (const f of geo.features || [geo]) {
    const gm = f.geometry || f;
    if (gm.type === 'Polygon') polys.push(gm.coordinates);
    else if (gm.type === 'MultiPolygon') polys.push(...gm.coordinates);
  }
  g.beginPath();
  for (const poly of polys) {
    for (const ring of poly) {
      for (let i = 0; i < ring.length; i++) {
        const x = ((ring[i][0] + 180) / 360) * W;
        const y = ((90 - ring[i][1]) / 180) * H;
        i ? g.lineTo(x, y) : g.moveTo(x, y);
      }
      g.closePath();
    }
  }
  g.fill('evenodd');
  return { canvas: c, ctx: g };
}

function lineGeometry(multiLine, r) {
  const pts = [];
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  for (const line of multiLine.coordinates) {
    for (let i = 0; i < line.length - 1; i++) {
      llToVec(line[i][1], line[i][0], r, a);
      llToVec(line[i + 1][1], line[i + 1][0], r, b);
      pts.push(a.x, a.y, a.z, b.x, b.y, b.z);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return geo;
}

function ringSprite() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  g.strokeStyle = '#fff';
  g.lineWidth = 5;
  g.beginPath(); g.arc(64, 64, 44, 0, TAU); g.stroke();
  g.lineWidth = 3;
  for (let i = 0; i < 4; i++) {
    const a = (i * Math.PI) / 2;
    g.beginPath(); g.moveTo(64 + Math.cos(a) * 50, 64 + Math.sin(a) * 50); g.lineTo(64 + Math.cos(a) * 62, 64 + Math.sin(a) * 62); g.stroke();
  }
  g.fillStyle = '#fff';
  g.beginPath(); g.arc(64, 64, 10, 0, TAU); g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

const STATIONS = [
  { id: 25544, title: 'ISS · ZARYA', name: 'INTERNATIONAL SPACE STATION', desc: 'Continuously crewed since November 2000. Laps the planet every 92 minutes.' },
  { id: 48274, title: 'TIANGONG · TIANHE', name: 'TIANGONG SPACE STATION', desc: 'China’s modular station. Core module Tianhe launched April 2021.' },
  { id: 20580, title: 'HUBBLE', name: 'HUBBLE SPACE TELESCOPE', desc: 'In orbit since 1990 and still returning science.' },
];
const EVENT_STYLE = {
  wildfires: ['WILDFIRE', [1, 0.48, 0.16]],
  volcanoes: ['VOLCANO', [1, 0.2, 0.3]],
  severeStorms: ['SEVERE STORM', [0.9, 0.97, 1]],
  seaLakeIce: ['SEA ICE', [0.45, 0.85, 1]],
};
const MAXQ = 1200;

export function createTerra() {
  const group = new THREE.Group();
  const spin = new THREE.Group();
  group.add(spin);
  group.visible = false;

  const sun = new THREE.Vector3(1, 0, 0);
  const uSun = { value: sun };
  const uScale = { value: 1000 };

  /* globe */
  const land = landCanvas(2048, 1024);
  const landTex = new THREE.CanvasTexture(land.canvas);
  landTex.anisotropy = 8;
  const globe = new THREE.Mesh(
    new THREE.SphereGeometry(RE, 128, 64),
    new THREE.ShaderMaterial({
      uniforms: { uLand: { value: landTex }, uSun, uColorA: U.colorA, uColorB: U.colorB, uTime: U.time },
      vertexShader: GLOBE_VERT, fragmentShader: GLOBE_FRAG,
    }),
  );
  spin.add(globe);

  const coastMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, blending: THREE.AdditiveBlending, depthWrite: false });
  const borderMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.22, blending: THREE.AdditiveBlending, depthWrite: false });
  spin.add(new THREE.LineSegments(lineGeometry(topoMesh(land50, land50.objects.land), RE * 1.002), coastMat));
  spin.add(new THREE.LineSegments(lineGeometry(topoMesh(countries110, countries110.objects.countries, (a, b) => a !== b), RE * 1.002), borderMat));

  const atmo = new THREE.Mesh(
    new THREE.SphereGeometry(RE * 1.12, 64, 32),
    new THREE.ShaderMaterial({
      uniforms: { uSun, uColorA: U.colorA, uColorB: U.colorB },
      vertexShader: GLOBE_VERT, fragmentShader: ATMO_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    }),
  );
  group.add(atmo);

  /* aurora ovals around the geomagnetic poles */
  const auroraU = { uKp: { value: 2 }, uR: { value: RE }, uTime: U.time, uSun, uOpacity: { value: 1 } };
  const auroras = new THREE.Group();
  for (const [lat, lon] of [[80.7, -72.7], [-80.7, 107.3]]) {
    const m = new THREE.Mesh(
      new THREE.PlaneGeometry(1, 1, 180, 5),
      new THREE.ShaderMaterial({
        uniforms: { ...auroraU, uPole: { value: llToVec(lat, lon, 1) } },
        vertexShader: AURORA_VERT, fragmentShader: AURORA_FRAG,
        transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      }),
    );
    m.frustumCulled = false;
    auroras.add(m);
  }
  spin.add(auroras);

  /* earthquakes: instanced surface ripples + magnitude spikes */
  const quakeGeo = new THREE.InstancedBufferGeometry();
  const plane = new THREE.PlaneGeometry(1, 1);
  quakeGeo.index = plane.index;
  quakeGeo.setAttribute('position', plane.attributes.position);
  quakeGeo.setAttribute('uv', plane.attributes.uv);
  quakeGeo.setAttribute('iDir', new THREE.InstancedBufferAttribute(new Float32Array(MAXQ * 3), 3));
  quakeGeo.setAttribute('iData', new THREE.InstancedBufferAttribute(new Float32Array(MAXQ * 3), 3));
  quakeGeo.instanceCount = 0;
  const quakeU = { uReplay: { value: 0 }, uR: { value: RE }, uColorA: U.colorA, uOpacity: { value: 1 } };
  const quakeMesh = new THREE.Mesh(quakeGeo, new THREE.ShaderMaterial({
    uniforms: quakeU, vertexShader: QUAKE_VERT, fragmentShader: QUAKE_FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  }));
  quakeMesh.frustumCulled = false;
  const spikeGeo = new THREE.BufferGeometry();
  const spikes = new THREE.LineSegments(spikeGeo, new THREE.LineBasicMaterial({
    vertexColors: true, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending, depthWrite: false,
  }));
  spikes.frustumCulled = false;
  const quakeLayer = new THREE.Group();
  quakeLayer.add(quakeMesh, spikes);
  spin.add(quakeLayer);

  /* natural events */
  const eventU = { uScale, uTime: U.time, uOpacity: { value: 1 } };
  const eventPts = new THREE.Points(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
    uniforms: eventU, vertexShader: EVENT_VERT, fragmentShader: EVENT_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  eventPts.frustumCulled = false;
  spin.add(eventPts);

  /* satellites */
  const satU = { uT: { value: 0 }, uScale, uSize: { value: 0.042 }, uColorA: U.colorA, uColorB: U.colorB, uOpacity: { value: 0.85 } };
  const satPts = new THREE.Points(new THREE.BufferGeometry(), new THREE.ShaderMaterial({
    uniforms: satU, vertexShader: SAT_VERT, fragmentShader: SAT_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  satPts.frustumCulled = false;
  group.add(satPts);

  /* crewed stations + Hubble: marker, orbit trace, label anchor */
  const spriteTex = ringSprite();
  const stations = STATIONS.map((s, i) => {
    const marker = new THREE.Sprite(new THREE.SpriteMaterial({ map: spriteTex, color: 0xffffff, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }));
    marker.scale.setScalar(i === 0 ? 0.62 : 0.42);
    marker.visible = false;
    const orbit = new THREE.LineLoop(new THREE.BufferGeometry(), new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity: i === 0 ? 0.55 : 0.22, blending: THREE.AdditiveBlending, depthWrite: false,
    }));
    orbit.frustumCulled = false;
    orbit.visible = false;
    const anchor = new THREE.Object3D();
    group.add(marker, orbit, anchor);
    const label = { anchor, title: s.title, sub: 'ACQUIRING…', front: 0, group: 'terra', dirty: true };
    const part = { static: true, info: { id: `NORAD ${s.id}`, tag: s.title.split(' ')[0], name: s.name, desc: s.desc, stats: [] } };
    return { ...s, marker, orbit, anchor, label, part, el: null, pos: new THREE.Vector3(), alt: 0, ll: { lat: 0, lon: 0 } };
  });

  /* quake callouts (three strongest of the week) */
  const quakeLabels = [0, 1, 2].map(() => {
    const anchor = new THREE.Object3D();
    spin.add(anchor);
    return { anchor, title: '', sub: '', front: 0, group: 'terra', dirty: true, active: false };
  });

  /* hover lock ring */
  const lock = new THREE.Mesh(
    new THREE.RingGeometry(0.2, 0.235, 40),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  lock.visible = false;
  spin.add(lock);

  /* ---------- data binding ---------- */
  let quakes = [];
  let events = [];
  let tRef = Date.now(); // ms; satellite mean anomalies are expressed at this instant
  let satElems = null;
  let replayIdx = 0;
  const census = { total: 0, mega: 0, leo: 0, meo: 0, geo: 0, heo: 0, starlink: 0 };

  function setQuakes(list) {
    quakes = list.slice(-MAXQ);
    const now = Date.now();
    const t0 = now - 7 * 86400e3;
    const dir = quakeGeo.attributes.iDir.array;
    const dat = quakeGeo.attributes.iData.array;
    const pos = [];
    const col = [];
    const v = new THREE.Vector3();
    const c = new THREE.Color();
    quakes.forEach((q, i) => {
      llToVec(q.lat, q.lon, 1, v);
      q.dir = v.clone();
      q.tn = clamp((q.time - t0) / (now - t0), 0, 0.9999);
      dir[i * 3] = v.x; dir[i * 3 + 1] = v.y; dir[i * 3 + 2] = v.z;
      dat[i * 3] = q.mag; dat[i * 3 + 1] = q.tn; dat[i * 3 + 2] = Math.random();
      const h = 0.05 * Math.pow(1.8, q.mag - 2.5);
      q.h = h;
      pos.push(v.x * RE, v.y * RE, v.z * RE, v.x * (RE + h), v.y * (RE + h), v.z * (RE + h));
      c.setRGB(1, 0.72, 0.28).lerp(new THREE.Color(1, 0.2, 0.2), clamp((q.mag - 5) / 1.6));
      if (q.mag < 4.2) c.copy(U.colorA.value).lerp(new THREE.Color(1, 0.72, 0.28), clamp((q.mag - 3) / 1.2));
      col.push(c.r * 0.25, c.g * 0.25, c.b * 0.25, c.r, c.g, c.b);
      q.part = q.part || {
        static: true, quake: q,
        info: {
          id: `USGS · ${q.id}`, tag: `M${q.mag.toFixed(1)}`, name: `M ${q.mag.toFixed(1)} EARTHQUAKE`,
          desc: `${q.place}. ${ago(q.time).toLowerCase()} · ${fmtLL(q.lat, q.lon)}${q.tsunami ? ' · tsunami advisory issued' : ''}`,
          stats: [['MAGNITUDE', q.mag / 9, q.mag.toFixed(1)], ['DEPTH', clamp(q.depth / 300), `${q.depth.toFixed(0)} KM`], ['AGE', clamp((now - q.time) / (7 * 86400e3)), ago(q.time).replace(' AGO', '')]],
        },
      };
    });
    quakeGeo.attributes.iDir.needsUpdate = true;
    quakeGeo.attributes.iData.needsUpdate = true;
    quakeGeo.instanceCount = quakes.length;
    spikeGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    spikeGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    replayIdx = quakes.findIndex((q) => q.tn > quakeU.uReplay.value);
    if (replayIdx < 0) replayIdx = quakes.length;

    const top = [...quakes].sort((a, b) => b.mag - a.mag).slice(0, 3);
    quakeLabels.forEach((L, i) => {
      const q = top[i];
      L.active = !!q;
      if (!q) return;
      L.anchor.position.copy(q.dir).multiplyScalar(RE + q.h);
      L.title = `M ${q.mag.toFixed(1)} · ${ago(q.time)}`;
      L.sub = q.place.toUpperCase().slice(0, 38);
      L.dirty = true;
      L.dir = q.dir;
    });
  }

  function setEvents(list) {
    events = list;
    const pos = [];
    const col = [];
    const v = new THREE.Vector3();
    for (const e of events) {
      llToVec(e.lat, e.lon, RE * 1.006, v);
      e.dir = v.clone().normalize();
      const style = EVENT_STYLE[e.cat] || [e.cat.toUpperCase(), [0.8, 0.65, 1]];
      pos.push(v.x, v.y, v.z);
      col.push(...style[1]);
      e.part = {
        static: true, dir: e.dir,
        info: {
          id: `NASA · ${e.id}`, tag: style[0], name: style[0], desc: `${e.title}. Open event tracked by NASA EONET.`,
          stats: [['LATITUDE', (e.lat + 90) / 180, `${Math.abs(e.lat).toFixed(2)}°${e.lat >= 0 ? 'N' : 'S'}`], ['LONGITUDE', (e.lon + 180) / 360, `${Math.abs(e.lon).toFixed(2)}°${e.lon >= 0 ? 'E' : 'W'}`]],
        },
      };
    }
    eventPts.geometry.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    eventPts.geometry.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  }

  function setSatellites(list, simMs) {
    tRef = simMs;
    const n = list.length;
    const o1 = new Float32Array(n * 4);
    const o2 = new Float32Array(n * 4);
    const o3 = new Float32Array(n * 2);
    satElems = new Float64Array(n * 6); // M, n, Ω, dΩ, ω, dω at tRef — doubles, for re-basing
    Object.keys(census).forEach((k) => { census[k] = 0; });
    census.total = n;
    list.forEach((s, i) => {
      const [name, id, epoch, revs, e, inc, raan, argp, M] = s;
      const nRad = (revs * TAU) / 86400;
      const aKm = Math.cbrt(MU / (nRad * nRad));
      const period = 1440 / revs;
      const altKm = aKm - RE_KM;
      let kind = 1;
      if (e > 0.25) { kind = 5; census.heo++; }
      else if (period > 1380 && period < 1500) { kind = 3; census.geo++; }
      else if (altKm > 2000) { kind = 2; census.meo++; }
      else if (/^(STARLINK|ONEWEB|KUIPER|QIANFAN|HULIANWANG)/.test(name)) { kind = 0; census.mega++; if (name.startsWith('STARLINK')) census.starlink++; }
      else census.leo++;
      // carry the element set from its epoch to the reference instant
      const age = (tRef - epoch) / 1000;
      const rates = j2Rates(aKm, e, inc * D2R, nRad);
      let M0 = (M * D2R + nRad * age) % TAU;
      if (M0 < 0) M0 += TAU;
      const O0 = (raan * D2R + rates.dO * age) % TAU;
      const w0 = (argp * D2R + rates.dw * age) % TAU;
      const st = stations.find((x) => x.id === id);
      if (st) {
        kind = 4;
        st.el = { a: aKm * KM, e, i: inc * D2R, O: O0, w: w0, dO: rates.dO, dw: rates.dw, M0, n: nRad, idx: i, inc };
        st.orbit.geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(240 * 3), 3));
        st.orbit.visible = st.marker.visible = true;
        st.period = TAU / nRad / 60;
      }
      o1[i * 4] = aKm * KM; o1[i * 4 + 1] = e; o1[i * 4 + 2] = inc * D2R; o1[i * 4 + 3] = O0;
      o2[i * 4] = w0; o2[i * 4 + 1] = M0; o2[i * 4 + 2] = nRad; o2[i * 4 + 3] = kind;
      o3[i * 2] = rates.dO; o3[i * 2 + 1] = rates.dw;
      satElems.set([M0, nRad, O0, rates.dO, w0, rates.dw], i * 6);
    });
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(n * 3), 3));
    g.setAttribute('aOrb1', new THREE.BufferAttribute(o1, 4));
    g.setAttribute('aOrb2', new THREE.BufferAttribute(o2, 4));
    g.setAttribute('aOrb3', new THREE.BufferAttribute(o3, 2));
    satPts.geometry.dispose();
    satPts.geometry = g;
  }

  // keep uT small so float32 phase stays precise through long time-warps
  function rebase(simMs) {
    const dt = (simMs - tRef) / 1000;
    const o1 = satPts.geometry.attributes.aOrb1;
    const o2 = satPts.geometry.attributes.aOrb2;
    const E = satElems;
    for (let i = 0; i < E.length / 6; i++) {
      const j = i * 6;
      let M = (E[j] + E[j + 1] * dt) % TAU;
      if (M < 0) M += TAU;
      E[j] = M;
      E[j + 2] = (E[j + 2] + E[j + 3] * dt) % TAU;
      E[j + 4] = (E[j + 4] + E[j + 5] * dt) % TAU;
      o2.array[i * 4 + 1] = M;
      o1.array[i * 4 + 3] = E[j + 2];
      o2.array[i * 4] = E[j + 4];
    }
    o1.needsUpdate = true;
    o2.needsUpdate = true;
    for (const st of stations) {
      if (!st.el) continue;
      const j = st.el.idx * 6;
      st.el.M0 = E[j]; st.el.O = E[j + 2]; st.el.w = E[j + 4];
    }
    tRef = simMs;
  }

  /* ---------- particles: the swarm becomes the continents ---------- */
  function landPoints(count, yaw) {
    const img = land.ctx.getImageData(0, 0, land.canvas.width, land.canvas.height);
    const W = img.width, H = img.height;
    const arr = new Float32Array(count * 3);
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    const v = new THREE.Vector3();
    const nLand = Math.floor(count * 0.95);
    let i = 0;
    while (i < count) {
      let lat, lon, r;
      if (i < nLand) {
        lat = Math.asin(Math.random() * 2 - 1) / D2R;
        lon = Math.random() * 360 - 180;
        const px = Math.min(W - 1, Math.floor(((lon + 180) / 360) * W));
        const py = Math.min(H - 1, Math.floor(((90 - lat) / 180) * H));
        if (img.data[(py * W + px) * 4] < 128) continue;
        r = RE * (1.006 + Math.random() * 0.004);
      } else {
        // a sparse graticule so the oceans read as a grid of nodes
        lat = Math.round((Math.random() * 180 - 90) / 10) * 10 + (Math.random() - 0.5) * 0.3;
        lon = Math.round((Math.random() * 360 - 180) / 10) * 10 + (Math.random() - 0.5) * 0.3;
        if (Math.random() < 0.5) lat += (Math.random() - 0.5) * 10; else lon += (Math.random() - 0.5) * 10;
        r = RE * 1.02;
      }
      llToVec(lat, lon, r, v);
      arr[i * 3] = v.x * cy + v.z * sy;
      arr[i * 3 + 1] = v.y;
      arr[i * 3 + 2] = -v.x * sy + v.z * cy;
      i++;
    }
    return arr;
  }

  /* ---------- picking ---------- */
  const sphere = new THREE.Sphere(new THREE.Vector3(), RE);
  const hit = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const cursor = { on: false, lat: 0, lon: 0 };
  function pick(raycaster, pointer, camera, w, h) {
    cursor.on = false;
    for (const st of stations) {
      if (!st.el || st.label.front < 0.5) continue;
      tmp.copy(st.pos).project(camera);
      const dx = ((tmp.x - pointer.x) * w) / 2;
      const dy = ((tmp.y - pointer.y) * h) / 2;
      if (dx * dx + dy * dy < 20 * 20) return st.part;
    }
    sphere.radius = RE * group.scale.x;
    if (!raycaster.ray.intersectSphere(sphere, hit)) return null;
    tmp.copy(hit).applyAxisAngle(THREE.Object3D.DEFAULT_UP, -spin.rotation.y).normalize();
    const ll = vecToLL(tmp);
    cursor.on = true; cursor.lat = ll.lat; cursor.lon = ll.lon;
    let best = null;
    let bestScore = 0;
    if (quakeLayer.visible) {
      for (const q of quakes) {
        const d = Math.acos(clamp(tmp.dot(q.dir), -1, 1));
        const reach = 0.02 + 0.01 * Math.pow(1.72, q.mag - 2.5);
        if (d < reach && q.mag > bestScore) { best = q.part; bestScore = q.mag; }
      }
    }
    if (!best && eventPts.visible) {
      let bd = 0.02;
      for (const e of events) {
        const d = Math.acos(clamp(tmp.dot(e.dir), -1, 1));
        if (d < bd) { bd = d; best = e.part; }
      }
    }
    return best;
  }

  function setLock(part) {
    const dir = part && (part.quake ? part.quake.dir : part.dir);
    lock.visible = !!dir;
    if (!dir) return;
    lock.position.copy(dir).multiplyScalar(RE * 1.008);
    lock.lookAt(tmp.copy(dir).multiplyScalar(RE * 3));
    const s = part.quake ? 1 + Math.pow(1.72, part.quake.mag - 2.5) * 0.55 : 1;
    lock.userData.s = s;
  }

  /* ---------- per frame ---------- */
  const camDir = new THREE.Vector3();
  const wp = new THREE.Vector3();
  let slow = 0;

  function occluded(p, cam, R) {
    // does the globe sit between the camera and p?
    camDir.copy(p).sub(cam);
    const len = camDir.length();
    camDir.divideScalar(len);
    const b = cam.dot(camDir);
    const c = cam.lengthSq() - R * R;
    const disc = b * b - c;
    if (disc < 0) return false;
    const t = -b - Math.sqrt(disc);
    return t > 0 && t < len - 0.05;
  }

  function update(rawDt, simMs, k, camera, hooks) {
    // sidereal spin and the sun are tracked even while hidden: the swarm keys off them
    spin.rotation.y = gmst(simMs);
    sunDirection(simMs, sun);
    group.visible = k > 0.002;
    if (!group.visible) return;
    const s = Math.max(0.0001, k);
    group.scale.setScalar(s);
    coastMat.color.copy(U.colorA.value);
    borderMat.color.copy(U.colorB.value);
    lock.material.color.copy(U.colorB.value).lerp(new THREE.Color(1, 1, 1), 0.5);
    if (lock.visible) lock.scale.setScalar((lock.userData.s || 1) * (1 + 0.12 * Math.sin(performance.now() * 0.008)));

    // seismic replay: the last seven days loop past in 75 seconds
    const prev = quakeU.uReplay.value;
    const next = (prev + rawDt / 75) % 1;
    quakeU.uReplay.value = next;
    if (next < prev) replayIdx = 0;
    while (replayIdx < quakes.length && quakes[replayIdx].tn <= next) {
      if (k > 0.9 && quakeLayer.visible) hooks.onQuake(quakes[replayIdx]);
      replayIdx++;
    }

    if (satElems) {
      if (Math.abs(simMs - tRef) > 1.5e8) rebase(simMs);
      satU.uT.value = (simMs - tRef) / 1000;
    }

    const R = RE * s;
    for (const st of stations) {
      if (!st.el) continue;
      kepler(st.el, (simMs - tRef) / 1000, st.pos);
      st.marker.position.copy(st.pos);
      st.anchor.position.copy(st.pos);
      st.marker.material.rotation += rawDt * 0.6;
      wp.copy(st.pos).multiplyScalar(s);
      const vis = satPts.visible && !occluded(wp, camera.position, R) ? 1 : 0;
      st.label.front += (vis - st.label.front) * Math.min(1, rawDt * 8);
      st.marker.visible = st.orbit.visible = satPts.visible;
    }
    for (const L of quakeLabels) {
      let vis = 0;
      if (L.active && quakeLayer.visible) {
        L.anchor.getWorldPosition(wp);
        vis = !occluded(wp, camera.position, R * 0.995) ? 1 : 0;
      }
      L.front += (vis - L.front) * Math.min(1, rawDt * 8);
    }

    slow += rawDt;
    if (slow > 0.25) {
      slow = 0;
      const tSec = (simMs - tRef) / 1000;
      for (const st of stations) {
        if (!st.el) continue;
        // redraw the orbit trace where the plane is now (it precesses under time-warp)
        const ring = st.orbit.geometry.attributes.position;
        const frozen = { ...st.el, O: st.el.O + st.el.dO * tSec, w: st.el.w + st.el.dw * tSec, dO: 0, dw: 0, M0: 0, n: 1 };
        for (let k = 0; k < 240; k++) { kepler(frozen, (k / 240) * TAU, tmp); ring.setXYZ(k, tmp.x, tmp.y, tmp.z); }
        ring.needsUpdate = true;
        tmp.copy(st.pos).applyAxisAngle(THREE.Object3D.DEFAULT_UP, -spin.rotation.y);
        st.ll = vecToLL(tmp);
        st.alt = st.pos.length() / KM - RE_KM;
        const v = Math.sqrt(MU / (st.pos.length() / KM));
        st.label.sub = `${st.alt.toFixed(0)} KM · ${fmtLL(st.ll.lat, st.ll.lon)}`;
        st.label.dirty = true;
        st.part.info.stats = [
          ['ALTITUDE', clamp(st.alt / 600), `${st.alt.toFixed(0)} KM`],
          ['VELOCITY', clamp(v / 8), `${(v * 3600).toFixed(0)} KM/H`],
          ['INCLINATION', st.el.inc / 90, `${st.el.inc.toFixed(1)}°`],
        ];
        st.part.info.live = `${fmtLL(st.ll.lat, st.ll.lon)} · PERIOD ${st.period.toFixed(1)} MIN`;
      }
    }
  }

  return {
    group, spin, sun, uSun, uScale, auroraU, stations, census, cursor,
    labels: [...stations.map((s) => s.label), ...quakeLabels],
    layers: { sats: satPts, quakes: quakeLayer, events: eventPts, aurora: auroras },
    setQuakes, setEvents, setSatellites, landPoints, pick, setLock, update,
    get quakes() { return quakes; },
  };
}
