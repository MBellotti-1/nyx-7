// Live planetary feeds. Every feed tries the real source first and degrades in
// steps — browser cache, then the snapshot bundled in /public/data — and reports
// honestly which one the globe is showing.
//
//   quakes      USGS Earthquake Hazards Program — M2.5+, past 7 days
//   sats        CelesTrak GP element sets — every active payload in orbit
//   kp / wind   NOAA Space Weather Prediction Center
//   events      NASA EONET — open natural events (wildfires, storms, ice)

const BASE = import.meta.env.BASE_URL;
const LIVE = {
  quakes: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/2.5_week.geojson',
  sats: 'https://celestrak.org/NORAD/elements/gp.php?GROUP=active&FORMAT=json',
  kp: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json',
  wind: 'https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json',
  events: 'https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=400',
};
const SNAP = { quakes: 'quakes.json', sats: 'satellites.json', kp: 'kp.json', wind: 'solarwind.json', events: 'eonet.json' };

export const feeds = {
  quakes: { status: 'pending', data: null, at: 0 },
  sats: { status: 'pending', data: null, at: 0 },
  kp: { status: 'pending', data: null, at: 0 },
  wind: { status: 'pending', data: null, at: 0 },
  events: { status: 'pending', data: null, at: 0 },
};

const listeners = [];
export const onFeed = (fn) => listeners.push(fn);
const emit = (name, extra) => listeners.forEach((fn) => fn(name, feeds[name], extra));

