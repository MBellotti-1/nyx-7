import * as THREE from 'three';
import { U } from './shared.js';
import { feeds, quakeStats } from './data.js';

/* ================= digital rain ================= */

function glyphAtlas() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d');
  g.fillStyle = '#000';
  g.fillRect(0, 0, 512, 512);
  g.fillStyle = '#fff';
  g.font = '700 44px "Share Tech Mono", "Hiragino Kaku Gothic ProN", "Osaka", monospace';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const chars = 'ｦｱｳｴｵｶｷｹｺｻｼｽｾｿﾀﾂﾃﾅﾆﾇﾈﾊﾋﾎﾏﾐﾑﾒﾓﾔﾕﾗﾘﾜ0123456789Z:=*+-<>|¦╌ΣΔΩΨλπ∴∞≠';
  for (let i = 0; i < 64; i++) {
    const ch = chars[i % chars.length];
    g.fillText(ch, (i % 8) * 64 + 32, Math.floor(i / 8) * 64 + 34);
  }
  const t = new THREE.CanvasTexture(c);
  t.generateMipmaps = true;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  return t;
}

const RAIN_FRAG = /* glsl */ `
uniform sampler2D uAtlas; uniform float uTime; uniform float uIntensity;
uniform vec3 uColor; uniform vec2 uCells;
varying vec2 vUv;
float hash(vec2 p){ return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
void main(){
  vec2 uv = vUv * uCells;
  vec2 cell = floor(uv); vec2 f = fract(uv);
  float cr = hash(vec2(cell.x, 7.));
  float speed = 4. + cr * 11.;
  float len = 8. + hash(vec2(cell.x, 3.)) * 26.;
  float cyc = uCells.y + len + hash(vec2(cell.x, 23.)) * 30.;
  float head = mod(uTime * speed + hash(vec2(cell.x, 13.)) * cyc, cyc);
  float d = head - (uCells.y - 1. - cell.y);
  float trail = (d >= 0. && d < len) ? 1. - d / len : 0.;
  float isHead = (d >= 0. && d < 1.) ? 1. : 0.;
  float rate = 1. + hash(cell) * 4.;
  float gi = floor(hash(cell + vec2(floor(uTime * rate))) * 64.);
  vec2 gc = vec2(mod(gi, 8.), floor(gi / 8.));
  vec2 guv = (gc + f) / 8.;
  float g = textureGrad(uAtlas, guv, dFdx(uv) / 8., dFdy(uv) / 8.).r;
  float fadeY = smoothstep(0., .18, vUv.y) * smoothstep(1., .72, vUv.y);
  vec3 col = uColor * trail * trail * 1.1 + vec3(.85, 1., .92) * isHead * 1.4;
  // occasional column flare
  col *= 1. + step(.96, hash(vec2(cell.x, floor(uTime * .5)))) * 1.5;
  gl_FragColor = vec4(col * g * uIntensity * fadeY, 1.);
}`;

export function createRain() {
  const uniforms = {
    uAtlas: { value: glyphAtlas() }, uTime: U.time, uColor: U.colorRain,
    uIntensity: { value: 0 }, uCells: { value: new THREE.Vector2(250, 64) },
  };
  const mesh = new THREE.Mesh(
    new THREE.CylinderGeometry(72, 72, 130, 96, 1, true),
    new THREE.ShaderMaterial({
      uniforms,
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
      fragmentShader: RAIN_FRAG,
      side: THREE.BackSide, transparent: true, depthWrite: false,
      blending: THREE.AdditiveBlending,
    }),
  );
  mesh.position.y = 8;
  // redraw atlas once webfonts are in
  if (document.fonts && document.fonts.ready) {
    document.fonts.ready.then(() => { uniforms.uAtlas.value.dispose(); uniforms.uAtlas.value = glyphAtlas(); });
  }
  return { mesh, uniforms };
}

/* ================= deck grid ================= */

