// Romantic and fun places nearby.
//
// Main source: Geoapify Places (fast, OpenStreetMap-based, free plan of
// 3,000 credits a day). Set GEOAPIFY_API_KEY in Vercel to turn it on. The key
// stays on the server. Without a key this route answers "not configured" at
// once and the phone asks OpenStreetMap's free Overpass servers itself (see
// public/places-core.js), which works but can be slow.
//
// Results are cached per ~1 km area for a day. Place-name search uses
// Nominatim. Map data © OpenStreetMap contributors; powered by Geoapify.

import { createHash } from "node:crypto";
import { PairingError } from "./pairing.js";
import { CATEGORIES, RADII, distanceM, charm } from "../public/places-core.js";
export { CATEGORIES, RADII, buildQuery, parsePlaces, distanceM, fetchOverpass } from "../public/places-core.js";

const GEOAPIFY = "https://api.geoapify.com/v2/places";
const NOMINATIM = "https://nominatim.openstreetmap.org/search";
const UA = "LoveBetter/1.0 (couples app; https://love-better.vercel.app)";

// Our categories → Geoapify categories.
export const GEO_CATEGORIES = {
  dinner: ["catering.restaurant"],
  cafe: ["catering.cafe", "catering.ice_cream"],
  drinks: ["catering.bar", "catering.pub", "catering.biergarten", "catering.taproom"],
  outdoors: ["leisure.park", "leisure.picnic", "beach", "tourism.attraction.viewpoint"],
  culture: ["entertainment.culture", "entertainment.museum", "tourism.sights"],
  fun: ["entertainment.cinema", "entertainment.bowling_alley", "entertainment.escape_game", "entertainment.amusement_arcade",
        "entertainment.miniature_golf", "entertainment.theme_park", "entertainment.water_park", "entertainment.zoo",
        "entertainment.aquarium", "entertainment.activity_park"],
};

// Most specific first.
const GEO_KINDS = [
  ["tourism.attraction.viewpoint", "Viewpoint"], ["leisure.park.garden", "Garden"], ["leisure.park.nature_reserve", "Nature reserve"],
  ["entertainment.culture.theatre", "Theatre"], ["entertainment.culture.arts_centre", "Arts centre"], ["entertainment.culture.gallery", "Gallery"],
  ["catering.restaurant", "Restaurant"], ["catering.cafe", "Café"], ["catering.ice_cream", "Ice cream"], ["catering.bar", "Bar"],
  ["catering.pub", "Pub"], ["catering.biergarten", "Beer garden"], ["catering.taproom", "Taproom"],
  ["leisure.picnic", "Picnic spot"], ["leisure.park", "Park"], ["beach", "Beach"],
  ["entertainment.museum", "Museum"], ["entertainment.culture", "Culture"], ["tourism.sights", "Sight"],
  ["entertainment.cinema", "Cinema"], ["entertainment.bowling_alley", "Bowling"], ["entertainment.escape_game", "Escape room"],
  ["entertainment.amusement_arcade", "Arcade"], ["entertainment.miniature_golf", "Mini golf"], ["entertainment.theme_park", "Theme park"],
  ["entertainment.water_park", "Water park"], ["entertainment.zoo", "Zoo"], ["entertainment.aquarium", "Aquarium"],
  ["entertainment.activity_park", "Activity park"],
];
const kindOf = cats => { for (const [c, k] of GEO_KINDS) if (cats.includes(c)) return k; return "Place"; };

export function parseGeoapify(cat, data, lat, lon) {
  const seen = new Set(), out = [];
  for (const f of (data && data.features) || []) {
    const p = f.properties || {}, raw = (p.datasource && p.datasource.raw) || {};
    // Some values arrive as numbers (a café called "1004"), so make everything text.
    const str = v => (v == null || v === "" ? null : typeof v === "object" ? null : String(v));
    const name = str(p.name) || str(raw.name);
    if (!name || typeof p.lat !== "number" || typeof p.lon !== "number") continue;
    if (raw.access === "private") continue;
    const key = name.toLowerCase() + "|" + p.lat.toFixed(3) + "|" + p.lon.toFixed(3);
    if (seen.has(key)) continue;
    seen.add(key);
    const cuisine = str(p.catering && p.catering.cuisine) || str(raw.cuisine);
    const website = str(p.website) || str(p.contact && p.contact.website) || str(raw.website) || str(raw["contact:website"]);
    const hours = str(p.opening_hours) || str(raw.opening_hours);
    const cats = Array.isArray(p.categories) ? p.categories.map(String) : [];
    if (cat === "dinner" && /fast_food/.test(cats.join(" "))) continue;
    out.push({
      id: "g" + createHash("sha1").update(String(p.place_id || key)).digest("hex").slice(0, 12),
      name,
      kind: kindOf(cats),
      cat,
      lat: Number(p.lat.toFixed(6)), lon: Number(p.lon.toFixed(6)),
      distance: distanceM(lat, lon, p.lat, p.lon),
      address: str(p.address_line2),
      cuisine: cuisine ? String(cuisine).split(/[;,]/).map(s => s.trim().replace(/_/g, " ")).filter(Boolean).slice(0, 3).join(", ") : null,
      hours,
      website: website && /^https?:\/\//i.test(website) ? website : website ? "https://" + website : null,
      outdoor: raw.outdoor_seating === "yes" || !!(p.facilities && p.facilities.outdoor_seating),
      charm: charm({ ...raw, website, opening_hours: hours, cuisine }),
    });
  }
  out.sort((a, b) => (a.distance - a.charm * 300) - (b.distance - b.charm * 300));
  return out.slice(0, 60);
}

