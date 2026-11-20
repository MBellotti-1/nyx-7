import * as THREE from 'three';
import { U, NOISE_GLSL, clamp, lerp, ease } from './shared.js';

/* ---------- hologram surface shader ---------- */

const HOLO_VERT = /* glsl */ `
varying vec3 vN; varying vec3 vV; varying vec2 vUv; varying vec3 vW;
void main(){
  vUv = uv;
  vec4 wp = modelMatrix * vec4(position, 1.);
  vW = wp.xyz;
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const HOLO_FRAG = /* glsl */ `
uniform float uTime; uniform vec3 uColorA; uniform vec3 uColorB;
uniform vec2 uGrid; uniform float uHover; uniform float uDim; uniform float uFill; uniform float uGain;
varying vec3 vN; varying vec3 vV; varying vec2 vUv; varying vec3 vW;
void main(){
  float fr = pow(1. - abs(dot(normalize(vN), normalize(vV))), 2.2);
  vec2 gu = vUv * uGrid;
  vec2 d = .5 - abs(fract(gu) - .5);
  vec2 fw = fwidth(gu) * 1.4 + 1e-5;
  float line = max(1. - smoothstep(0., fw.x, d.x), 1. - smoothstep(0., fw.y, d.y));
  float scan = .5 + .5 * sin(vW.y * 16. - uTime * 2.4);
  float sweep = smoothstep(.985, 1., sin(vW.y * .9 - uTime * 1.3) * .5 + .5);
  vec3 col = mix(uColorA, uColorB, fr * .8);
  float a = uFill + fr * .42 + line * .34 + scan * .02 + sweep * .35;
  a *= 1. + uHover * 1.6;
  col = mix(col, vec3(1.), uHover * line * .6);
  gl_FragColor = vec4(col * a * uDim * uGain, 1.);
}`;

export function holoMaterial({ grid = [12, 8], fill = 0.05, gain = 1 } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uTime: U.time, uColorA: U.colorA, uColorB: U.colorB,
      uGrid: { value: new THREE.Vector2(grid[0], grid[1]) },
      uHover: { value: 0 }, uDim: { value: 1 }, uFill: { value: fill }, uGain: { value: gain },
    },
    vertexShader: HOLO_VERT, fragmentShader: HOLO_FRAG,
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    blending: THREE.AdditiveBlending,
  });
}

/* ---------- plasma core shader ---------- */

const CORE_VERT = /* glsl */ `
${NOISE_GLSL}
uniform float uTime; uniform float uTurb;
varying vec3 vN; varying vec3 vV; varying vec3 vP; varying float vNoise;
void main(){
  float n = snoise(position * 1.4 + uTime * .35) * .5 + snoise(position * 3.1 - uTime * .5) * .25;
  vNoise = n; vP = position;
  vec3 p = position + normal * n * (.12 + uTurb * .45);
  vec4 wp = modelMatrix * vec4(p, 1.);
  vN = normalize(mat3(modelMatrix) * normal);
  vV = normalize(cameraPosition - wp.xyz);
  gl_Position = projectionMatrix * viewMatrix * wp;
}`;

const CORE_FRAG = /* glsl */ `
${NOISE_GLSL}
uniform float uTime; uniform vec3 uColorA; uniform vec3 uColorB;
uniform float uFlash; uniform float uHover; uniform float uDim; uniform float uTurb;
varying vec3 vN; varying vec3 vV; varying vec3 vP; varying float vNoise;
void main(){
  float fr = pow(1. - max(dot(normalize(vN), normalize(vV)), 0.), 1.8);
  float n1 = snoise(vP * 2.1 + vec3(0., uTime * .22, uTime * .1));
  float n2 = snoise(vP * 4.6 - vec3(uTime * .3));
  float crack = 1. - smoothstep(0., .09 + uTurb * .1, abs(n1 + n2 * .35));
  vec3 hot = mix(uColorB, vec3(1.), .65);
  vec3 col = uColorA * .1
           + uColorA * fr * .9
           + hot * crack * 1.5
           + uColorA * (vNoise * .5 + .5) * .22;
  col *= 1. + uFlash * 2.5 + uHover * .8;
  gl_FragColor = vec4(col * uDim, 1.);
}`;

/* ---------- helpers ---------- */

function glowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d');
  const grd = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  grd.addColorStop(0, 'rgba(255,255,255,1)');
  grd.addColorStop(0.18, 'rgba(255,255,255,.45)');
  grd.addColorStop(0.45, 'rgba(255,255,255,.1)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/* ---------- assembly ---------- */

export function createCore() {
  const root = new THREE.Group();
  const parts = [];
  const pickables = [];
  const labels = [];
  const tintA = []; // materials whose .color follows colorA
  const tintB = [];

  const lineMat = (opacity = 0.9, list = tintA) => {
    const m = new THREE.LineBasicMaterial({
      color: 0xffffff, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false,
    });
    list.push(m);
    return m;
  };
  const solidMat = (opacity = 0.9, list = tintA) => {
    const m = new THREE.MeshBasicMaterial({
      color: 0xffffff, transparent: true, opacity,
      blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide,
    });
    list.push(m);
    return m;
  };

  function addPart(obj, { dir = [0, 0, 0], delay = 0, scaleTo = 1, info, spin, pick = true }) {
    const part = {
      obj, home: obj.position.clone(), dir: new THREE.Vector3(...dir), delay,
      scaleFrom: obj.scale.x, scaleTo, info, spin,
      hover: 0, hoverTarget: 0, dim: 1, mats: [],
    };
    obj.traverse((o) => {
      if (!o.isMesh) return;
      if (o.material.uniforms && o.material.uniforms.uHover) part.mats.push(o.material);
      if (pick && (o.userData.pick || (o.material.uniforms && o.material.uniforms.uHover))) {
        o.userData.part = part;
        pickables.push(o);
      }
    });
    parts.push(part);
    root.add(obj);
    return part;
  }

  function addLabel(parent, pos, title, sub) {
    const anchor = new THREE.Object3D();
    anchor.position.set(...pos);
    parent.add(anchor);
    labels.push({ anchor, title, sub });
  }

  /* 1 — singularity core */
  const coreMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: U.time, uColorA: U.colorA, uColorB: U.colorB,
      uTurb: { value: 0 }, uFlash: { value: 0 }, uHover: { value: 0 }, uDim: { value: 1 },
    },
    vertexShader: CORE_VERT, fragmentShader: CORE_FRAG,
  });
  const coreMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1.15, 24), coreMat);
  const coreGroup = new THREE.Group();
  coreGroup.add(coreMesh);
  const glowMat = new THREE.SpriteMaterial({
    map: glowTexture(), color: 0xffffff, transparent: true, opacity: 0.07,
    blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false,
  });
  tintA.push(glowMat);
  const glow = new THREE.Sprite(glowMat);
  glow.scale.setScalar(11);
  glow.renderOrder = -1;
  coreGroup.add(glow);
  addPart(coreGroup, {
    info: {
      id: 'SNG-00', name: 'SINGULARITY CORE',
      desc: 'Self-sustaining plasma mind. Every other component exists to keep it contained — and listening.',
      stats: [['OUTPUT', 0.92], ['COHERENCE', 0.87], ['TEMP', 0.74]],
    },
    spin: (t) => { coreMesh.rotation.y = t * 0.15; coreMesh.rotation.x = t * 0.07; },
  });
  addLabel(coreGroup, [0.7, 0.75, 0.5], 'SINGULARITY CORE', 'SNG-00 · 4.2 ZW');

  /* 2 — containment lattice */
  const latticeGroup = new THREE.Group();
  const latGeo = new THREE.IcosahedronGeometry(1.75, 1);
  latticeGroup.add(new THREE.LineSegments(new THREE.EdgesGeometry(latGeo, 1), lineMat(0.35)));
  const latPts = new THREE.Points(
    new THREE.IcosahedronGeometry(1.75, 1),
    new THREE.PointsMaterial({
      color: 0xffffff, size: 0.09, transparent: true, opacity: 0.95,
      blending: THREE.AdditiveBlending, depthWrite: false,
    }),
  );
  tintB.push(latPts.material);
  latticeGroup.add(latPts);
  const latPick = new THREE.Mesh(latGeo, new THREE.MeshBasicMaterial({ visible: false }));
  latPick.userData.pick = true;
  latticeGroup.add(latPick);
  addPart(latticeGroup, {
    delay: 0.05, scaleTo: 1.9,
    info: {
      id: 'LAT-01', name: 'CONTAINMENT LATTICE',
      desc: 'Eighty phase-locked field nodes. Holds the core in a geodesic cage of standing waves.',
      stats: [['FIELD', 0.96], ['SYNC', 0.99], ['STRAIN', 0.31]],
    },
    spin: (t) => { latticeGroup.rotation.y = -t * 0.22; latticeGroup.rotation.z = t * 0.11; },
  });
  addLabel(latticeGroup, [0, 1.75, 0], 'CONTAINMENT LATTICE', 'LAT-01 · 80 NODES');

  /* 3 — armor shells: eight octant plates */
  const R = 2.45;
  for (let k = 0; k < 8; k++) {
    const qi = k % 4;
    const up = k < 4;
    const gap = 0.045;
    const phi0 = qi * Math.PI / 2 + gap;
    const phiL = Math.PI / 2 - gap * 2;
    const th0 = up ? 0.42 : Math.PI / 2 + gap;
    const thL = Math.PI / 2 - gap - 0.42;
    const g = new THREE.Group();
    const geo = new THREE.SphereGeometry(R, 22, 14, phi0, phiL, th0, thL);
    g.add(new THREE.Mesh(geo, holoMaterial({ grid: [7, 5], fill: 0.012, gain: 0.5 })));
    g.add(new THREE.LineSegments(new THREE.EdgesGeometry(geo, 60), lineMat(0.6)));
    const inner = new THREE.SphereGeometry(R - 0.16, 16, 10, phi0 + 0.05, phiL - 0.1, th0 + 0.05, thL - 0.1);
    g.add(new THREE.Mesh(inner, holoMaterial({ grid: [21, 15], fill: 0.0, gain: 0.28 })));
    const pm = phi0 + phiL / 2;
    const tm = th0 + thL / 2;
    const dir = [-Math.cos(pm) * Math.sin(tm), Math.cos(tm), Math.sin(pm) * Math.sin(tm)];
    addPart(g, {
      dir: dir.map((v) => v * 3.6), delay: 0.12 + (k % 4) * 0.03,
      info: {
        id: `SHL-0${k + 1}`, name: 'ARMOR SHELL',
        desc: 'Ablative hard-light plating. Eight octants interlock to form the pressure hull.',
        stats: [['INTEGRITY', 0.9 + (k % 3) * 0.03], ['DENSITY', 0.78], ['HEAT', 0.42 + k * 0.03]],
      },
    });
    if (k === 0) addLabel(g, dir.map((v) => v * R), 'ARMOR SHELL ×8', 'SHL-01 · HARD-LIGHT');
  }

  /* 4 — field coils: three tumbling gimbals */
  const coilDefs = [
    { r: 3.05, a: 0.31, b: 0.19, p: 0.0, scaleTo: 1.5 },
    { r: 3.3, a: -0.23, b: 0.27, p: 1.3, scaleTo: 1.75 },
    { r: 3.55, a: 0.17, b: -0.21, p: 2.4, scaleTo: 2.0 },
  ];
  coilDefs.forEach((c, i) => {
    const g = new THREE.Group();
    g.add(new THREE.Mesh(new THREE.TorusGeometry(c.r, 0.045, 6, 160), holoMaterial({ grid: [90, 3], fill: 0.16, gain: 0.7 })));
    const pick = new THREE.Mesh(new THREE.TorusGeometry(c.r, 0.3, 5, 48), new THREE.MeshBasicMaterial({ visible: false }));
    pick.userData.pick = true;
    g.add(pick);
    const nodeGeo = new THREE.BoxGeometry(0.2, 0.2, 0.26);
    const nodeMat = solidMat(0.9, tintB);
    for (let n = 0; n < 6; n++) {
      const a = (n / 6) * Math.PI * 2;
      const node = new THREE.Mesh(nodeGeo, nodeMat);
      node.position.set(Math.cos(a) * c.r, Math.sin(a) * c.r, 0);
      node.rotation.z = a;
      g.add(node);
    }
    addPart(g, {
      delay: 0.02 + i * 0.06, scaleTo: c.scaleTo,
      info: {
        id: `COIL-0${i + 1}`, name: 'FIELD COIL',
        desc: 'Superconducting gimbal ring. Three coils precess to shape the magnetic bottle.',
        stats: [['CURRENT', 0.81 + i * 0.05], ['PHASE', 0.97], ['DRIFT', 0.12 + i * 0.07]],
      },
      spin: (t) => { g.rotation.x = t * c.a + c.p; g.rotation.y = t * c.b + c.p * 2; },
    });
    if (i === 2) addLabel(g, [c.r, 0, 0], 'FIELD COIL ×3', 'COIL-03 · 11.7 T');
  });

  /* 5 — plasma injectors around the equator */
  const up = new THREE.Vector3(0, 1, 0);
  for (let k = 0; k < 8; k++) {
    const a = (k / 8) * Math.PI * 2 + Math.PI / 8;
    const radial = new THREE.Vector3(Math.cos(a), 0, Math.sin(a));
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.26, 1.3, 6, 3, true), holoMaterial({ grid: [6, 6], fill: 0.08 }));
    body.position.y = 0.75;
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.2, 0.7, 6, 2, true), holoMaterial({ grid: [6, 3], fill: 0.12 }));
    tip.rotation.x = Math.PI;
    tip.position.y = -0.25;
    const collar = new THREE.Mesh(new THREE.TorusGeometry(0.36, 0.025, 6, 24), solidMat(0.9, tintB));
    collar.rotation.x = Math.PI / 2;
    collar.position.y = 0.2;
    const tail = new THREE.Mesh(new THREE.RingGeometry(0.3, 0.5, 6, 1), holoMaterial({ grid: [6, 1], fill: 0.2 }));
    tail.rotation.x = Math.PI / 2;
    tail.position.y = 1.5;
    g.add(body, tip, collar, tail);
    g.add(new THREE.LineSegments(new THREE.EdgesGeometry(body.geometry, 10), lineMat(0.5)).translateY(0.75));
    g.position.copy(radial).multiplyScalar(4.7);
    g.quaternion.setFromUnitVectors(up, radial);
    addPart(g, {
      dir: radial.clone().multiplyScalar(4.2).toArray(), delay: 0.2 + (k % 2) * 0.08,
      info: {
        id: `INJ-0${k + 1}`, name: 'PLASMA INJECTOR',
        desc: 'Feeds ionised deuterium into the core in femtosecond pulses.',
        stats: [['FLOW', 0.66 + (k % 4) * 0.06], ['PRESSURE', 0.83], ['WEAR', 0.18 + k * 0.02]],
      },
    });
    if (k === 0) addLabel(g, [0, 0.9, 0], 'PLASMA INJECTOR ×8', 'INJ-01 · D-T FEED');
  }

  /* 6 — axial stack: lens, phase disc, emitter (mirrored top & bottom) */
  for (const s of [1, -1]) {
    const tag = s > 0 ? 'N' : 'S';

    const lens = new THREE.Group();
    const lensMesh = new THREE.Mesh(new THREE.RingGeometry(0.55, 1.55, 64, 3), holoMaterial({ grid: [48, 3], fill: 0.1 }));
    lensMesh.rotation.x = -Math.PI / 2;
    lens.add(lensMesh);
    lens.position.y = s * 2.95;
    addPart(lens, {
      dir: [0, s * 1.9, 0], delay: 0.0,
      info: {
        id: `LNS-${tag}`, name: 'FOCUS LENS',
        desc: 'Gravitational lens. Collimates the axial beam before it leaves the hull.',
        stats: [['APERTURE', 0.71], ['CLARITY', 0.98], ['SPIN', 0.55]],
      },
      spin: (t) => { lens.rotation.y = t * 0.6 * s; },
    });
    if (s > 0) addLabel(lens, [1.5, 0, 0], 'FOCUS LENS', 'LNS-N · f/0.7');

    const disc = new THREE.Group();
    for (let i = 0; i < 3; i++) {
      const arc = new THREE.Mesh(
        new THREE.RingGeometry(1.95, 2.55, 32, 2, (i * Math.PI * 2) / 3, (Math.PI * 2) / 3 - 0.3),
        holoMaterial({ grid: [16, 2], fill: 0.09 }),
      );
      arc.rotation.x = -Math.PI / 2;
      disc.add(arc);
    }
    disc.position.y = s * 3.45;
    addPart(disc, {
      dir: [0, s * 3.9, 0], delay: 0.1,
      info: {
        id: `PHS-${tag}`, name: 'PHASE DISC',
        desc: 'Tri-segment resonator. Counter-rotates against the lens to cancel torque.',
        stats: [['RESONANCE', 0.88], ['BALANCE', 0.93], ['SPIN', 0.61]],
      },
      spin: (t) => { disc.rotation.y = -t * 0.35 * s; },
    });
    if (s > 0) addLabel(disc, [-2.5, 0, 0.4], 'PHASE DISC', 'PHS-N · 3 SEG');

    const em = new THREE.Group();
    const emGeo = new THREE.CylinderGeometry(0.22, 1.05, 0.95, 6, 2, true);
    const emMesh = new THREE.Mesh(emGeo, holoMaterial({ grid: [6, 4], fill: 0.1 }));
    em.add(emMesh, new THREE.LineSegments(new THREE.EdgesGeometry(emGeo, 10), lineMat(0.9)));
    const cap = new THREE.Mesh(new THREE.RingGeometry(0.05, 0.22, 6, 1), solidMat(1, tintB));
    cap.rotation.x = -Math.PI / 2;
    cap.position.y = 0.48;
    em.add(cap);
    if (s < 0) em.rotation.x = Math.PI;
    em.position.y = s * 4.35;
    addPart(em, {
      dir: [0, s * 6.0, 0], delay: 0.18,
      info: {
        id: `EMT-${tag}`, name: s > 0 ? 'ZENITH EMITTER' : 'GROUND ANCHOR',
        desc: s > 0
          ? 'Uplink spire. Throws the collimated beam to orbit.'
          : 'Sinks excess charge into the deck grid and pins the assembly in place.',
        stats: [['LOAD', 0.58], ['ALIGN', 0.99], ['HEAT', 0.36]],
      },
    });
    addLabel(em, [0.6, 0, 0.6], s > 0 ? 'ZENITH EMITTER' : 'GROUND ANCHOR', `EMT-${tag} · ${s > 0 ? 'UPLINK' : 'SINK'}`);
  }

  /* 7 — telemetry dials */
  const dialA = new THREE.Group();
  const dialAMesh = new THREE.Mesh(new THREE.RingGeometry(5.75, 5.95, 180, 1), holoMaterial({ grid: [180, 1], fill: 0.12 }));
  dialAMesh.rotation.x = -Math.PI / 2;
  dialA.add(dialAMesh);
  addPart(dialA, {
    delay: 0.3, scaleTo: 1.95, pick: false,
    spin: (t) => { dialA.rotation.y = t * 0.08; },
  });
  addLabel(dialA, [5.85, 0, 0], 'TELEMETRY RING', 'TLM-01 · 360 CH');

  const dialB = new THREE.Group();
  for (let i = 0; i < 4; i++) {
    const arc = new THREE.Mesh(
      new THREE.RingGeometry(6.3, 6.38 + (i % 2) * 0.12, 48, 1, (i * Math.PI) / 2, Math.PI / 2 - 0.5),
      solidMat(0.5, i % 2 ? tintB : tintA),
    );
    arc.rotation.x = -Math.PI / 2;
    dialB.add(arc);
  }
  addPart(dialB, {
    delay: 0.35, scaleTo: 2.0, pick: false,
    spin: (t) => { dialB.rotation.y = -t * 0.14; },
  });

  /* 8 — axial beam */
  const beamMat = solidMat(0.6, tintB);
  const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 1, 8, 1, true), beamMat);
  const beamGlowMat = solidMat(0.1, tintA);
  const beamGlow = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.28, 1, 12, 1, true), beamGlowMat);
  root.add(beam, beamGlow);

  /* ---------- runtime ---------- */

  let flash = 0;
  let selected = null;

  function update(dt, rawDt, t, explode, turb) {
    for (const m of tintA) m.color.copy(U.colorA.value);
    for (const m of tintB) m.color.copy(U.colorB.value);

    root.rotation.y += dt * 0.1 * (1 - 0.75 * explode);

    for (const p of parts) {
      const k = ease(clamp((explode - p.delay) / (1 - p.delay)));
      p.obj.position.copy(p.home).addScaledVector(p.dir, k);
      if (p.scaleTo !== 1) p.obj.scale.setScalar(lerp(p.scaleFrom, p.scaleFrom * p.scaleTo, k));
      const f = Math.min(1, rawDt * 10);
      p.hover += (p.hoverTarget - p.hover) * f;
      const dimT = selected && selected !== p ? 0.16 : 1;
      p.dim += (dimT - p.dim) * Math.min(1, rawDt * 6);
      for (const m of p.mats) {
        m.uniforms.uHover.value = p.hover + (selected === p ? 0.35 + 0.25 * Math.sin(t * 6) : 0);
        m.uniforms.uDim.value = p.dim;
      }
      if (p.spin) p.spin(t);
    }

    flash = Math.max(0, flash - rawDt * 1.8);
    coreMat.uniforms.uFlash.value = flash;
    coreMat.uniforms.uTurb.value += (turb - coreMat.uniforms.uTurb.value) * Math.min(1, rawDt * 3);
    const pulse = 1 + 0.04 * Math.sin(t * 2.2) + flash * 0.25;
    coreMesh.scale.setScalar(pulse);
    glow.scale.setScalar(9 * (1 + flash * 0.8 + 0.05 * Math.sin(t * 1.7)));
    glowMat.opacity = 0.07 + flash * 0.3;

    const len = 10.5 + ease(explode) * 12.5;
    beam.scale.y = len;
    beamGlow.scale.y = len;
    beamMat.opacity = 0.5 + 0.15 * Math.sin(t * 9);
    beamGlowMat.opacity = 0.035 + 0.02 * Math.sin(t * 3.1) + flash * 0.2;
  }

  return {
    root, parts, pickables, labels, update,
    flash: (v = 1) => { flash = v; },
    select: (p) => { selected = p; },
    get selected() { return selected; },
  };
}