const GRID_FRAG = /* glsl */ `
uniform float uTime; uniform vec3 uColorA; uniform vec3 uColorB;
uniform float uBurstR; uniform float uBurstAmp;
varying vec3 vW;
void main(){
  vec2 p = vW.xz;
  float d = length(p);
  vec2 gp = p / 4.;
  vec2 g = abs(fract(gp - .5) - .5) / (fwidth(gp) + 1e-5);
  float line = 1. - min(min(g.x, g.y), 1.);
  vec2 gp2 = p / 20.;
  vec2 g2 = abs(fract(gp2 - .5) - .5) / (fwidth(gp2) + 1e-5);
  float major = 1. - min(min(g2.x, g2.y), 1.);
  float rc = d / 7. - uTime * .12;
  float ring = 1. - min(abs(fract(rc) - .5) / (fwidth(rc) + 1e-5), 1.);
  float ang = atan(p.y, p.x) * 3.8197; // 24 spokes
  float spoke = (1. - min(abs(fract(ang) - .5) / (fwidth(ang) + 1e-5), 1.)) * smoothstep(8., 14., d) * smoothstep(46., 22., d);
  float pulse = exp(-pow(d - uBurstR * 1.6, 2.) * .03) * uBurstAmp;
  float fade = exp(-d * .02);
  vec3 col = uColorA * (line * .14 + major * .28 + ring * .26 * smoothstep(70., 6., d) + spoke * .12) * fade;
  col += uColorB * pulse * (.5 + line * 2.);
  col += uColorA * exp(-d * d * .012) * .06;
  gl_FragColor = vec4(col, 1.);
}`;

export function createDeck() {
  const mesh = new THREE.Mesh(
    new THREE.PlaneGeometry(500, 500),
    new THREE.ShaderMaterial({
      uniforms: { uTime: U.time, uColorA: U.colorA, uColorB: U.colorB, uBurstR: U.burstR, uBurstAmp: U.burstAmp },
      vertexShader: 'varying vec3 vW; void main(){ vec4 wp = modelMatrix * vec4(position, 1.); vW = wp.xyz; gl_Position = projectionMatrix * viewMatrix * wp; }',
      fragmentShader: GRID_FRAG,
      transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
    }),
  );
  mesh.rotation.x = -Math.PI / 2;
  mesh.position.y = -12.5;
  return mesh;
}

/* ================= floating data panels ================= */

const W = 512;
const H = 320;
const P = '#ff0000'; // -> colorA
const S = '#00ff00'; // -> colorB
const X = '#0000ff'; // -> white
const pa = (a) => `rgba(255,0,0,${a})`;
const sa = (a) => `rgba(0,255,0,${a})`;
const h1 = (n) => { const s = Math.sin(n * 127.1) * 43758.5453; return s - Math.floor(s); };

function chrome(g, title, tag) {
  g.globalCompositeOperation = 'source-over';
  g.fillStyle = '#000';
  g.fillRect(0, 0, W, H);
  g.globalCompositeOperation = 'lighter';
  g.font = '20px "Share Tech Mono", monospace';
  g.textBaseline = 'alphabetic';
  g.textAlign = 'left';
  g.fillStyle = P;
  g.fillText(title, 18, 30);
  g.textAlign = 'right';
  g.fillStyle = S;
  g.fillText(tag, W - 18, 30);
  g.textAlign = 'left';
  g.fillStyle = pa(0.5);
  g.fillRect(18, 40, W - 36, 1);
  g.fillStyle = X;
  g.fillRect(18, 39, 46, 3);
}