async function getJSON(url, timeout = 20000) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeout);
  try {
    const res = await fetch(url, { signal: ctl.signal });
    const text = await res.text();
    if (!res.ok || !/^\s*[[{]/.test(text)) throw new Error(`${res.status}`);
    return JSON.parse(text);
  } finally { clearTimeout(timer); }
}

/* ---------- tiny IndexedDB key/value (the satellite catalog is too big for localStorage) ---------- */
function db() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('nyx', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('kv');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function kvGet(key) {
  try {
    const d = await db();
    return await new Promise((resolve) => {
      const r = d.transaction('kv').objectStore('kv').get(key);
      r.onsuccess = () => resolve(r.result || null);
      r.onerror = () => resolve(null);
    });
  } catch { return null; }
}
async function kvSet(key, value) {
  try {
    const d = await db();
    d.transaction('kv', 'readwrite').objectStore('kv').put(value, key);
  } catch { /* private mode etc. — the snapshot still covers us */ }
}

function safeLocal(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    localStorage.setItem(key, value);
  } catch { /* storage blocked */ }
  return null;
}

/* ---------- normalisers ---------- */
const normQuakes = (g) => g.features
  .filter((f) => f.geometry && f.properties.mag != null && f.properties.type === 'earthquake')
  .map((f) => ({
    id: f.id, mag: f.properties.mag, place: f.properties.place || 'unknown location', time: f.properties.time,
    lon: f.geometry.coordinates[0], lat: f.geometry.coordinates[1], depth: f.geometry.coordinates[2] || 0,
    tsunami: !!f.properties.tsunami,
  }))
  .sort((a, b) => a.time - b.time);

const normSatsLive = (list) => list.map((s) => [
  s.OBJECT_NAME, s.NORAD_CAT_ID, Date.parse(`${s.EPOCH}Z`), s.MEAN_MOTION, s.ECCENTRICITY,
  s.INCLINATION, s.RA_OF_ASC_NODE, s.ARG_OF_PERICENTER, s.MEAN_ANOMALY,
]);

const normKp = (rows) => rows
  .map((r) => (Array.isArray(r) ? { t: Date.parse(`${r[0].replace(' ', 'T')}Z`), kp: +r[1] } : { t: Date.parse(`${r.time_tag}Z`), kp: +r.Kp }))
  .filter((r) => Number.isFinite(r.kp) && Number.isFinite(r.t));

const normWind = (rows) => {
  const r = Array.isArray(rows) ? rows[rows.length - 1] : rows;
  return { speed: +(r.proton_speed ?? r.WindSpeed), t: Date.parse(r.time_tag ?? r.TimeStamp) };
};

const normEvents = (e) => e.events.map((x) => {
  const g = x.geometry[x.geometry.length - 1];
  const c = g && g.type === 'Point' ? g.coordinates : null;
  return c && { id: x.id, title: x.title, cat: x.categories[0] ? x.categories[0].id : 'other', lon: c[0], lat: c[1] };
}).filter(Boolean);

/* ---------- loaders ---------- */
async function load(name, norm, { silent = false } = {}) {
  const f = feeds[name];
  try {
    f.data = norm(await getJSON(LIVE[name]));
    f.status = 'live';
    f.at = Date.now();
  } catch {
    if (f.data) return; // keep what we have; a failed refresh is not news
    try {
      const snap = await getJSON(BASE + 'data/' + SNAP[name]);
      f.data = norm(snap);
      f.status = 'snapshot';
      f.at = Date.now();
    } catch { f.status = 'offline'; }
  }
  if (!silent) emit(name);
}

async function loadSats() {
  const f = feeds.sats;
  const cached = await kvGet('sats');
  const fresh = cached && Date.now() - cached.at < 3 * 3600e3;
  if (cached) {
    f.data = cached.sats; f.at = cached.at; f.status = fresh ? 'live' : 'cached';
    emit('sats');
    if (fresh) return;
  }
  try {
    // CelesTrak serves each group once per two hours per address — hence the cache above,
    // and one attempt per half hour at most, however often the page is reloaded
    const lastTry = +(safeLocal('nyx.satsTry') || 0);
    if (Date.now() - lastTry < 30 * 60e3) throw new Error('backing off');
    safeLocal('nyx.satsTry', String(Date.now()));
    const sats = normSatsLive(await getJSON(LIVE.sats, 45000));
    if (sats.length < 500) throw new Error('short catalog');
    f.data = sats; f.at = Date.now(); f.status = 'live';
    kvSet('sats', { at: f.at, sats });
    emit('sats');
  } catch {
    if (f.data) return;
    try {
      const snap = await getJSON(BASE + 'data/' + SNAP.sats, 45000);
      f.data = snap.sats; f.at = Date.parse(snap.generated); f.status = 'snapshot';
    } catch { f.status = 'offline'; }
    emit('sats');
  }
}

let knownQuakes = null;
async function loadQuakes() {
  await load('quakes', normQuakes, { silent: true });
  const list = feeds.quakes.data || [];
  const fresh = knownQuakes ? list.filter((q) => !knownQuakes.has(q.id)) : [];
  knownQuakes = new Set(list.map((q) => q.id));
  emit('quakes', { fresh });
}

export function startFeeds() {
  loadQuakes();
  loadSats();
  load('kp', normKp);
  load('wind', normWind);
  load('events', normEvents);
  setInterval(loadQuakes, 120e3);
  setInterval(() => load('wind', normWind), 180e3);
  setInterval(() => load('kp', normKp), 900e3);
}

/* ---------- small derived helpers used by HUD + panels ---------- */
export const kpNow = () => (feeds.kp.data && feeds.kp.data.length ? feeds.kp.data[feeds.kp.data.length - 1].kp : null);
export const kpWord = (k) => (k >= 7 ? 'SEVERE STORM' : k >= 5 ? 'STORM' : k >= 4 ? 'ACTIVE' : k >= 2 ? 'UNSETTLED' : 'QUIET');
export function quakeStats() {
  const list = feeds.quakes.data;
  if (!list || !list.length) return null;
  const dayAgo = Date.now() - 86400e3;
  let max = list[0], max24 = null, n24 = 0;
  for (const q of list) {
    if (q.mag > max.mag) max = q;
    if (q.time > dayAgo) { n24++; if (!max24 || q.mag > max24.mag) max24 = q; }
  }
  return { n: list.length, n24, max, max24 };
}
export function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 3600) return `${Math.round(s / 60)} MIN AGO`;
  if (s < 86400) return `${(s / 3600).toFixed(1)} H AGO`;
  return `${(s / 86400).toFixed(1)} D AGO`;
}
