// Romantic and fun places nearby, from OpenStreetMap.
//
// The phone normally asks Overpass itself (see public/app.js); this server
// route is the backup, and also does place-name search through Nominatim,
// both free and keyless. Results are cached (by area, rounded to ~1 km) so we
// stay well inside their fair-use policies. Data © OpenStreetMap contributors.

import { PairingError } from "./pairing.js";

import { CATEGORIES, RADII, buildQuery, parsePlaces, fetchOverpass } from "../public/places-core.js";
export { CATEGORIES, RADII, buildQuery, parsePlaces, distanceM, fetchOverpass } from "../public/places-core.js";

const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const UA = "LoveBetter/1.0 (couples app; https://love-better.vercel.app)";

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
      let data;
      try { ({ data } = await fetchOverpass(q, { fetchImpl: this.fetch, headers: { "User-Agent": UA }, stagger: 3000, timeout: 10000 })); }
      catch (e) {
        console.error("overpass failed:", (e.errors || [e.message]).join(" | "));
        throw Object.assign(new PairingError("places_unavailable", "The map service is busy. Try again in a moment.", 503), { detail: e.errors });
      }
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