const DRAW = [
  function scope(g, t) {
    chrome(g, 'SIGNAL // Ψ-BAND', 'LIVE');
    g.strokeStyle = pa(0.18);
    g.lineWidth = 1;
    g.beginPath();
    for (let x = 18; x <= W - 18; x += 34) { g.moveTo(x, 56); g.lineTo(x, H - 20); }
    for (let y = 56; y <= H - 20; y += 34) { g.moveTo(18, y); g.lineTo(W - 18, y); }
    g.stroke();
    const mid = 178;
    const wave = (x, k) => Math.sin(x * 0.03 * k + t * 3 * k) * 46 * Math.sin(x * 0.008 + t * 0.7) + Math.sin(x * 0.11 + t * 9) * 8 * k;
    g.lineWidth = 2.5;
    g.strokeStyle = P;
    g.beginPath();
    for (let x = 18; x <= W - 18; x += 3) g.lineTo(x, mid + wave(x, 1));
    g.stroke();
    g.strokeStyle = sa(0.9);
    g.lineWidth = 1.5;
    g.beginPath();
    for (let x = 18; x <= W - 18; x += 3) g.lineTo(x, mid + wave(x + 80, 1.7) * 0.6);
    g.stroke();
    g.fillStyle = X;
    g.fillRect(W - 24, mid + wave(W - 18, 1) - 4, 8, 8);
  },
  function radar(g, t) {
    chrome(g, 'PROXIMITY SWEEP', 'R 40K');
    const cx = 150, cy = 182, R = 112;
    g.strokeStyle = pa(0.45);
    g.lineWidth = 1.2;
    for (let r = R; r > 10; r -= 28) { g.beginPath(); g.arc(cx, cy, r, 0, 6.2832); g.stroke(); }
    g.beginPath(); g.moveTo(cx - R, cy); g.lineTo(cx + R, cy); g.moveTo(cx, cy - R); g.lineTo(cx, cy + R); g.stroke();
    const a = t * 1.6;
    for (let i = 0; i < 26; i++) {
      g.strokeStyle = pa(0.75 * (1 - i / 26));
      g.lineWidth = 3;
      g.beginPath(); g.moveTo(cx, cy);
      g.lineTo(cx + Math.cos(a - i * 0.035) * R, cy + Math.sin(a - i * 0.035) * R);
      g.stroke();
    }
    for (let i = 0; i < 7; i++) {
      const ba = h1(i + 1) * 6.2832, br = 25 + h1(i + 9) * 80;
      let dl = (a - ba) % 6.2832; if (dl < 0) dl += 6.2832;
      const k = Math.max(0, 1 - dl / 4);
      g.fillStyle = `rgba(0,255,255,${k})`;
      g.fillRect(cx + Math.cos(ba) * br - 4, cy + Math.sin(ba) * br - 4, 8, 8);
    }
    g.font = '17px "Share Tech Mono", monospace';
    for (let i = 0; i < 7; i++) {
      g.fillStyle = i === ((t * 1.3) | 0) % 7 ? X : pa(0.8);
      g.fillText(`TRK-${(i + 11).toString(16).toUpperCase()}  ${(h1(i + (t | 0)) * 40).toFixed(2)}K`, 296, 78 + i * 30);
    }
  },
  function hexdump(g, t) {
    chrome(g, 'MEMORY LATTICE', '0x7F3A');
    g.font = '18px "Share Tech Mono", monospace';
    const scroll = Math.floor(t * 3);
    for (let r = 0; r < 10; r++) {
      const row = r + scroll;
      g.fillStyle = sa(0.9);
      g.fillText((0x7f3a00 + row * 16).toString(16).toUpperCase(), 18, 70 + r * 25);
      for (let c = 0; c < 12; c++) {
        const v = Math.floor(h1(row * 16 + c + 0.5) * 256);
        const hot = h1(row * 31 + c * 7 + Math.floor(t * 2)) > 0.93;
        g.fillStyle = hot ? X : pa(0.35 + (v / 255) * 0.6);
        g.fillText(v.toString(16).toUpperCase().padStart(2, '0'), 122 + c * 31, 70 + r * 25);
      }
    }
  },
  function spectrum(g, t) {
    chrome(g, 'HARMONIC SPECTRUM', '36 CH');
    const n = 36, bw = (W - 36) / n;
    for (let i = 0; i < n; i++) {
      const v = Math.abs(Math.sin(i * 0.4 + t * 2.2) * Math.sin(i * 0.13 - t * 1.1)) * 0.75 + h1(i + Math.floor(t * 12)) * 0.25;
      const hh = v * 200;
      const segs = Math.floor(hh / 10);
      for (let s = 0; s < segs; s++) {
        g.fillStyle = s > 15 ? S : pa(0.45 + (s / 20) * 0.55);
        g.fillRect(18 + i * bw, H - 22 - s * 10, bw - 3, 7);
      }
      g.fillStyle = X;
      g.fillRect(18 + i * bw, H - 30 - segs * 10, bw - 3, 2);
    }
  },
  function neural(g, t) {
    chrome(g, 'NEURAL BRIDGE', 'SYNC 99.2');
    const layers = [4, 6, 6, 3];
    const pos = [];
    layers.forEach((n, li) => {
      pos.push([]);
      for (let i = 0; i < n; i++) pos[li].push([60 + li * 130, 70 + ((i + 0.5) * 230) / n]);
    });
    let e = 0;
    for (let li = 0; li < 3; li++) {
      for (const a of pos[li]) for (const b of pos[li + 1]) {
        e++;
        g.strokeStyle = pa(0.16);
        g.lineWidth = 1;
        g.beginPath(); g.moveTo(a[0], a[1]); g.lineTo(b[0], b[1]); g.stroke();
        if (h1(e) > 0.72) {
          const k = (t * (0.4 + h1(e + 3)) + h1(e + 5)) % 1;
          g.fillStyle = X;
          g.fillRect(a[0] + (b[0] - a[0]) * k - 3, a[1] + (b[1] - a[1]) * k - 3, 6, 6);
        }
      }
    }
    pos.flat().forEach((p, i) => {
      const k = 0.5 + 0.5 * Math.sin(t * 3 + i * 1.7);
      g.strokeStyle = P; g.lineWidth = 2;
      g.beginPath(); g.arc(p[0], p[1], 9, 0, 6.2832); g.stroke();
      g.fillStyle = sa(k);
      g.beginPath(); g.arc(p[0], p[1], 5, 0, 6.2832); g.fill();
    });
  },
  function orbits(g, t) {
    chrome(g, 'ORBITAL ASSETS', '6 / 6');
    const cx = 256, cy = 184;
    for (let i = 0; i < 5; i++) {
      const rx = 50 + i * 42, ry = 18 + i * 22;
      g.strokeStyle = pa(0.4);
      g.lineWidth = 1.2;
      g.beginPath(); g.ellipse(cx, cy, rx, ry, -0.3, 0, 6.2832); g.stroke();
      const a = t * (0.9 - i * 0.14) + i * 2;
      const x = Math.cos(a) * rx, y = Math.sin(a) * ry;
      const px = cx + x * Math.cos(-0.3) - y * Math.sin(-0.3);
      const py = cy + x * Math.sin(-0.3) + y * Math.cos(-0.3);
      g.fillStyle = i % 2 ? S : X;
      g.fillRect(px - 5, py - 5, 10, 10);
      g.strokeStyle = sa(0.6);
      g.strokeRect(px - 10, py - 10, 20, 20);
    }
    g.fillStyle = P;
    g.beginPath(); g.arc(cx, cy, 12, 0, 6.2832); g.fill();
  },
];

