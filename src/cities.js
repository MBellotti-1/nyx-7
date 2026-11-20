// Cities with a 3D view. Building geometry comes from OpenStreetMap (see scripts/snapshot.mjs);
// everything here is hand-entered reference data — populations are rounded metro figures.
export const CITIES = [
  { id: 'nyc', name: 'NEW YORK', district: 'Midtown Manhattan', country: 'USA', lat: 40.7527, lon: -73.9818, tz: 'America/New_York', pop: 19.9,
    note: 'Low seismicity, but not none: the 2024 M4.8 New Jersey quake was felt across the city.' },
  { id: 'tokyo', name: 'TOKYO', district: 'Marunouchi', country: 'JAPAN', lat: 35.6812, lon: 139.7671, tz: 'Asia/Tokyo', pop: 37.0,
    note: 'Sits near the junction of four tectonic plates. The largest metro area on Earth, engineered for shaking.' },
  { id: 'sf', name: 'SAN FRANCISCO', district: 'Financial District', country: 'USA', lat: 37.7936, lon: -122.399, tz: 'America/Los_Angeles', pop: 4.6,
    note: 'Bracketed by the San Andreas and Hayward faults. Levelled by the 1906 earthquake and fire.' },
  { id: 'la', name: 'LOS ANGELES', district: 'Downtown', country: 'USA', lat: 34.0505, lon: -118.2551, tz: 'America/Los_Angeles', pop: 12.8,
    note: 'Threaded by the San Andreas system. The 1994 M6.7 Northridge quake struck beneath the suburbs.' },
  { id: 'cdmx', name: 'MEXICO CITY', district: 'Paseo de la Reforma', country: 'MEXICO', lat: 19.427, lon: -99.1677, tz: 'America/Mexico_City', pop: 21.8,
    note: 'Built on a drained lakebed that amplifies seismic waves: M8.0 in 1985, M7.1 in 2017.' },
  { id: 'ist', name: 'ISTANBUL', district: 'Levent', country: 'TÜRKIYE', lat: 41.0786, lon: 29.0111, tz: 'Europe/Istanbul', pop: 15.7,
    note: 'The North Anatolian Fault passes about 20 km to the south, beneath the Sea of Marmara.' },
  { id: 'hk', name: 'HONG KONG', district: 'Central', country: 'CHINA', lat: 22.2819, lon: 114.158, tz: 'Asia/Hong_Kong', pop: 7.5,
    note: 'Low-to-moderate seismic hazard, and one of the densest skylines ever built.' },
  { id: 'dxb', name: 'DUBAI', district: 'Downtown', country: 'UAE', lat: 25.1972, lon: 55.2744, tz: 'Asia/Dubai', pop: 3.6,
    note: 'Low local hazard, but its towers sway to large earthquakes in Iran’s Zagros mountains.' },
  { id: 'lon', name: 'LONDON', district: 'City of London', country: 'UK', lat: 51.5142, lon: -0.081, tz: 'Europe/London', pop: 9.0,
    note: 'Low hazard. Its largest known shock was the Dover Straits earthquake of 1580.' },
  { id: 'syd', name: 'SYDNEY', district: 'Central Business District', country: 'AUSTRALIA', lat: -33.866, lon: 151.208, tz: 'Australia/Sydney', pop: 5.4,
    note: 'On a stable plate interior — yet the 1989 M5.6 Newcastle quake hit just up the coast.' },
];
export const CITY_SIZE = 1300; // metres: side of the square modelled around each centre