export class PlacesService {
  constructor(store, { fetchImpl = fetch, now = () => Date.now(), geoapifyKey = process.env.GEOAPIFY_API_KEY } = {}) {
    this.store = store; this.kv = store.kv; this.fetch = fetchImpl; this.now = now; this.key = geoapifyKey || null;
  }

  // ~30 new searches a minute per person is plenty and protects the free quota.
  async #limit(uid) {
    const k = this.store.key("places_rate", uid, Math.floor(this.now() / 60000));
    let n = 0;
    try { n = Number(await this.kv.get(k)) || 0; } catch { return; }   // if the database is down, don't block searching
    if (n >= 30) throw new PairingError("slow_down", "That's a lot of searching! Try again in a minute.", 429);
    try { await this.kv.set(k, n + 1, { ex: 90 }); } catch {}
  }

  async #geoapify(categories, lat, lon, radius) {
    const url = GEOAPIFY + "?categories=" + categories.join(",") + "&filter=circle:" + lon + "," + lat + "," + radius +
      "&bias=proximity:" + lon + "," + lat + "&limit=100&apiKey=" + encodeURIComponent(this.key);
    const res = await this.fetch(url, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      let msg = ""; try { msg = (await res.json()).message || ""; } catch {}
      throw Object.assign(new Error("Geoapify HTTP " + res.status + (msg ? ": " + msg : "")), { status: res.status });
    }
    return res.json();
  }

  async nearby(uid, { lat, lon, radius, cat }) {
    lat = Number(lat); lon = Number(lon); radius = Number(radius);
    if (!(lat >= -90 && lat <= 90) || !(lon >= -180 && lon <= 180) || Number.isNaN(lat) || Number.isNaN(lon)) throw new PairingError("bad_location", "Invalid location.");
    if (!RADII.includes(radius)) throw new PairingError("bad_radius", "Pick a distance.");
    if (!CATEGORIES[cat]) throw new PairingError("bad_category", "Pick a kind of place.");
    if (!this.key) throw new PairingError("places_not_configured", "Fast place search isn't set up on the server.", 501);

    // Cache by ~1 km area; distances are still measured from the exact point.
    const ck = this.store.key("gplaces2", cat, radius, lat.toFixed(2), lon.toFixed(2));
    let cached = null;
    try { cached = JSON.parse(await this.kv.get(ck)); } catch {}
    let places = cached;
    if (!places) {
      let data;
      await this.#limit(uid);
      const clat = Number(lat.toFixed(2)), clon = Number(lon.toFixed(2)), r = radius + 800;
      const cats = GEO_CATEGORIES[cat];
      try {
        data = await this.#geoapify(cats, clat, clon, r);
      } catch (e) {
        if (e.status !== 400 || cats.length === 1) {
          console.error("geoapify failed:", e.message);
          throw Object.assign(new PairingError("places_unavailable", "Place search is having trouble. Try again in a moment.", 503), { detail: [e.message] });
        }
        // One unknown category spoils the whole request: ask for each on its own and keep what works.
        const parts = await Promise.allSettled(cats.map(c => this.#geoapify([c], clat, clon, r)));
        const bad = parts.map((p, i) => p.status === "rejected" ? cats[i] + " (" + p.reason.message + ")" : null).filter(Boolean);
        if (bad.length) console.error("geoapify categories failed:", bad.join(" | "));
        const ok = parts.filter(p => p.status === "fulfilled");
        if (!ok.length) throw Object.assign(new PairingError("places_unavailable", "Place search is having trouble. Try again in a moment.", 503), { detail: bad });
        data = { features: ok.flatMap(p => p.value.features || []) };
      }
      // Keep only what the app shows: a few hundred bytes per place.
      places = parseGeoapify(cat, data, clat, clon);
      try { await this.kv.set(ck, JSON.stringify(places), { ex: 24 * 3600 }); }
      catch (e) { console.error("places cache write failed:", e.message); }   // never break a search over caching
    }
    places = places
      .map(p => ({ ...p, distance: distanceM(lat, lon, p.lat, p.lon) }))
      .filter(p => p.distance <= radius)
      .sort((a, b) => (a.distance - a.charm * 300) - (b.distance - b.charm * 300));
    return { cat, radius, places, source: "geoapify", attribution: "Powered by Geoapify · © OpenStreetMap contributors" };
  }

  async geocode(uid, q) {
    q = String(q || "").trim().replace(/\s+/g, " ");
    if (q.length < 2 || q.length > 100) throw new PairingError("bad_query", "Type a town, area or address.");
    const ck = this.store.key("geo", q.toLowerCase());
    const cached = await this.kv.get(ck);
    if (cached) return { results: JSON.parse(cached) };
    await this.#limit(uid);
    let data;
    try {
      const res = await this.fetch(NOMINATIM + "?format=jsonv2&limit=5&q=" + encodeURIComponent(q), { headers: { "User-Agent": UA, Accept: "application/json" }, signal: AbortSignal.timeout(8000) });
      if (!res.ok) throw new Error("HTTP " + res.status);
      data = await res.json();
    } catch (e) { console.error("nominatim failed", e.message); throw new PairingError("places_unavailable", "Couldn't search for that place right now. Try again in a moment.", 503); }
    const results = (Array.isArray(data) ? data : []).map(r => ({ name: r.display_name, lat: Number(Number(r.lat).toFixed(4)), lon: Number(Number(r.lon).toFixed(4)) }));
    await this.kv.set(ck, JSON.stringify(results), { ex: 7 * 24 * 3600 });
    return { results };
  }
}