// Three of the displays switch to measured data as soon as its feed lands.
const cap = (g, text) => {
  g.font = '14px "Share Tech Mono", monospace';
  g.fillStyle = pa(0.75);
  g.textAlign = 'left';
  g.fillText(text, 18, H - 8);
};
const REAL = {
  0(g, t) { // NOAA planetary K index, 3-hour values over the past week
    const d = feeds.kp.data;
    if (!d || !d.length) return false;
    const rows = d.slice(-56);
    const last = rows[rows.length - 1];
    chrome(g, 'GEOMAGNETIC Kp · 7D', `Kp ${last.kp.toFixed(1)}`);
    const bw = (W - 36) / rows.length;
    const y5 = H - 30 - (5 / 9) * 215;
    g.fillStyle = sa(0.55);
    for (let x = 18; x < W - 18; x += 12) g.fillRect(x, y5, 6, 1);
    g.font = '13px "Share Tech Mono", monospace';
    g.fillText('STORM THRESHOLD', 22, y5 - 6);
    rows.forEach((r, i) => {
      const segs = Math.max(1, Math.round(((r.kp / 9) * 215) / 9));
      for (let s = 0; s < segs; s++) {
        g.fillStyle = r.kp >= 5 ? X : r.kp >= 4 ? S : pa(0.4 + (s / 14) * 0.6);
        g.fillRect(18 + i * bw, H - 30 - s * 9 - 6, bw - 2, 6);
      }
    });
    const cx = 18 + ((t * 0.12) % 1) * (W - 36);
    g.fillStyle = pa(0.4);
    g.fillRect(cx, 52, 1, H - 84);
    cap(g, 'NOAA SWPC · PLANETARY K INDEX');
    return true;
  },
  3(g, t) { // USGS: quakes per six hours over the past week
    const list = feeds.quakes.data;
    const st = quakeStats();
    if (!list || !st) return false;
    chrome(g, 'SEISMIC · 7D', `${st.n} EVT`);
    const bins = 28;
    const now = Date.now();
    const count = new Array(bins).fill(0);
    const peak = new Array(bins).fill(0);
    for (const q of list) {
      const b = Math.floor(((q.time - (now - 7 * 86400e3)) / (7 * 86400e3)) * bins);
      if (b < 0 || b >= bins) continue;
      count[b]++;
      peak[b] = Math.max(peak[b], q.mag);
    }
    const max = Math.max(...count, 1);
    const bw = (W - 36) / bins;
    const cursor = Math.floor(((t * 0.2) % 1) * bins);
    count.forEach((c, i) => {
      const segs = Math.round((c / max) * 20);
      for (let s = 0; s < segs; s++) {
        g.fillStyle = i === cursor ? X : peak[i] >= 5.5 ? S : pa(0.4 + (s / 20) * 0.6);
        g.fillRect(18 + i * bw, H - 32 - s * 10, bw - 3, 7);
      }
      if (peak[i] >= 5.5) {
        g.fillStyle = X;
        g.font = '13px "Share Tech Mono", monospace';
        g.textAlign = 'center';
        g.fillText(peak[i].toFixed(1), 18 + i * bw + bw / 2 - 1, H - 36 - segs * 10);
      }
    });
    cap(g, `USGS · M2.5+ · WEEK MAX M${st.max.mag.toFixed(1)}`);
    return true;
  },
  5(g) { // CelesTrak: what is actually up there, by orbit
    const c = feeds.sats.census;
    if (!c || !c.total) return false;
    chrome(g, 'ORBITAL CENSUS', c.total.toLocaleString('en-US'));
    const rows = [['MEGACONSTELLATIONS', c.mega], ['OTHER LOW ORBIT', c.leo], ['MEDIUM ORBIT', c.meo], ['GEOSTATIONARY', c.geo], ['ELLIPTICAL', c.heo]];
    const max = Math.sqrt(Math.max(...rows.map((r) => r[1]), 1));
    g.font = '15px "Share Tech Mono", monospace';
    rows.forEach(([name, n], i) => {
      const y = 62 + i * 45;
      g.textAlign = 'left';
      g.fillStyle = pa(0.85);
      g.fillText(name, 18, y + 4);
      g.textAlign = 'right';
      g.fillStyle = X;
      g.fillText(n.toLocaleString('en-US'), W - 18, y + 4);
      g.fillStyle = pa(0.2);
      g.fillRect(18, y + 12, W - 36, 9);
      g.fillStyle = i === 0 ? S : P;
      g.fillRect(18, y + 12, (W - 36) * (Math.sqrt(n) / max), 9);
    });
    cap(g, `CELESTRAK · STARLINK ALONE: ${c.starlink.toLocaleString('en-US')}`);
    return true;
  },
};

