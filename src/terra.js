import * as THREE from 'three';
import { feature, mesh as topoMesh } from 'topojson-client';
import land50 from 'world-atlas/land-50m.json';
import countries110 from 'world-atlas/countries-110m.json';
import { U, NOISE_GLSL, clamp } from './shared.js';
import { ago } from './data.js';
import { CITIES } from './cities.js';

/* The scene frame is Earth-centred inertial (north = +Y). The globe itself spins
   inside it by sidereal time, so satellites, the sun and the ground all sit where
   they really are relative to each other at the simulated instant.

   The globe is built as two hemispheres either side of a cut plane. Closed, they
   read as one sphere; opened, they swing apart to show the interior to scale. */

export const RE = 6; // scene units per Earth radius
export const RE_KM = 6378.137;
const KM = RE / RE_KM;
const MU = 398600.4418; // km^3/s^2
const D2R = Math.PI / 180;
const TAU = Math.PI * 2;
const UP = new THREE.Vector3(0, 1, 0);
const Z = new THREE.Vector3(0, 0, 1);

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

const sunTmp = new THREE.Vector3();
const upTmp = new THREE.Vector3();
/** Sun altitude / azimuth (degrees) seen from a point on the ground. */
export function sunAltAz(lat, lon, ms) {
  const s = sunDirection(ms, sunTmp).applyAxisAngle(UP, -gmst(ms)); // into the Earth-fixed frame
  const u = llToVec(lat, lon, 1, upTmp);
  const lo = lon * D2R, la = lat * D2R;
  const e = s.x * -Math.sin(lo) + s.z * -Math.cos(lo);
  const n = s.x * -Math.sin(la) * Math.cos(lo) + s.y * Math.cos(la) + s.z * Math.sin(la) * Math.sin(lo);
  return { alt: Math.asin(clamp(s.dot(u), -1, 1)) / D2R, az: ((Math.atan2(e, n) / D2R) + 360) % 360 };
}
/** Whole-planet numbers that need nothing but the clock. */
export function earthNow(ms) {
  const n = daysJ2000(ms);
  const g = (357.528 + 0.9856003 * n) * D2R;
  const s = sunDirection(ms, sunTmp);
  const subLat = Math.asin(s.y) / D2R;
  let subLon = (Math.atan2(-s.z, s.x) - gmst(ms)) / D2R;
  subLon = ((subLon + 540) % 360) - 180;
  const phase = (((ms / 86400000 + 2440587.5 - 2451550.1) / 29.530588853) % 1 + 1) % 1; // 0 new, .5 full
  const lit = (1 - Math.cos(phase * TAU)) / 2;
  const names = ['NEW MOON', 'WAXING CRESCENT', 'FIRST QUARTER', 'WAXING GIBBOUS', 'FULL MOON', 'WANING GIBBOUS', 'LAST QUARTER', 'WANING CRESCENT'];
  return {
    subLat, subLon,
    sunAU: 1.00014 - 0.01671 * Math.cos(g) - 0.00014 * Math.cos(2 * g),
    moon: names[Math.round(phase * 8) % 8], moonLit: lit,
  };
}
export function greatCircleKm(lat1, lon1, lat2, lon2) {
  const a = Math.sin(((lat2 - lat1) * D2R) / 2) ** 2 + Math.cos(lat1 * D2R) * Math.cos(lat2 * D2R) * Math.sin(((lon2 - lon1) * D2R) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

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
// every surface shader carries its hemisphere: fragments on the far side of the cut are dropped
const CLIP_PARS = 'uniform vec3 uCutN; uniform float uSide; varying vec3 vL;';
const CLIP = 'if (dot(vL, uCutN) * uSide < 0.) discard;';

const GLOBE_VERT = /* glsl */ `
varying vec2 vUv; varying vec3 vNw; varying vec3 vPw; varying vec3 vL;
void main(){
  vUv = uv; vL = position;
  vNw = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.);
  vPw = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const GLOBE_FRAG = /* glsl */ `
uniform sampler2D uLand; uniform vec3 uSun; uniform vec3 uColorA; uniform vec3 uColorB; uniform float uTime;
${CLIP_PARS}
varying vec2 vUv; varying vec3 vNw; varying vec3 vPw;
void main(){
  ${CLIP}
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
uniform vec3 uSun; uniform vec3 uColorA; uniform vec3 uColorB; uniform float uOpacity;
varying vec3 vNw; varying vec3 vPw;
void main(){
  vec3 N = normalize(vNw);
  vec3 V = normalize(cameraPosition - vPw);
  float f = pow(1. - max(dot(N, V), 0.), 2.6);
  float lit = .3 + .7 * smoothstep(-.35, .55, dot(N, uSun));
  gl_FragColor = vec4(mix(uColorB, uColorA, lit) * f * lit * .38 * uOpacity, 1.);
}`;

const LINE_VERT = /* glsl */ `
attribute vec3 color; varying vec3 vL; varying vec3 vCol;
void main(){ vL = position; vCol = color; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`;
const LINE_FRAG = /* glsl */ `
uniform vec3 uColor; uniform float uOpacity; uniform float uVC; ${CLIP_PARS} varying vec3 vCol;
void main(){ ${CLIP} gl_FragColor = vec4(mix(uColor, vCol, uVC) * uOpacity, 1.); }`;

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
uniform float uReplay; uniform float uR; uniform vec3 uCutN; uniform float uSide;
varying vec2 vUv; varying float vMag; varying float vPhase;
void main(){
  vec3 n = normalize(iDir);
  if (dot(n, uCutN) * uSide < 0.) { gl_Position = vec4(2., 2., 2., 1.); return; }
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

// diamonds: natural events, city beacons, hypocentres on the cut face
const POINT_VERT = /* glsl */ `
attribute vec3 color; attribute float aSize;
uniform float uScale; uniform float uTime; uniform float uSize; uniform vec3 uCutN; uniform float uSide; uniform float uClip;
varying vec3 vCol; varying float vTw;
void main(){
  if (uClip > .5 && dot(position, uCutN) * uSide < 0.) { gl_Position = vec4(2., 2., 2., 1.); return; }
  vec4 mv = modelViewMatrix * vec4(position, 1.);
  gl_Position = projectionMatrix * mv;
  vCol = color;
  vTw = .6 + .4 * sin(uTime * 3. + position.x * 37. + position.z * 91.);
  gl_PointSize = clamp(uSize * aSize * uScale / -mv.z, 2., 26.);
}`;
const POINT_FRAG = /* glsl */ `
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
varying vec2 vUv; varying vec3 vNw; varying vec3 vL;
void main(){
  float a = uv.x * 6.28318;
  vec3 p = normalize(uPole);
  vec3 e1 = normalize(cross(p, vec3(1., 0., 0.)));
  vec3 e2 = cross(p, e1);
  float colat = radians(mix(18., 37., clamp(uKp / 9., 0., 1.))) + sin(a * 3. + uTime * .25) * .035 + sin(a * 7. - uTime * .4) * .012;
  vec3 dir = cos(colat) * p + sin(colat) * (cos(a) * e1 + sin(a) * e2);
  vec3 pos = dir * uR * (1.012 + uv.y * .14);
  vL = pos;
  vec4 wp = modelMatrix * vec4(pos, 1.);
  vNw = normalize(mat3(modelMatrix) * dir);
  vUv = uv;
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const AURORA_FRAG = /* glsl */ `
uniform float uKp; uniform float uTime; uniform vec3 uSun; uniform float uOpacity;
${CLIP_PARS}
varying vec2 vUv; varying vec3 vNw;
void main(){
  ${CLIP}
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

/* The cut face: Earth's interior to scale (PREM boundaries), drawn as heat. */
const CAP_FRAG = /* glsl */ `
${NOISE_GLSL}
uniform float uTime; uniform vec3 uColorA; uniform float uR; uniform float uGlow;
varying vec2 vP;
void main(){
  float r = length(vP) / uR;
  if (r > 1.) discard;
  float ang = atan(vP.y, vP.x);
  vec2 q = vP / uR;
  // boundaries: inner core .1915 · outer core .546 · lower mantle .8965 · upper mantle .9945
  float n1 = snoise(vec3(q * 3.2, uTime * .12));
  float n2 = snoise(vec3(q * 9., uTime * .3 + 4.));
  float plume = snoise(vec3(ang * 2.2, r * 5. - uTime * .22, 1.7));
  vec3 inner = vec3(1., .93, .68) * (.95 + .25 * n2);
  vec3 outer = mix(vec3(1., .42, .06), vec3(1., .72, .2), .5 + .5 * snoise(vec3(q * 5. + vec2(sin(uTime * .2), cos(uTime * .17)) * .6, uTime * .35))) * .75;
  vec3 lower = vec3(.62, .09, .03) * (.55 + .5 * smoothstep(-.2, .7, plume));
  vec3 upper = vec3(.85, .26, .06) * (.5 + .25 * n1);
  vec3 crust = uColorA * 1.3;
  vec3 col = inner;
  col = mix(col, outer, smoothstep(.186, .197, r));
  col = mix(col, lower, smoothstep(.54, .552, r));
  col = mix(col, upper, smoothstep(.890, .902, r));
  col = mix(col, crust, smoothstep(.992, .996, r));
  // survey lines: layer boundaries, 500 km depth rings, 15° spokes
  float fw = fwidth(r) * 1.5 + 1e-4;
  float b = 0.;
  b += 1. - smoothstep(0., fw, abs(r - .1915));
  b += 1. - smoothstep(0., fw, abs(r - .546));
  b += 1. - smoothstep(0., fw, abs(r - .8965));
  float rk = r * 12.756;                       // one ring per 500 km
  float rings = 1. - min(abs(fract(rk) - .5) / (fwidth(rk) + 1e-4), 1.);
  float sp = ang * 3.8197;
  float spokes = (1. - min(abs(fract(sp) - .5) / (fwidth(sp) + 1e-4), 1.)) * smoothstep(.2, .3, r);
  col *= .2 + uGlow * .13;
  col += uColorA * (rings * .09 + spokes * .06) + vec3(1., .95, .85) * b * .4;
  float scan = smoothstep(.985, 1., sin(vP.y * 1.6 - uTime * 1.1) * .5 + .5);
  col += uColorA * scan * .14;
  gl_FragColor = vec4(col, 1.);
}`;

const INNER_VERT = /* glsl */ `
${NOISE_GLSL}
uniform float uTime;
varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main(){
  float n = snoise(position * 1.6 + uTime * .3) * .5 + snoise(position * 3.4 - uTime * .45) * .25;
  vP = position;
  vec4 wp = modelMatrix * vec4(position + normal * n * .07, 1.);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;
const INNER_FRAG = /* glsl */ `
${NOISE_GLSL}
uniform float uTime; uniform float uFlash;
varying vec3 vN; varying vec3 vV; varying vec3 vP;
void main(){
  float fr = pow(1. - max(dot(normalize(vN), normalize(vV)), 0.), 1.7);
  float n1 = snoise(vP * 2.3 + vec3(0., uTime * .2, uTime * .1));
  float n2 = snoise(vP * 5. - vec3(uTime * .3));
  float crack = 1. - smoothstep(0., .1, abs(n1 + n2 * .35));
  vec3 col = vec3(1., .5, .1) * (.18 + fr * .55) + vec3(1., .93, .7) * crack * .9 + vec3(1., .3, .05) * (.12 + .12 * n2);
  gl_FragColor = vec4(col * (1. + uFlash * 2.5), 1.);
}`;
const SHELL_FRAG = /* glsl */ `
${NOISE_GLSL}
uniform float uTime; uniform float uOpacity;
varying vec3 vNw; varying vec3 vPw; varying vec3 vL;
void main(){
  float fr = pow(1. - abs(dot(normalize(vNw), normalize(cameraPosition - vPw))), 1.6);
  float flow = .5 + .5 * snoise(vL * .9 + vec3(uTime * .25, -uTime * .18, uTime * .1));
  flow *= .5 + .5 * snoise(vL * 2.4 - vec3(uTime * .2));
  gl_FragColor = vec4(vec3(1., .46, .1) * (fr * .3 + flow * .12) * uOpacity, 1.);
}`;

// sparks thrown out along the fracture
const SPARK_VERT = /* glsl */ `
attribute vec4 aSeed;
uniform float uTime; uniform vec3 uCutN; uniform float uGap; uniform float uScale; uniform float uR;
varying float vLife;
void main(){
  vec3 e2 = vec3(0., 1., 0.);
  vec3 e1 = normalize(cross(e2, uCutN));
  float life = fract(uTime * (.12 + aSeed.x * .25) + aSeed.y);
  float a = aSeed.z * 6.28318 + life * (aSeed.w - .5) * 2.;
  float r = mix(1.1, uR * 1.5, pow(life, .8));
  vec3 p = (cos(a) * e1 + sin(a) * e2) * r + uCutN * (aSeed.w - .5) * uGap * (.3 + life);
  vec4 mv = modelViewMatrix * vec4(p, 1.);
  gl_Position = projectionMatrix * mv;
  vLife = life;
  gl_PointSize = clamp((.05 + aSeed.x * .09) * uScale / -mv.z, 1., 12.);
}`;
const SPARK_FRAG = /* glsl */ `
uniform float uOpacity; varying float vLife;
void main(){
  float d = length(gl_PointCoord - .5);
  float a = smoothstep(.5, 0., d);
  vec3 col = mix(vec3(1., .9, .6), vec3(1., .25, .05), vLife);
  gl_FragColor = vec4(col * a * a * (1. - vLife) * uOpacity, 1.);
}`;

/* ---------- construction helpers ---------- */

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
  geo.setAttribute('color', new THREE.Float32BufferAttribute(new Float32Array(pts.length).fill(1), 3));
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
// seismological reference model (PREM): outer radius fraction, name, description, stats
const LAYERS = [
  { r: 0.1915, tag: 'INNER CORE', name: 'INNER CORE', sub: 'SOLID IRON–NICKEL · ~5,400 °C · R 1,220 KM',
    desc: 'A solid ball of iron and nickel about the size of the Moon, as hot as the surface of the Sun. Pressure keeps it from melting.',
    stats: [['RADIUS', 0.19, '1,220 KM'], ['TEMPERATURE', 0.95, '~5,400 °C'], ['PRESSURE', 1, '330–360 GPA'], ['DENSITY', 1, '~13 G/CM³']] },
  { r: 0.546, tag: 'OUTER CORE', name: 'OUTER CORE', sub: 'LIQUID IRON · THE GEODYNAMO · 2,260 KM THICK',
    desc: 'An ocean of liquid metal. Its churning generates the magnetic field that steers compasses and feeds the aurora you can see at the poles.',
    stats: [['THICKNESS', 0.35, '2,260 KM'], ['TEMPERATURE', 0.8, '4,000–5,400 °C'], ['DENSITY', 0.85, '10–12 G/CM³']] },
  { r: 0.8965, tag: 'LOWER MANTLE', name: 'LOWER MANTLE', sub: 'SOLID ROCK THAT FLOWS · 2,230 KM THICK',
    desc: 'Solid rock that creeps a few centimetres a year. This slow convection is the engine that moves the plates — and causes every quake on the map.',
    stats: [['THICKNESS', 0.35, '2,230 KM'], ['TEMPERATURE', 0.55, '1,900–3,700 °C'], ['DENSITY', 0.4, '4.4–5.6 G/CM³']] },
  { r: 0.9945, tag: 'UPPER MANTLE', name: 'UPPER MANTLE', sub: 'TO 660 KM · WHERE THE DEEPEST QUAKES STOP',
    desc: 'Sinking slabs of ocean floor carry earthquakes down through here. Below about 700 km the rock is too hot to snap.',
    stats: [['DEPTH RANGE', 0.1, '35–660 KM'], ['TEMPERATURE', 0.3, '900–1,900 °C'], ['DENSITY', 0.28, '3.4–4.4 G/CM³']] },
  { r: 1.01, tag: 'CRUST', name: 'CRUST', sub: '5–70 KM · EVERYTHING YOU HAVE EVER SEEN',
    desc: 'To scale it is thinner than the line drawing it. Oceanic crust is about 7 km thick; under mountain ranges it reaches 70.',
    stats: [['THICKNESS', 0.02, '5–70 KM'], ['TEMPERATURE', 0.12, '≤ 900 °C'], ['DENSITY', 0.22, '2.7–3.0 G/CM³']] },
];
const MAXQ = 1200;

export function createTerra() {
  const group = new THREE.Group();
  const spin = new THREE.Group();
  group.add(spin);
  group.visible = false;

  const sun = new THREE.Vector3(1, 0, 0);
  const uSun = { value: sun };
  const uScale = { value: 1000 };
  const cutN = new THREE.Vector3(0, 0, -1); // unit normal of the cut plane, Earth-fixed frame
  const uCutN = { value: cutN };
  const fade = { value: 1 }; // dims surface overlays as the planet opens

  const halves = [1, -1].map((side) => {
    const g = new THREE.Group();
    spin.add(g);
    return { side, g, uSide: { value: side } };
  });
  const halfOf = (dir) => (dir.dot(cutN) >= 0 ? halves[0] : halves[1]);
  const clipU = (h) => ({ uCutN, uSide: h.uSide });

  /* ----- surface: built once per hemisphere, sharing geometry ----- */
  const land = landCanvas(2048, 1024);
  const landTex = new THREE.CanvasTexture(land.canvas);
  landTex.anisotropy = 8;
  const globeGeo = new THREE.SphereGeometry(RE, 128, 64);
  const coastGeo = lineGeometry(topoMesh(land50, land50.objects.land), RE * 1.002);
  const borderGeo = lineGeometry(topoMesh(countries110, countries110.objects.countries, (a, b) => a !== b), RE * 1.002);
  const coastColor = { value: new THREE.Color() };
  const borderColor = { value: new THREE.Color() };
  const lineMat = (h, uColor, opacity, vc = 0) => new THREE.ShaderMaterial({
    uniforms: { ...clipU(h), uColor, uOpacity: { value: opacity }, uVC: { value: vc } },
    vertexShader: LINE_VERT, fragmentShader: LINE_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });

  const auroraU = { uKp: { value: 2 }, uR: { value: RE }, uTime: U.time, uSun, uOpacity: { value: 1 } };
  const auroraGeo = new THREE.PlaneGeometry(1, 1, 180, 5);

  const quakeGeo = new THREE.InstancedBufferGeometry();
  const plane = new THREE.PlaneGeometry(1, 1);
  quakeGeo.index = plane.index;
  quakeGeo.setAttribute('position', plane.attributes.position);
  quakeGeo.setAttribute('uv', plane.attributes.uv);
  quakeGeo.setAttribute('iDir', new THREE.InstancedBufferAttribute(new Float32Array(MAXQ * 3), 3));
  quakeGeo.setAttribute('iData', new THREE.InstancedBufferAttribute(new Float32Array(MAXQ * 3), 3));
  quakeGeo.instanceCount = 0;
  const quakeU = { uReplay: { value: 0 }, uR: { value: RE }, uColorA: U.colorA, uOpacity: { value: 1 } };
  const spikeGeo = new THREE.BufferGeometry();
  const eventGeo = new THREE.BufferGeometry();
  const hypoGeo = new THREE.BufferGeometry();
  const white = { value: new THREE.Color(1, 1, 1) };
  const pointMat = (h, size, clip) => new THREE.ShaderMaterial({
    uniforms: { ...clipU(h), uScale, uTime: U.time, uOpacity: { value: 1 }, uSize: { value: size }, uClip: { value: clip ? 1 : 0 } },
    vertexShader: POINT_VERT, fragmentShader: POINT_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });

  // city beacons: a pillar of light and a marker over each modelled city
  const cities = CITIES.map((c) => {
    const dir = llToVec(c.lat, c.lon, 1);
    const anchor = new THREE.Object3D();
    anchor.position.copy(dir).multiplyScalar(RE * 1.1);
    return {
      ...c, dir, anchor,
      label: { anchor, title: c.name, sub: '', front: 0, group: 'terra', mini: true, dirty: true },
      part: { static: true, city: c, dir, info: { id: `${c.country} · ${fmtLL(c.lat, c.lon)}`, tag: c.name, name: c.name, desc: `${c.district}. ${c.note} Click to descend.`, stats: [] } },
    };
  });
  const cityLineGeo = new THREE.BufferGeometry();
  const cityPtGeo = new THREE.BufferGeometry();
  {
    const lp = [], lc = [], pp = [], pc = [], ps = [];
    for (const c of cities) {
      lp.push(c.dir.x * RE, c.dir.y * RE, c.dir.z * RE, c.dir.x * RE * 1.1, c.dir.y * RE * 1.1, c.dir.z * RE * 1.1);
      lc.push(0.2, 0.2, 0.2, 1, 1, 1);
      pp.push(c.dir.x * RE * 1.1, c.dir.y * RE * 1.1, c.dir.z * RE * 1.1);
      pc.push(1, 1, 1); ps.push(1);
    }
    cityLineGeo.setAttribute('position', new THREE.Float32BufferAttribute(lp, 3));
    cityLineGeo.setAttribute('color', new THREE.Float32BufferAttribute(lc, 3));
    cityPtGeo.setAttribute('position', new THREE.Float32BufferAttribute(pp, 3));
    cityPtGeo.setAttribute('color', new THREE.Float32BufferAttribute(pc, 3));
    cityPtGeo.setAttribute('aSize', new THREE.Float32BufferAttribute(ps, 1));
  }

  const capU = { uTime: U.time, uColorA: U.colorA, uR: { value: RE }, uGlow: { value: 0 } };
  const capGeo = new THREE.CircleGeometry(RE * 0.999, 160);
  const layerObjs = { quakes: [], events: [], aurora: [], cities: [] };

  for (const h of halves) {
    const globe = new THREE.Mesh(globeGeo, new THREE.ShaderMaterial({
      uniforms: { ...clipU(h), uLand: { value: landTex }, uSun, uColorA: U.colorA, uColorB: U.colorB, uTime: U.time },
      vertexShader: GLOBE_VERT, fragmentShader: GLOBE_FRAG,
    }));
    const coast = new THREE.LineSegments(coastGeo, lineMat(h, coastColor, 0.75));
    const border = new THREE.LineSegments(borderGeo, lineMat(h, borderColor, 0.22));
    h.g.add(globe, coast, border);

    for (const [lat, lon] of [[80.7, -72.7], [-80.7, 107.3]]) {
      const m = new THREE.Mesh(auroraGeo, new THREE.ShaderMaterial({
        uniforms: { ...auroraU, ...clipU(h), uPole: { value: llToVec(lat, lon, 1) } },
        vertexShader: AURORA_VERT, fragmentShader: AURORA_FRAG,
        transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
      }));
      m.frustumCulled = false;
      h.g.add(m);
      layerObjs.aurora.push(m);
    }

    const rings = new THREE.Mesh(quakeGeo, new THREE.ShaderMaterial({
      uniforms: { ...quakeU, ...clipU(h) }, vertexShader: QUAKE_VERT, fragmentShader: QUAKE_FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    }));
    const spikes = new THREE.LineSegments(spikeGeo, lineMat(h, white, 0.9, 1));
    const evts = new THREE.Points(eventGeo, pointMat(h, 0.11, true));
    const cLines = new THREE.LineSegments(cityLineGeo, lineMat(h, white, 0.85, 1));
    const cPts = new THREE.Points(cityPtGeo, pointMat(h, 0.2, true));
    for (const o of [rings, spikes, evts, cLines, cPts]) { o.frustumCulled = false; h.g.add(o); }
    layerObjs.quakes.push(rings, spikes);
    layerObjs.events.push(evts);
    layerObjs.cities.push(cLines, cPts);

    // the cut face and the hypocentres that lie near it
    h.cap = new THREE.Mesh(capGeo, new THREE.ShaderMaterial({
      uniforms: capU,
      vertexShader: 'varying vec2 vP; void main(){ vP = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
      fragmentShader: CAP_FRAG, side: THREE.DoubleSide,
    }));
    h.hypo = new THREE.Points(hypoGeo, pointMat(h, 0.13, false));
    h.hypo.frustumCulled = false;
    h.cap.visible = h.hypo.visible = false;
    h.g.add(h.cap, h.hypo);
  }

  // interior label anchors ride on the first hemisphere's cut face (disc-local x/y)
  const layerLabels = [[0, 0], [-0.22, 0.3], [0.3, -0.62], [0.72, 0.6], [-0.62, -0.77]].map(([x, y], i) => {
    const anchor = new THREE.Object3D();
    anchor.position.set(x * RE, y * RE, 0.02);
    halves[0].cap.add(anchor);
    return { anchor, title: LAYERS[i].name, sub: LAYERS[i].sub, front: 0, group: 'terra', dirty: true };
  });
  const sectionLabel = { anchor: new THREE.Object3D(), title: 'SEISMIC SECTION', sub: '', front: 0, group: 'terra', dirty: true };
  sectionLabel.anchor.position.set(0, RE * 0.96, 0.02);
  halves[1].cap.add(sectionLabel.anchor);
  const layerParts = LAYERS.map((L) => ({ static: true, layer: L, info: { id: 'INTERIOR · PREM', tag: L.tag, name: L.name, desc: L.desc, stats: L.stats } }));

  /* ----- things that do not split ----- */
  const atmoU = { uSun, uColorA: U.colorA, uColorB: U.colorB, uOpacity: { value: 1 } };
  const atmo = new THREE.Mesh(new THREE.SphereGeometry(RE * 1.12, 64, 32), new THREE.ShaderMaterial({
    uniforms: atmoU, vertexShader: GLOBE_VERT, fragmentShader: ATMO_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  group.add(atmo);

  const innerU = { uTime: U.time, uFlash: { value: 0 } };
  const innerCore = new THREE.Mesh(new THREE.IcosahedronGeometry(RE * 0.1915, 20), new THREE.ShaderMaterial({ uniforms: innerU, vertexShader: INNER_VERT, fragmentShader: INNER_FRAG }));
  const shellU = { uTime: U.time, uOpacity: { value: 0 } };
  const outerShell = new THREE.Mesh(new THREE.SphereGeometry(RE * 0.546, 64, 32), new THREE.ShaderMaterial({
    uniforms: shellU, vertexShader: GLOBE_VERT, fragmentShader: SHELL_FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
  }));
  const sparkU = { uTime: U.time, uCutN, uGap: { value: 0 }, uScale, uR: { value: RE }, uOpacity: { value: 0 } };
  const sparkGeo = new THREE.BufferGeometry();
  {
    const N = 2600;
    const seed = new Float32Array(N * 4);
    for (let i = 0; i < seed.length; i++) seed[i] = Math.random();
    sparkGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(N * 3), 3));
    sparkGeo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));
  }
  const sparks = new THREE.Points(sparkGeo, new THREE.ShaderMaterial({
    uniforms: sparkU, vertexShader: SPARK_VERT, fragmentShader: SPARK_FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  sparks.frustumCulled = false;
  const interior = new THREE.Group();
  interior.add(innerCore, outerShell, sparks);
  interior.visible = false;
  spin.add(interior);

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
  const quakeLabels = [0, 1, 2].map(() => ({ anchor: new THREE.Object3D(), title: '', sub: '', front: 0, group: 'terra', dirty: true, active: false }));

  /* hover lock ring */
  const lock = new THREE.Mesh(
    new THREE.RingGeometry(0.2, 0.235, 40),
    new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, side: THREE.DoubleSide, blending: THREE.AdditiveBlending, depthWrite: false }),
  );
  lock.visible = false;

  /* ---------- data binding ---------- */
  let quakes = [];
  let events = [];
  let tRef = Date.now(); // ms; satellite elements are expressed at this instant
  let satElems = null;
  let replayIdx = 0;
  let split = 0;
  let pendingCut = null;
  const census = { total: 0, mega: 0, leo: 0, meo: 0, geo: 0, heo: 0, starlink: 0 };
  const section = { count: 0, deepest: 0, through: '' };
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();

  // Aim the cut plane through a point on the surface (and the poles), then file
  // everything that rides on the crust under the right hemisphere.
  function setCut(dir, name) {
    if (split > 0.01) { pendingCut = [dir, name]; return; }
    pendingCut = null;
    tmp.crossVectors(UP, dir);
    if (tmp.lengthSq() < 1e-4) tmp.set(0, 0, -1);
    cutN.copy(tmp.normalize());
    section.through = name || '';
    for (const h of halves) {
      // face the gap: a disc whose normal points at the other hemisphere
      // (the normal is horizontal, so the shortest turn from +Z keeps the disc upright)
      h.cap.quaternion.setFromUnitVectors(Z, tmp2.copy(cutN).multiplyScalar(-h.side));
      h.hypo.position.copy(cutN).multiplyScalar(-h.side * 0.03);
    }
    for (const c of cities) halfOf(c.dir).g.add(c.anchor);
    quakeLabels.forEach((L) => { if (L.dir) halfOf(L.dir).g.add(L.anchor); });
    buildSection();
  }

  // hypocentres within 15° of the cut, laid on the face at their true depth
  function buildSection() {
    const pos = [], col = [], size = [];
    const c = new THREE.Color();
    section.count = 0; section.deepest = 0;
    for (const q of quakes) {
      const off = q.dir.dot(cutN);
      if (Math.abs(off) > 0.26) continue;
      tmp.copy(q.dir).addScaledVector(cutN, -off).normalize().multiplyScalar(RE * (1 - q.depth / 6371));
      pos.push(tmp.x, tmp.y, tmp.z);
      c.setRGB(1, 0.8, 0.3).lerp(new THREE.Color(1, 0.2, 0.75), clamp(q.depth / 400)); // shallow amber → deep magenta
      col.push(c.r, c.g, c.b);
      size.push(0.6 + Math.pow(1.5, q.mag - 2.5) * 0.35);
      section.count++;
      section.deepest = Math.max(section.deepest, q.depth);
    }
    hypoGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    hypoGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    hypoGeo.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
    sectionLabel.sub = `${section.count} HYPOCENTRES WITHIN 15° · DEEPEST ${section.deepest.toFixed(0)} KM`;
    sectionLabel.dirty = true;
  }

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
      q.part = {
        static: true, quake: q, dir: q.dir,
        info: {
          id: `USGS · ${q.id}`, tag: `M${q.mag.toFixed(1)}`, name: `M ${q.mag.toFixed(1)} EARTHQUAKE`,
          desc: `${q.place}. ${ago(q.time).toLowerCase()} · ${fmtLL(q.lat, q.lon)}${q.tsunami ? ' · tsunami advisory issued' : ''}`,
          stats: [
            ['MAGNITUDE', q.mag / 9, q.mag.toFixed(1)], ['DEPTH', clamp(q.depth / 300), `${q.depth.toFixed(0)} KM`],
            ['AGE', clamp((now - q.time) / (7 * 86400e3)), ago(q.time).replace(' AGO', '')],
            ['ENERGY', clamp((q.mag - 2.5) / 6), energyText(Math.pow(10, 1.5 * q.mag + 4.8))],
          ],
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
      L.quake = q;
    });
    // open the planet through the week's strongest earthquake
    if (top[0]) setCut(top[0].dir, `M${top[0].mag.toFixed(1)} ${top[0].place.split(' of ').pop().toUpperCase()}`);
  }

  function setEvents(list) {
    events = list;
    const pos = [], col = [], size = [];
    const v = new THREE.Vector3();
    for (const e of events) {
      llToVec(e.lat, e.lon, RE * 1.006, v);
      e.dir = v.clone().normalize();
      const style = EVENT_STYLE[e.cat] || [e.cat.toUpperCase(), [0.8, 0.65, 1]];
      pos.push(v.x, v.y, v.z);
      col.push(...style[1]);
      size.push(1);
      e.part = {
        static: true, dir: e.dir,
        info: {
          id: `NASA · ${e.id}`, tag: style[0], name: style[0], desc: `${e.title}. Open event tracked by NASA EONET.`,
          stats: [['LATITUDE', (e.lat + 90) / 180, `${Math.abs(e.lat).toFixed(2)}°${e.lat >= 0 ? 'N' : 'S'}`], ['LONGITUDE', (e.lon + 180) / 360, `${Math.abs(e.lon).toFixed(2)}°${e.lon >= 0 ? 'E' : 'W'}`]],
        },
      };
    }
    eventGeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    eventGeo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
    eventGeo.setAttribute('aSize', new THREE.Float32BufferAttribute(size, 1));
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
  const inv = new THREE.Matrix4();
  const lray = new THREE.Ray();
  const hit = new THREE.Vector3();
  const cursor = { on: false, lat: 0, lon: 0, depth: -1 };

  // nearest thing the ray meets: a hemisphere's crust, or (when open) a cut face
  function surfaceHit(ray) {
    let best = null;
    for (const h of halves) {
      inv.copy(h.g.matrixWorld).invert();
      lray.copy(ray).applyMatrix4(inv); // both halves share one scale, so local t compares fairly
      const o = lray.origin, d = lray.direction;
      const a = d.dot(d), b = o.dot(d), c = o.dot(o) - RE * RE;
      const disc = b * b - a * c;
      if (disc >= 0) {
        const t = (-b - Math.sqrt(disc)) / a;
        if (t > 0) {
          hit.copy(o).addScaledVector(d, t);
          if (hit.dot(cutN) * h.side >= 0 && (!best || t < best.t)) best = { t, half: h, local: hit.clone(), face: false };
        }
      }
      if (split > 0.02) {
        const dn = d.dot(cutN);
        if (Math.abs(dn) > 1e-6) {
          const t = -o.dot(cutN) / dn;
          if (t > 0) {
            hit.copy(o).addScaledVector(d, t);
            if (hit.lengthSq() < RE * RE && (!best || t < best.t)) best = { t, half: h, local: hit.clone(), face: true };
          }
        }
      }
    }
    return best;
  }

  function pick(raycaster, pointer, camera, w, h) {
    cursor.on = false; cursor.depth = -1;
    if (layerState.sats) {
      for (const st of stations) {
        if (!st.el || st.label.front < 0.5) continue;
        tmp.copy(st.pos).multiplyScalar(group.scale.x).project(camera);
        const dx = ((tmp.x - pointer.x) * w) / 2;
        const dy = ((tmp.y - pointer.y) * h) / 2;
        if (dx * dx + dy * dy < 20 * 20) return st.part;
      }
    }
    const s = surfaceHit(raycaster.ray);
    if (!s) return null;
    if (s.face) {
      const r = s.local.length() / RE;
      cursor.on = true; cursor.depth = (1 - r) * 6371;
      return layerParts[LAYERS.findIndex((L) => r <= L.r)] || null;
    }
    tmp.copy(s.local).normalize();
    const ll = vecToLL(tmp);
    cursor.on = true; cursor.lat = ll.lat; cursor.lon = ll.lon;
    if (layerState.cities) {
      for (const c of cities) if (tmp.dot(c.dir) > 0.9993) return c.part; // ~2°
    }
    let best = null;
    let bestScore = 0;
    if (layerState.quakes) {
      for (const q of quakes) {
        const d = Math.acos(clamp(tmp.dot(q.dir), -1, 1));
        const reach = 0.02 + 0.01 * Math.pow(1.72, q.mag - 2.5);
        if (d < reach && q.mag > bestScore) { best = q.part; bestScore = q.mag; }
      }
    }
    if (!best && layerState.events) {
      let bd = 0.02;
      for (const e of events) {
        const d = Math.acos(clamp(tmp.dot(e.dir), -1, 1));
        if (d < bd) { bd = d; best = e.part; }
      }
    }
    return best;
  }

  function setLock(part) {
    const dir = part && part.dir;
    lock.visible = !!dir;
    if (!dir) return;
    halfOf(dir).g.add(lock);
    lock.position.copy(dir).multiplyScalar(RE * 1.008);
    lock.lookAt(tmp.copy(dir).multiplyScalar(RE * 3).applyMatrix4(lock.parent.matrixWorld));
    lock.userData.s = part.quake ? 1 + Math.pow(1.72, part.quake.mag - 2.5) * 0.55 : part.city ? 1.6 : 1;
  }

  /* ---------- layers ---------- */
  const layerState = { sats: true, quakes: true, events: true, aurora: true, cities: true };
  function setLayer(name, on) {
    layerState[name] = on;
    if (name === 'sats') satPts.visible = on;
    else for (const o of layerObjs[name]) o.visible = on;
  }

  /* ---------- per frame ---------- */
  const camDir = new THREE.Vector3();
  const wp = new THREE.Vector3();
  const capN = new THREE.Vector3();
  let slow = 0;

  function occluded(p, cam, R) {
    // does the (closed) globe sit between the camera and p?
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
  // surface points ride on their hemisphere, so test against where it actually faces
  function facing(anchor, camera) {
    anchor.getWorldPosition(wp);
    capN.copy(wp).sub(tmp.setFromMatrixPosition(anchor.parent.matrixWorld)).normalize();
    return capN.dot(camDir.copy(camera.position).sub(wp).normalize()) > 0.12 ? 1 : 0;
  }

  function update(rawDt, simMs, k, camera, hooks, splitNow) {
    // sidereal spin and the sun are tracked even while hidden: the swarm keys off them
    spin.rotation.y = gmst(simMs);
    sunDirection(simMs, sun);
    split = splitNow;
    if (pendingCut && split < 0.01) setCut(...pendingCut);
    group.visible = k > 0.002;
    if (!group.visible) return;
    const s = Math.max(0.0001, k);
    group.scale.setScalar(s);
    coastColor.value.copy(U.colorA.value);
    borderColor.value.copy(U.colorB.value);
    lock.material.color.copy(U.colorB.value).lerp(new THREE.Color(1, 1, 1), 0.5);
    if (lock.visible) lock.scale.setScalar((lock.userData.s || 1) * (1 + 0.12 * Math.sin(performance.now() * 0.008)));

    // open the planet like a book: the halves slide apart and swing to face the viewer
    const e = split * split * (3 - 2 * split);
    const open = split > 0.002;
    for (const h of halves) {
      h.g.position.copy(cutN).multiplyScalar(h.side * e * RE * 0.78);
      h.g.rotation.y = h.side * e * 0.62;
      h.g.updateMatrix(); // the swarm reads this to split along with its hemisphere
      h.cap.visible = h.hypo.visible = open;
    }
    interior.visible = open;
    capU.uGlow.value = e;
    shellU.uOpacity.value = e;
    sparkU.uOpacity.value = e * 0.6;
    sparkU.uGap.value = e * RE * 1.5;
    innerU.uFlash.value = Math.max(0, innerU.uFlash.value - rawDt * 1.5);
    atmoU.uOpacity.value = 1 - e;
    innerCore.rotation.y += rawDt * 0.2;

    // seismic replay: the last seven days loop past in 75 seconds
    const prev = quakeU.uReplay.value;
    const next = (prev + rawDt / 75) % 1;
    quakeU.uReplay.value = next;
    if (next < prev) replayIdx = 0;
    while (replayIdx < quakes.length && quakes[replayIdx].tn <= next) {
      if (k > 0.9 && layerState.quakes) hooks.onQuake(quakes[replayIdx]);
      replayIdx++;
    }

    if (satElems) {
      if (Math.abs(simMs - tRef) > 1.5e8) rebase(simMs);
      satU.uT.value = (simMs - tRef) / 1000;
    }

    const R = RE * s;
    const f8 = Math.min(1, rawDt * 8);
    for (const st of stations) {
      if (!st.el) continue;
      kepler(st.el, (simMs - tRef) / 1000, st.pos);
      st.marker.position.copy(st.pos);
      st.anchor.position.copy(st.pos);
      st.marker.material.rotation += rawDt * 0.6;
      wp.copy(st.pos).multiplyScalar(s);
      // (opened up, the interior callouts take over)
      const vis = layerState.sats && e < 0.4 && !occluded(wp, camera.position, R) ? 1 : 0;
      st.label.front += (vis - st.label.front) * f8;
      st.marker.visible = st.orbit.visible = layerState.sats;
    }
    for (const L of quakeLabels) {
      const vis = L.active && layerState.quakes && L.anchor.parent ? facing(L.anchor, camera) * (1 - e * 0.999 > 0.4 ? 1 : 0) : 0;
      L.front += (vis - L.front) * f8;
    }
    for (const c of cities) {
      const vis = layerState.cities && c.anchor.parent ? facing(c.anchor, camera) : 0;
      c.label.front += (vis - c.label.front) * f8;
    }
    // interior callouts: only once the planet is well open and the face is toward us
    capN.copy(cutN).multiplyScalar(-1).transformDirection(halves[0].g.matrixWorld);
    const faceVis = e > 0.55 && capN.dot(camDir.copy(camera.position).normalize()) > 0.1 ? 1 : 0;
    for (const L of layerLabels) L.front += (faceVis - L.front) * f8;
    capN.copy(cutN).transformDirection(halves[1].g.matrixWorld);
    const face2 = e > 0.55 && capN.dot(camDir) > 0.1 ? 1 : 0;
    sectionLabel.front += (face2 - sectionLabel.front) * f8;

    slow += rawDt;
    if (slow > 0.25) {
      slow = 0;
      const tSec = (simMs - tRef) / 1000;
      for (const st of stations) {
        if (!st.el) continue;
        // redraw the orbit trace where the plane is now (it precesses under time-warp)
        const ring = st.orbit.geometry.attributes.position;
        const frozen = { ...st.el, O: st.el.O + st.el.dO * tSec, w: st.el.w + st.el.dw * tSec, dO: 0, dw: 0, M0: 0, n: 1 };
        for (let j = 0; j < 240; j++) { kepler(frozen, (j / 240) * TAU, tmp); ring.setXYZ(j, tmp.x, tmp.y, tmp.z); }
        ring.needsUpdate = true;
        tmp.copy(st.pos).applyAxisAngle(UP, -spin.rotation.y);
        st.ll = vecToLL(tmp);
        st.alt = st.pos.length() / KM - RE_KM;
        const v = Math.sqrt(MU / (st.pos.length() / KM));
        st.label.sub = `${st.alt.toFixed(0)} KM · ${fmtLL(st.ll.lat, st.ll.lon)}`;
        st.label.dirty = true;
        st.part.info.stats = [
          ['ALTITUDE', clamp(st.alt / 600), `${st.alt.toFixed(0)} KM`],
          ['VELOCITY', clamp(v / 8), `${Math.round(v * 3600).toLocaleString('en-US')} KM/H`],
          ['INCLINATION', st.el.inc / 90, `${st.el.inc.toFixed(1)}°`],
          ['PERIOD', clamp(st.period / 100), `${st.period.toFixed(1)} MIN`],
        ];
      }
    }
  }

  setCut(new THREE.Vector3(1, 0, 0), '');

  return {
    group, spin, sun, uSun, uScale, uCutN, auroraU, stations, cities, census, cursor, section, halves,
    labels: [...stations.map((s) => s.label), ...quakeLabels, ...cities.map((c) => c.label), ...layerLabels, sectionLabel],
    layerState, setLayer,
    setQuakes, setEvents, setSatellites, landPoints, pick, setLock, update,
    flashCore: () => { innerU.uFlash.value = 1; },
    get quakes() { return quakes; },
  };
}

export function energyText(joules) {
  const tons = joules / 4.184e9; // tonnes of TNT
  if (tons >= 1e6) return `${(tons / 1e6).toFixed(tons >= 1e7 ? 0 : 1)} MT TNT`;
  if (tons >= 1e3) return `${(tons / 1e3).toFixed(tons >= 1e4 ? 0 : 1)} KT TNT`;
  return `${tons.toFixed(tons >= 10 ? 0 : 1)} T TNT`;
}
