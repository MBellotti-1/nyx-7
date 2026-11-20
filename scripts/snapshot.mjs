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
for (const [file, load] of Object.entries(feeds)) {
  try {
    const data = await load();
    await writeFile(new URL(file, OUT), JSON.stringify(data));
    console.log(`✓ ${file}`);
  } catch (e) { console.log(`✗ ${file}: ${e.message}`); }
}