const PANEL_FRAG = /* glsl */ `
uniform sampler2D uMap; uniform float uTime; uniform float uHover; uniform float uDim; uniform float uSeed;
uniform vec3 uColorA; uniform vec3 uColorB;
varying vec2 vUv;
void main(){
  vec2 uv = vUv;
  if (!gl_FrontFacing) uv.x = 1. - uv.x;
  vec3 t = texture2D(uMap, uv).rgb;
  vec3 col = uColorA * t.r + uColorB * t.g + vec3(1.) * t.b;
  float scan = .82 + .18 * sin(uv.y * 500. + uTime * 8.);
  float flick = .9 + .1 * sin(uTime * 13. + uSeed * 40.) * sin(uTime * 7.3 + uSeed);
  vec2 e = min(uv, 1. - uv);
  float border = 1. - smoothstep(0., .012, min(e.x * .62, e.y));
  float corner = step(e.x, .06) * step(e.y, .1) * border;
  col += uColorA * (border * .45 + .03) + vec3(1.) * corner * .8;
  float face = gl_FrontFacing ? .4 : 1.;
  gl_FragColor = vec4(col * scan * flick * face * uDim * (1. + uHover * .9), 1.);
}`;

const PANEL_INFO = [
  ['AUX-01', 'SPACE WEATHER', 'NOAA planetary K index for the past week. Five and above means a geomagnetic storm — and aurora.'],
  ['AUX-02', 'PROXIMITY SWEEP', 'Tracks every object within forty kilometres.'],
  ['AUX-03', 'MEMORY LATTICE', 'Live view of the working set. It never stops rewriting itself.'],
  ['AUX-04', 'SEISMIC MONITOR', 'Every M2.5+ earthquake USGS located this week, in six-hour bins.'],
  ['AUX-05', 'NEURAL BRIDGE', 'The link between the planet and the operator. That would be you.'],
  ['AUX-06', 'ORBITAL CENSUS', 'Active payloads in the CelesTrak catalog, sorted by orbit. Most of them are one constellation.'],
];

