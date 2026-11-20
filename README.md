# NYX-7 // Planetary Link

A holographic command core wired to the real planet, in the browser. Three.js, no backend.

## What is real

| Layer | Source |
|---|---|
| Satellites — every active payload, propagated from orbital elements | [CelesTrak](https://celestrak.org) GP data |
| Earthquakes — M2.5+, past 7 days | [USGS Earthquake Hazards Program](https://earthquake.usgs.gov) |
| Wildfires, storms, sea ice | [NASA EONET](https://eonet.gsfc.nasa.gov) |
| Kp index, solar wind | [NOAA Space Weather Prediction Center](https://www.swpc.noaa.gov) |
| Coastlines and borders | [Natural Earth](https://www.naturalearthdata.com) via `world-atlas` |

Each feed is fetched live in the browser. If a source is unreachable the app falls back to a cached copy, then to the snapshot in `public/data`, and says which one it is showing.

Satellite positions use Kepler propagation with J2 secular drift, not full SGP4 — accurate to a fraction of a degree for element sets a day or two old.

## Run

```bash
npm install
npm run dev        # http://localhost:4747
npm run snapshot   # refresh public/data (CelesTrak allows one download per group every 2 hours)
npm run build
```

## Controls

`T` core / planet · drag to orbit · scroll to zoom (planet) or separate (core) · hold `Space` to fast-forward or dilate time · `M` reality layer · `H` hide HUD
