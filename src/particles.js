import * as THREE from 'three';
import { U } from './shared.js';

/* 80,000 points that morph between whatever shapes they are handed: the
   continents, a city's survey grid. They bend away from the pointer, ride the
   shockwaves, and split with the planet. */

const VERT = /* glsl */ `
attribute vec3 aTo; attribute vec4 aSeed;
uniform float uTime, uMorph, uScale, uSize, uBurstR, uBurstAmp, uMouseForce, uChaos, uDrift, uSunMix, uSplitMix;
uniform vec3 uRayO, uRayD, uSun, uCutN;
uniform mat4 uHalfP, uHalfN;
varying float vMix; varying float vAlpha; varying float vSpark; varying float vNight;

vec3 flow(vec3 p, float t){
  return vec3(
    sin(p.y * .35 + t) + sin(p.z * .21 - t * .7),
    sin(p.z * .33 + t * .8) + sin(p.x * .27 + t * .5),
    sin(p.x * .31 - t * .6) + sin(p.y * .24 + t * .9));
}

void main(){
  float m = clamp(uMorph * 1.7 - aSeed.x * .7, 0., 1.);
  m = m * m * (3. - 2. * m);
  vec3 p = mix(position, aTo, m);
  float mid = sin(m * 3.14159);

  // idle drift + turbulence while re-forming
  p += flow(p * .6 + aSeed.xyz * 10., uTime * .55) * (uDrift + mid * 3.2 + uChaos * 1.4);
  // spiral through the axis mid-morph
  float sw = mid * (1.5 + aSeed.y * 2.);
  float cs = cos(sw), sn = sin(sw);
  p.xz = mat2(cs, -sn, sn, cs) * p.xz;

  // pointer ray pushes the swarm aside
  vec3 toP = p - uRayO;
  vec3 perp = toP - uRayD * dot(toP, uRayD);
  float d = length(perp);
  float f = exp(-d * d * .28) * uMouseForce;
  p += normalize(perp + 1e-4) * f * 2.6 + flow(p * 2., uTime * 2.) * f * .5;

  // shockwave shell
  float r = length(p);
  float w = exp(-pow(r - uBurstR, 2.) * .12) * uBurstAmp;
  p += normalize(p + 1e-4) * w * 3.5;

  // each point follows the hemisphere its landing spot belongs to
  vec3 ph = ((dot(aTo, uCutN) >= 0. ? uHalfP : uHalfN) * vec4(p, 1.)).xyz;
  p = mix(p, ph, uSplitMix * m);

  vec4 mv = modelViewMatrix * vec4(p, 1.);
  gl_Position = projectionMatrix * mv;
  float tw = .65 + .35 * sin(uTime * (1.5 + aSeed.z * 4.) + aSeed.w * 60.);
  vSpark = step(.985, aSeed.w);
  float size = uSize * (.45 + aSeed.z * 1.3 + vSpark * 1.6) * (1. + f * 1.5 + w * 2.);
  gl_PointSize = max(1., size * uScale / -mv.z);
  vMix = aSeed.y;
  // when the swarm is wearing the planet, it takes the real day/night line
  float day = smoothstep(-.12, .18, dot(normalize(mat3(modelMatrix) * p), uSun));
  vNight = (1. - day) * uSunMix;
  vAlpha = tw * (.55 + f + w) * (1. - vNight * .72);
}`;

const FRAG = /* glsl */ `
uniform vec3 uColorA; uniform vec3 uColorB; uniform float uOpacity;
varying float vMix; varying float vAlpha; varying float vSpark; varying float vNight;
void main(){
  float d = length(gl_PointCoord - .5);
  float a = smoothstep(.5, 0., d);
  a *= a;
  vec3 col = mix(uColorA, uColorB, max(smoothstep(.55, 1., vMix), vNight));
  col = mix(col, vec3(1.), (vSpark * .8 + a * .25) * (1. - vNight * .7));
  gl_FragColor = vec4(col * a * vAlpha * uOpacity, 1.);
}`;

export function createParticles(count) {
  // boot state: a wide scattered cloud, waiting to be told what to become
  const from = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    const u = Math.random() * 2 - 1;
    const a = Math.random() * Math.PI * 2;
    const s = Math.sqrt(1 - u * u);
    const r = 30 + Math.random() * 70;
    from[i * 3] = s * Math.cos(a) * r; from[i * 3 + 1] = u * r; from[i * 3 + 2] = s * Math.sin(a) * r;
  }
  const seed = new Float32Array(count * 4);
  for (let i = 0; i < seed.length; i++) seed[i] = Math.random();

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(from, 3));
  geo.setAttribute('aTo', new THREE.BufferAttribute(new Float32Array(from), 3));
  geo.setAttribute('aSeed', new THREE.BufferAttribute(seed, 4));

  const uniforms = {
    uTime: U.time, uColorA: U.colorA, uColorB: U.colorB,
    uBurstR: U.burstR, uBurstAmp: U.burstAmp,
    uMorph: { value: 1 }, uScale: { value: 1000 }, uSize: { value: 0.085 },
    uMouseForce: { value: 0 }, uChaos: { value: 0 }, uOpacity: { value: 0.34 },
    uDrift: { value: 0.16 }, uSunMix: { value: 0 }, uSun: { value: new THREE.Vector3(1, 0, 0) },
    uSplitMix: { value: 0 }, uCutN: { value: new THREE.Vector3(0, 0, 1) },
    uHalfP: { value: new THREE.Matrix4() }, uHalfN: { value: new THREE.Matrix4() },
    uRayO: { value: new THREE.Vector3(0, 0, 999) },
    uRayD: { value: new THREE.Vector3(0, 0, -1) },
  };
  const points = new THREE.Points(geo, new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  }));
  points.frustumCulled = false;

  let current = 'cloud';
  let morphing = false;
  const inv = new THREE.Matrix4();

  return {
    points, uniforms, count,
    get formation() { return current; },
    // morph to a new point set; wherever the swarm was heading becomes the starting shape
    morphTo(name, arr) {
      geo.attributes.position.array.set(geo.attributes.aTo.array);
      geo.attributes.aTo.array.set(arr);
      geo.attributes.position.needsUpdate = true;
      geo.attributes.aTo.needsUpdate = true;
      uniforms.uMorph.value = 0;
      morphing = true;
      current = name;
    },
    follow: null, // () => yaw; when set, the swarm is locked to that rotation instead of drifting
    setRay(ray) {
      inv.copy(points.matrixWorld).invert();
      uniforms.uRayO.value.copy(ray.origin).applyMatrix4(inv);
      uniforms.uRayD.value.copy(ray.direction).transformDirection(inv);
    },
    update(dt) {
      if (this.follow) points.rotation.y = this.follow();
      else points.rotation.y += dt * 0.02;
      if (morphing) {
        uniforms.uMorph.value = Math.min(1, uniforms.uMorph.value + dt / 2.8);
        if (uniforms.uMorph.value >= 1) morphing = false;
      }
    },
  };
}