export function createPanels() {
  const group = new THREE.Group();
  const panels = [];
  const pickables = [];
  const RADIUS = 13.5;
  const ARC = 0.4;
  DRAW.forEach((draw, i) => {
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d');
    const tex = new THREE.CanvasTexture(canvas);
    tex.anisotropy = 4;
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: tex }, uTime: U.time, uColorA: U.colorA, uColorB: U.colorB,
        uHover: { value: 0 }, uDim: { value: 1 }, uSeed: { value: i * 1.37 },
      },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }',
      fragmentShader: PANEL_FRAG,
      transparent: true, depthWrite: false, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    });
    const theta = (i / DRAW.length) * Math.PI * 2 + 0.5;
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(RADIUS, RADIUS, 3.35, 24, 1, true, theta - ARC / 2, ARC), mat);
    const baseY = i % 2 ? 3.4 : -2.6;
    mesh.position.y = baseY;
    const [id, name, desc] = PANEL_INFO[i];
    const part = {
      obj: mesh, hover: 0, hoverTarget: 0, dim: 1, mats: [mat], isPanel: true,
      info: { id, name, desc, stats: [['UPLINK', 0.8 + h1(i) * 0.19, `${(80 + h1(i) * 19).toFixed(0)}%`], ['REFRESH', 0.6 + h1(i + 4) * 0.3, `${(6 + h1(i + 4) * 4).toFixed(0)} HZ`]] },
    };
    mesh.userData.part = part;
    pickables.push(mesh);
    panels.push({ mesh, ctx, tex, draw, part, baseY, phase: i * 1.9 });
    group.add(mesh);
    draw(ctx, 0);
  });

  let cursor = 0;
  return {
    group, pickables, parts: panels.map((p) => p.part),
    // `away` (0..1) swings the ring out past the camera so the planet gets a clear view
    update(dt, rawDt, t, explode, selected, away = 0) {
      group.rotation.y -= dt * 0.045;
      const s = 1 + explode * 0.42 + away * 1.15;
      for (const p of panels) {
        p.part.hover += (p.part.hoverTarget - p.part.hover) * Math.min(1, rawDt * 10);
        const dimT = selected && selected !== p.part ? 0.3 : 1;
        p.part.dim += (dimT - p.part.dim) * Math.min(1, rawDt * 6);
        p.mesh.material.uniforms.uHover.value = p.part.hover;
        p.mesh.material.uniforms.uDim.value = p.part.dim;
        const k = s * (1 - p.part.hover * 0.05);
        p.mesh.scale.set(k, 1 + p.part.hover * 0.06 + away * 0.9, k);
        p.mesh.position.y = p.baseY * (1 + explode * 0.5 + away * 1.6) + Math.sin(t * 0.7 + p.phase) * 0.25;
      }
      // refresh one canvas per frame, round-robin
      const i = cursor++ % panels.length;
      const p = panels[i];
      if (!(REAL[i] && REAL[i](p.ctx, t))) p.draw(p.ctx, t);
      p.tex.needsUpdate = true;
    },
  };
}
