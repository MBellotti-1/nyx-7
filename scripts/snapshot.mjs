// Pulls a snapshot of every live feed into public/data so the app has real data
// on first paint, offline, or when a provider rate-limits the visitor.
//   npm run snapshot
// CelesTrak allows one download per group every two hours per IP — don't loop this.
import { writeFile, mkdir } from 'node:fs/promises';

const OUT = new URL('../public/data/', import.meta.url);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'nyx-snapshot/1.0' } });
  const text = await res.text();
  if (!res.ok || !/^\s*[[{]/.test(text)) throw new Error(`${res.status} ${text.slice(0, 90).replace(/\s+/g, ' ')}`);
  return JSON.parse(text);
}

const compactSat = (s) => [
  s.OBJECT_NAME, s.NORAD_CAT_ID, Date.parse(`${s.EPOCH}Z`), s.MEAN_MOTION, s.ECCENTRICITY,
  s.INCLINATION, s.RA_OF_ASC_NODE, s.ARG_OF_PERICENTER, s.MEAN_ANOMALY,
];

async function satellites() {
  const base = 'https://celestrak.org/NORAD/elements/gp.php?FORMAT=json&GROUP=';
  const byId = new Map();
  try {
    for (const s of await getJSON(`${base}active`)) byId.set(s.NORAD_CAT_ID, compactSat(s));
    console.log(`satellites: active catalog, ${byId.size}`);
  } catch (e) {
    console.log(`satellites: active refused (${e.message}) — assembling from groups`);
    const groups = ['stations', 'starlink', 'oneweb', 'kuiper', 'qianfan', 'gnss', 'geo', 'science', 'weather',
      'resource', 'iridium-NEXT', 'globalstar', 'planet', 'spire', 'military', 'cubesat', 'amateur',
      'engineering', 'orbcomm', 'visual', 'other-comm', 'x-comm', 'geodetic', 'education', 'radar'];
    for (const g of groups) {
      try {
        const list = await getJSON(base + g);
        for (const s of list) byId.set(s.NORAD_CAT_ID, compactSat(s));
        console.log(`  ${g}: ${list.length}`);
      } catch (err) { console.log(`  ${g}: skipped (${err.message})`); }
      await sleep(700);
    }
  }
  if (byId.size < 500) throw new Error('too few satellites — keeping the previous snapshot');
  return { generated: new Date().toISOString(), source: 'CelesTrak GP', sats: [...byId.values()] };
}

const feeds = {
  'satellites.json': satellites,
  'quakes.json': () => getJSON('https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson'),
  'kp.json': () => getJSON('https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json'),
  'solarwind.json': () => getJSON('https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json'),
  'eonet.json': async () => {
    const e = await getJSON('https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=400');
    // keep only what the globe draws
    return { events: e.events.map((x) => ({ id: x.id, title: x.title, categories: x.categories.map((c) => ({ id: c.id })), geometry: x.geometry.slice(-1) })) };
  },
};

await mkdir(OUT, { recursive: true });
for (const [file, load] of process.argv.includes('--only-cities') ? [] : Object.entries(feeds)) {
  try {
    const data = await load();
    await writeFile(new URL(file, OUT), JSON.stringify(data));
    console.log(`✓ ${file}`);
  } catch (e) { console.log(`✗ ${file}: ${e.message}`); }
}

/* ---------- 3D city models (OpenStreetMap buildings, © OpenStreetMap contributors, ODbL) ----------
   Static, so they are only fetched when missing:  npm run snapshot -- --cities  to force a refresh. */
import { access } from 'node:fs/promises';
import { CITIES, CITY_SIZE } from '../src/cities.js';

// --cities refetches every model; --cities=tokyo,syd just those
const citiesArg = process.argv.find((x) => x.startsWith('--cities'));
const only = citiesArg && citiesArg.includes('=') ? citiesArg.split('=')[1].split(',') : null;
const force = !!citiesArg;
const exists = (u) => access(u).then(() => true, () => false);

function parseHeight(tags) {
  let h = 0;
  if (tags.height) {
    const v = parseFloat(String(tags.height).replace(',', '.'));
    if (Number.isFinite(v)) h = /ft|'/.test(tags.height) ? v * 0.3048 : v;
  }
  if (!h && tags['building:levels']) {
    const lv = parseFloat(tags['building:levels']);
    if (Number.isFinite(lv) && lv > 0) h = lv * 3.4 + 2;
  }
  return h > 0 && h < 1000 ? h : 0;
}

async function city(c) {
  const half = CITY_SIZE / 2;
  const dLat = half / 111320;
  const dLon = half / (111320 * Math.cos((c.lat * Math.PI) / 180));
  const box = `${c.lat - dLat},${c.lon - dLon},${c.lat + dLat},${c.lon + dLon}`;
  // outlines, plus the "building:part" volumes OSM uses for setbacks, podiums and spires
  const q = `[out:json][timeout:120];(way["building"](${box});relation["building"](${box});way["building:part"](${box});relation["building:part"](${box}););out tags geom;`;
  let json = null;
  for (const host of ['https://overpass-api.de/api/interpreter', 'https://overpass.kumi.systems/api/interpreter']) {
    try {
      const res = await fetch(host, { method: 'POST', body: `data=${encodeURIComponent(q)}`, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': 'nyx-snapshot/1.0' } });
      const text = await res.text();
      if (res.ok && text.trim().startsWith('{')) { json = JSON.parse(text); break; }
      console.log(`  ${host.split('/')[2]}: ${res.status}`);
    } catch (e) { console.log(`  ${host.split('/')[2]}: ${e.message}`); }
    await sleep(3000);
  }
  if (!json) throw new Error('overpass unavailable');

  const mx = 111320 * Math.cos((c.lat * Math.PI) / 180);
  const num = (v) => { const n = parseFloat(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : 0; };
  const outlines = [];
  const parts = [];
  const add = (geom, tags, isPart) => {
    if (!geom || geom.length < 4) return;
    const kind = isPart ? tags['building:part'] : tags.building;
    if (kind === 'no' || ['roof', 'shed', 'garage', 'garages', 'hut', 'kiosk', 'carport'].includes(kind)) return;
    let ring = geom.map((p) => [(p.lon - c.lon) * mx, (p.lat - c.lat) * 111320]);
    // drop the closing point and near-duplicate vertices
    ring = ring.filter((p, i) => i === 0 || Math.hypot(p[0] - ring[i - 1][0], p[1] - ring[i - 1][1]) > 0.8);
    if (ring.length > 3 && Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 0.8) ring.pop();
    if (ring.length < 3) return;
    let area = 0, cx = 0, cy = 0, x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      area += a[0] * b[1] - b[0] * a[1];
      cx += a[0]; cy += a[1];
      x0 = Math.min(x0, a[0]); x1 = Math.max(x1, a[0]); y0 = Math.min(y0, a[1]); y1 = Math.max(y1, a[1]);
    }
    area = Math.abs(area) / 2; cx /= ring.length; cy /= ring.length;
    if (area < (isPart ? 12 : 45) || Math.abs(cx) > half || Math.abs(cy) > half) return;
    const base = num(tags.min_height) || num(tags['building:min_level']) * 3.4;
    const name = tags.name && tags.name.length < 48 ? tags['name:en'] || tags.name : 0;
    (isPart ? parts : outlines).push({ ring, area, cx, cy, box: [x0, x1, y0, y1], h: parseHeight(tags), base, name, hasParts: false, top: null });
  };
  const inside = (o, x, y) => {
    if (x < o.box[0] || x > o.box[1] || y < o.box[2] || y > o.box[3]) return false;
    let hit = false;
    for (let i = 0, j = o.ring.length - 1; i < o.ring.length; j = i++) {
      const a = o.ring[i], b = o.ring[j];
      if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) hit = !hit;
    }
    return hit;
  };
  for (const el of json.elements) {
    const tags = el.tags || {};
    const isPart = !tags.building && !!tags['building:part'];
    if (el.type === 'way') add(el.geometry, tags, isPart);
    else if (el.type === 'relation') for (const m of el.members || []) if (m.role === 'outer' && m.geometry) add(m.geometry, tags, isPart);
  }
  // a building mapped in parts is drawn from its parts; its name rides on the tallest one
  const solids = [];
  for (const p of parts) {
    const o = outlines.find((x) => inside(x, p.cx, p.cy));
    if (o) {
      if (!p.h) p.h = o.h;
      if (!p.h || p.h <= p.base) continue;
      o.hasParts = true;
      if (!o.top || p.h > o.top.h) o.top = p;
    } else if (!p.h || p.h <= p.base) continue;
    solids.push(p);
  }
  for (const o of outlines) {
    if (o.hasParts) { if (o.name && !o.top.name) o.top.name = o.name; } else solids.push(o);
  }
  // keep the 4,500 most significant volumes
  const vol = (b) => b.area * ((b.h || 12) - b.base);
  solids.sort((a, b) => vol(b) - vol(a));
  const kept = solids.slice(0, 4500);
  const r1 = (v) => Math.round(v * 10) / 10;
  return {
    id: c.id, size: CITY_SIZE, fetched: new Date().toISOString().slice(0, 10), measured: kept.filter((b) => b.h).length,
    // [height m (0 = not surveyed), name or 0, footprint x/y metres east/north of centre, base height m]
    b: kept.map((b) => { const row = [r1(b.h), b.h ? b.name || 0 : 0, b.ring.flatMap((p) => [r1(p[0]), r1(p[1])])]; if (b.base > 0) row.push(r1(b.base)); return row; }),
  };
}

await mkdir(new URL('cities/', OUT), { recursive: true });
for (const c of CITIES) {
  const file = new URL(`cities/${c.id}.json`, OUT);
  if (only ? !only.includes(c.id) : !force && await exists(file)) continue;
  try {
    const data = await city(c);
    if (data.b.length < 40) throw new Error(`only ${data.b.length} buildings`);
    await writeFile(file, JSON.stringify(data));
    console.log(`✓ cities/${c.id}.json — ${data.b.length} buildings, ${data.measured} with surveyed height`);
  } catch (e) { console.log(`✗ cities/${c.id}.json: ${e.message}`); }
  await sleep(4000);
}
