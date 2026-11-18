// Romantic and fun places nearby, from OpenStreetMap.
//
// Places come from the Overpass API and place-name search from Nominatim,
// both free and keyless. Results are cached (by area, rounded to ~1 km) so we
// stay well inside their fair-use policies. Data © OpenStreetMap contributors.

import { PairingError } from "./pairing.js";

export const CATEGORIES = {
  dinner:  { label: "Romantic dinner", emoji: "🍷", filters: ['["amenity"="restaurant"]'] },
  cafe:    { label: "Cafés & sweets",  emoji: "☕", filters: ['["amenity"="cafe"]', '["amenity"="ice_cream"]', '["shop"="pastry"]', '["shop"="chocolate"]', '["shop"="confectionery"]'] },
  drinks:  { label: "Drinks",          emoji: "🍸", filters: ['["amenity"="bar"]', '["amenity"="pub"]', '["amenity"="biergarten"]', '["shop"="wine"]["tasting"="yes"]'] },
  outdoors:{ label: "Outdoors",        emoji: "🌳", filters: ['["leisure"="park"]', '["leisure"="garden"]', '["tourism"="viewpoint"]', '["natural"="beach"]', '["leisure"="picnic_site"]', '["tourism"="picnic_site"]', '["leisure"="nature_reserve"]', '["leisure"="marina"]'] },
  culture: { label: "Culture",         emoji: "🎭", filters: ['["tourism"="museum"]', '["tourism"="gallery"]', '["amenity"="theatre"]', '["amenity"="arts_centre"]', '["amenity"="planetarium"]', '["tourism"="attraction"]'] },
  fun:     { label: "Fun & games",     emoji: "🎳", filters: ['["amenity"="cinema"]', '["leisure"="bowling_alley"]', '["leisure"="escape_game"]', '["leisure"="amusement_arcade"]', '["leisure"="miniature_golf"]', '["amenity"="karaoke_box"]', '["tourism"="theme_park"]', '["tourism"="zoo"]', '["tourism"="aquarium"]', '["leisure"="ice_rink"]', '["leisure"="trampoline_park"]', '["leisure"="water_park"]'] },
};
export const RADII = [1000, 2000, 5000, 10000];

const OVERPASS = ["https://overpass-api.de/api/interpreter", "https://overpass.kumi.systems/api/interpreter"];
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const UA = "LoveBetter/1.0 (couples app; https://love-better.vercel.app)";

// Human-friendly kind for a place, from its tags.
const KINDS = [
  ["amenity", { restaurant: "Restaurant", cafe: "Café", ice_cream: "Ice cream", bar: "Bar", pub: "Pub", biergarten: "Beer garden", theatre: "Theatre", arts_centre: "Arts centre", planetarium: "Planetarium", cinema: "Cinema", karaoke_box: "Karaoke" }],
  ["shop", { pastry: "Pâtisserie", chocolate: "Chocolate shop", confectionery: "Sweet shop", wine: "Wine tasting" }],
  ["leisure", { park: "Park", garden: "Garden", picnic_site: "Picnic spot", nature_reserve: "Nature reserve", marina: "Marina", bowling_alley: "Bowling", escape_game: "Escape room", amusement_arcade: "Arcade", miniature_golf: "Mini golf", ice_rink: "Ice rink", trampoline_park: "Trampoline park", water_park: "Water park" }],
  ["tourism", { viewpoint: "Viewpoint", museum: "Museum", gallery: "Gallery", attraction: "Attraction", theme_park: "Theme park", zoo: "Zoo", aquarium: "Aquarium", picnic_site: "Picnic spot" }],
  ["natural", { beach: "Beach" }],
];
function kindOf(tags) {
  for (const [k, map] of KINDS) if (map[tags[k]]) return map[tags[k]];
  return "Place";
}

// Little touches that make a place more date-worthy float up the list.
function charm(tags) {
  let s = 0;
  if (tags.outdoor_seating === "yes") s += 1;
  if (tags.website || tags["contact:website"]) s += 1;
  if (tags.opening_hours) s += 1;
  if (/wine|french|italian|seafood|sushi|tapas|fine|romantic/i.test(tags.cuisine || "")) s += 1;
  if (tags.tourism === "viewpoint" || tags.natural === "beach" || tags.leisure === "garden") s += 1;
  if (/fast_food|kebab|burger|chicken/i.test(tags.cuisine || "")) s -= 2;
  return s;
}

