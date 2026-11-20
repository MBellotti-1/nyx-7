# NYX-7 // Planetary Link

The real Earth as a hologram you can fly around, split open and drop into. Three.js, no backend.

**Live:** https://mbellotti-1.github.io/nyx-7/

## What is real

| Layer | Source |
|---|---|
| Satellites — every active payload, propagated from orbital elements | [CelesTrak](https://celestrak.org) GP data |
| Earthquakes — M2.5+, past 7 days, with true depths | [USGS Earthquake Hazards Program](https://earthquake.usgs.gov) |
| Wildfires, storms, sea ice | [NASA EONET](https://eonet.gsfc.nasa.gov) |
| Kp index, solar wind | [NOAA Space Weather Prediction Center](https://www.swpc.noaa.gov) |
| Coastlines and borders | [Natural Earth](https://www.naturalearthdata.com) via `world-atlas` |
| 3D city models — building footprints, heights and names for ten cities | © [OpenStreetMap](https://www.openstreetmap.org/copyright) contributors, ODbL |
| Interior layers | PREM reference model boundaries |
| Day/night, sun angles, moon phase, sidereal rotation | computed from the clock |

Each live feed is fetched in the browser. If a source is unreachable the app falls back to a cached copy, then to the snapshot in `public/data`, and says which one it is showing.

## What is not

- **Satellite positions** use Kepler propagation with J2 secular drift, not full SGP4 — accurate to a fraction of a degree for element sets a day or two old.
- **City buildings without a surveyed height** in OpenStreetMap are drawn at an estimated height, and fainter, so the two are never confused.
- **The city stress test is illustrative.** Which buildings fall is random, on a smooth curve from "none" at M5 to "most" at M9. It is not an engineering model or a forecast.
- The CONSTRUCT and BREACH "reality layers" are colour themes with flavour text.

## Run

```bash
npm install
npm run dev                    # http://localhost:4747
npm run snapshot               # refresh public/data feeds (CelesTrak allows one download per group every 2 hours)
npm run snapshot -- --cities   # also re-fetch the city models from OpenStreetMap (--cities=tokyo,syd for some)
npm run build
```

## Controls

| | |
|---|---|
| Drag / scroll | orbit / zoom |
| `X` or the FRACTURE slider | split the planet open along a plane through the week's strongest earthquake |
| Hold `Space` | fast-forward time — orbits streak, the terminator sweeps, cities fall into night |
| Click a city beacon, or the CITY UPLINK list | descend into its 3D model |
| `Q` / `R` in a city | trigger / reset the stress test |
| `←` `→` in a city | previous / next city |
| `Esc` | back out |
| `M` · `H` · `L` | reality layer · hide HUD · return to live time |
