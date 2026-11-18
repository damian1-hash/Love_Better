// Shared by the browser (Explore tab) and the server (src/places.js):
// which places count as date spots, how to ask OpenStreetMap's Overpass API
// for them, and how to turn the answer into a tidy list.
// Map data © OpenStreetMap contributors (ODbL).

export const CATEGORIES = {
  dinner:  { label: "Romantic dinner", emoji: "🍷", filters: ['["amenity"="restaurant"]'] },
  cafe:    { label: "Cafés & sweets",  emoji: "☕", filters: ['["amenity"="cafe"]', '["amenity"="ice_cream"]', '["shop"="pastry"]', '["shop"="chocolate"]', '["shop"="confectionery"]'] },
  drinks:  { label: "Drinks",          emoji: "🍸", filters: ['["amenity"="bar"]', '["amenity"="pub"]', '["amenity"="biergarten"]', '["shop"="wine"]["tasting"="yes"]'] },
  outdoors:{ label: "Outdoors",        emoji: "🌳", filters: ['["leisure"="park"]', '["leisure"="garden"]', '["tourism"="viewpoint"]', '["natural"="beach"]', '["leisure"="picnic_site"]', '["tourism"="picnic_site"]', '["leisure"="nature_reserve"]', '["leisure"="marina"]'] },
  culture: { label: "Culture",         emoji: "🎭", filters: ['["tourism"="museum"]', '["tourism"="gallery"]', '["amenity"="theatre"]', '["amenity"="arts_centre"]', '["amenity"="planetarium"]', '["tourism"="attraction"]'] },
  fun:     { label: "Fun & games",     emoji: "🎳", filters: ['["amenity"="cinema"]', '["leisure"="bowling_alley"]', '["leisure"="escape_game"]', '["leisure"="amusement_arcade"]', '["leisure"="miniature_golf"]', '["amenity"="karaoke_box"]', '["tourism"="theme_park"]', '["tourism"="zoo"]', '["tourism"="aquarium"]', '["leisure"="ice_rink"]', '["leisure"="trampoline_park"]', '["leisure"="water_park"]'] },
};
export const RADII = [1000, 2000, 5000, 10000];

// Public Overpass servers, tried in turn. A slow one doesn't block the next:
// each new server starts a few seconds after the previous one, or straight
// away if the previous one fails.
export const MIRRORS = [
  "https://overpass-api.de/api/interpreter",
  "https://overpass.private.coffee/api/interpreter",
  "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

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
  return `[out:json][timeout:25];(${parts});out center tags 300;`;
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

const hostOf = url => { try { return new URL(url).host; } catch (e) { return url; } };

// Ask the Overpass servers, staggered. Resolves with the first good answer,
// or rejects with err.errors listing what went wrong with each server.
export function fetchOverpass(query, { fetchImpl = fetch, mirrors = MIRRORS, stagger = 3000, timeout = 12000, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const errors = [], ctrls = [];
    let next = 0, running = 0, done = false, timer = null;
    const finishFail = () => {
      if (!done && running === 0 && next >= mirrors.length) {
        done = true;
        reject(Object.assign(new Error("No map server answered."), { errors }));
      }
    };
    const startNext = () => {
      clearTimeout(timer);
      if (done || next >= mirrors.length) return finishFail();
      const url = mirrors[next++];
      running++;
      timer = setTimeout(startNext, stagger);
      const ctrl = new AbortController(); ctrls.push(ctrl);
      const t = setTimeout(() => ctrl.abort(), timeout);
      fetchImpl(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded", ...headers },
        body: "data=" + encodeURIComponent(query),
        signal: ctrl.signal,
      }).then(async res => {
        if (!res.ok) throw new Error("HTTP " + res.status);
        const data = await res.json();
        if (!data || !Array.isArray(data.elements)) throw new Error("unexpected answer");
        if (!data.elements.length && data.remark && /error|timed out|out of memory/i.test(data.remark)) throw new Error(data.remark.slice(0, 80));
        if (done) return;
        done = true; clearTimeout(timer);
        ctrls.forEach(c => c !== ctrl && c.abort());
        resolve({ data, server: hostOf(url) });
      }).catch(e => {
        if (!done) errors.push(hostOf(url) + ": " + (e && e.name === "AbortError" ? "no answer in " + timeout / 1000 + "s" : (e && e.message) || "failed"));
        if (!done) startNext();   // failed fast: try the next server now
      }).finally(() => { clearTimeout(t); running--; finishFail(); });
    };
    startNext();
  });
}