export function distanceM(lat1, lon1, lat2, lon2) {
  const R = 6371000, r = d => d * Math.PI / 180;
  const a = Math.sin(r(lat2 - lat1) / 2) ** 2 + Math.cos(r(lat1)) * Math.cos(r(lat2)) * Math.sin(r(lon2 - lon1) / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

export function buildQuery(cat, lat, lon, radius) {
  const around = `(around:${radius},${lat},${lon})`;
  const parts = CATEGORIES[cat].filters.map(f => `nwr${f}["name"]${around};`).join("");
  return `[out:json][timeout:20];(${parts});out center tags 300;`;
}

export function parsePlaces(cat, data, lat, lon) {
  const seen = new Set(), out = [];
  for (const el of data.elements || []) {
    const t = el.tags || {}, plat = el.lat ?? el.center?.lat, plon = el.lon ?? el.center?.lon;
    if (!t.name || plat == null || plon == null) continue;
    if (t.access === "private" || t.disused === "yes") continue;
    const key = t.name.toLowerCase() + "|" + plat.toFixed(3) + "|" + plon.toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    const website = t.website || t["contact:website"] || null;
    out.push({
      id: el.type[0] + el.id,
      name: t.name,
      kind: kindOf(t),
      cat,
      lat: Number(plat.toFixed(6)), lon: Number(plon.toFixed(6)),
      distance: distanceM(lat, lon, plat, plon),
      cuisine: t.cuisine ? t.cuisine.split(";").map(s => s.trim().replace(/_/g, " ")).slice(0, 3).join(", ") : null,
      hours: t.opening_hours || null,
      website: website && /^https?:\/\//i.test(website) ? website : website ? "https://" + website : null,
      outdoor: t.outdoor_seating === "yes",
      charm: charm(t),
    });
  }
  // Mostly by distance, nudged by charm (each charm point ≈ 300 m closer).
  out.sort((a, b) => (a.distance - a.charm * 300) - (b.distance - b.charm * 300));
  return out.slice(0, 60);
}

export class PlacesService {
  constructor(store, { fetchImpl = fetch, now = () => Date.now() } = {}) {
    this.store = store; this.kv = store.kv; this.fetch = fetchImpl; this.now = now;
  }

  // ~30 searches a minute per person is plenty and keeps us polite.
  async #limit(uid) {
    const k = this.store.key("places_rate", uid, Math.floor(this.now() / 60000));
    const n = Number(await this.kv.get(k)) || 0;
    if (n >= 30) throw new PairingError("slow_down", "That's a lot of searching! Try again in a minute.", 429);
    await this.kv.set(k, n + 1, { ex: 90 });
  }

  async #get(url, init) {
    const res = await this.fetch(url, { ...init, headers: { "User-Agent": UA, Accept: "application/json", ...(init && init.headers) }, signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error("upstream " + res.status);
    return res.json();
  }

  async nearby(uid, { lat, lon, radius, cat }) {
    lat = Number(lat); lon = Number(lon); radius = Number(radius);
    if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180) || Number.isNaN(lat) || Number.isNaN(lon)) throw new PairingError("bad_location", "Invalid location.");
    if (!RADII.includes(radius)) throw new PairingError("bad_radius", "Pick a distance.");
    if (!CATEGORIES[cat]) throw new PairingError("bad_category", "Pick a kind of place.");
    // Cache by ~1 km area; distances are still measured from the exact point.
    const ck = this.store.key("places", cat, radius, lat.toFixed(2), lon.toFixed(2));
    let raw = await this.kv.get(ck);
    if (raw) raw = JSON.parse(raw);
    else {
      await this.#limit(uid);
      const clat = Number(lat.toFixed(2)), clon = Number(lon.toFixed(2));
      const q = buildQuery(cat, clat, clon, radius + 800);
      let data, lastErr;
      for (const url of OVERPASS) {
        try { data = await this.#get(url, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "data=" + encodeURIComponent(q) }); break; }
        catch (e) { lastErr = e; }
      }
      if (!data) { console.error("overpass failed", lastErr && lastErr.message); throw new PairingError("places_unavailable", "The map service is busy. Try again in a moment.", 503); }
      raw = (data.elements || []).map(e => ({ type: e.type, id: e.id, lat: e.lat, lon: e.lon, center: e.center, tags: e.tags }));
      await this.kv.set(ck, JSON.stringify(raw), { ex: 24 * 3600 });
    }
    const places = parsePlaces(cat, { elements: raw }, lat, lon).filter(p => p.distance <= radius);
    return { cat, radius, places, attribution: "© OpenStreetMap contributors" };
  }

  async geocode(uid, q) {
    q = String(q || "").trim().replace(/\s+/g, " ");
    if (q.length < 2 || q.length > 100) throw new PairingError("bad_query", "Type a town, area or address.");
    const ck = this.store.key("geo", q.toLowerCase());
    const cached = await this.kv.get(ck);
    if (cached) return { results: JSON.parse(cached) };
    await this.#limit(uid);
    let data;
    try { data = await this.#get(NOMINATIM + "?format=jsonv2&limit=5&q=" + encodeURIComponent(q)); }
    catch (e) { console.error("nominatim failed", e.message); throw new PairingError("places_unavailable", "Couldn't search for that place right now. Try again in a moment.", 503); }
    const results = (Array.isArray(data) ? data : []).map(r => ({ name: r.display_name, lat: Number(Number(r.lat).toFixed(4)), lon: Number(Number(r.lon).toFixed(4)) }));
    await this.kv.set(ck, JSON.stringify(results), { ex: 7 * 24 * 3600 });
    return { results };
  }
}
