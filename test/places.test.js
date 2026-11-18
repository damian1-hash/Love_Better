import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.js";
import { PlacesService, parsePlaces, buildQuery, distanceM, fetchOverpass } from "../src/places.js";
import { createApp } from "../src/server.js";
import { withServer, newKey } from "./helpers.js";

const HERE = { lat: 59.9139, lon: 10.7522 };
const SAMPLE = { elements: [
  { type: "node", id: 1, lat: 59.9145, lon: 10.7530, tags: { amenity: "restaurant", name: "Le Petit Coin", cuisine: "french;wine_bar", outdoor_seating: "yes", opening_hours: "Tu-Su 17:00-23:00", website: "lepetit.example" } },
  { type: "node", id: 2, lat: 59.9140, lon: 10.7523, tags: { amenity: "restaurant", name: "Burger Hut", cuisine: "burger" } },
  { type: "way", id: 3, center: { lat: 59.9300, lon: 10.7522 }, tags: { amenity: "restaurant", name: "Far Away Bistro" } },
  { type: "node", id: 4, lat: 59.9141, lon: 10.7524, tags: { amenity: "restaurant" } },                       // no name
  { type: "node", id: 5, lat: 59.9142, lon: 10.7525, tags: { amenity: "restaurant", name: "Private Club", access: "private" } },
  { type: "node", id: 6, lat: 59.9145, lon: 10.7530, tags: { amenity: "restaurant", name: "Le Petit Coin" } }, // duplicate
] };

test("places are named, deduped, measured and date-worthy ones float up", () => {
  const places = parsePlaces("dinner", SAMPLE, HERE.lat, HERE.lon);
  assert.deepEqual(places.map(p => p.name), ["Le Petit Coin", "Burger Hut", "Far Away Bistro"]);
  const p = places[0];
  assert.equal(p.kind, "Restaurant"); assert.equal(p.cuisine, "french, wine bar"); assert.equal(p.outdoor, true);
  assert.equal(p.website, "https://lepetit.example");
  assert.ok(Math.abs(places[2].distance - 1790) < 30, String(places[2].distance));
  assert.ok(distanceM(0, 0, 0, 1) > 111000 && distanceM(0, 0, 0, 1) < 111400);
  assert.match(buildQuery("fun", 1, 2, 500), /nwr\["amenity"="cinema"\]\["name"\]\(around:500,1,2\);/);
});

const GEO = { type: "FeatureCollection", features: [
  { properties: { place_id: "a1", name: "Le Petit Coin", lat: 59.9145, lon: 10.7530, categories: ["catering", "catering.restaurant"], address_line2: "Storgata 1, Oslo",
      catering: { cuisine: "french" }, opening_hours: "Tu-Su 17:00-23:00", website: "lepetit.example", datasource: { raw: { outdoor_seating: "yes", cuisine: "french" } } } },
  { properties: { place_id: "a2", name: "Quick Burger", lat: 59.9140, lon: 10.7523, categories: ["catering", "catering.fast_food"] } },
  { properties: { place_id: "a3", name: "Far Away Bistro", lat: 59.9300, lon: 10.7522, categories: ["catering.restaurant"] } },
  { properties: { place_id: "a4", lat: 59.9141, lon: 10.7524, categories: ["catering.restaurant"] } },
] };
const KEY = "test-geo-key";

test("Geoapify places are parsed, fast food skipped, and cached per area", async () => {
  const urls = [];
  const fetchImpl = async url => { urls.push(url); return { ok: true, json: async () => GEO }; };
  const svc = new PlacesService(new MemoryStore(), { fetchImpl, geoapifyKey: KEY });
  const r = await svc.nearby("u1", { ...HERE, radius: "1000", cat: "dinner" });
  assert.deepEqual(r.places.map(p => p.name), ["Le Petit Coin"]);
  const p = r.places[0];
  assert.equal(p.kind, "Restaurant"); assert.equal(p.address, "Storgata 1, Oslo"); assert.equal(p.cuisine, "french");
  assert.equal(p.outdoor, true); assert.equal(p.website, "https://lepetit.example"); assert.equal(r.source, "geoapify");
  const u = new URL(urls[0]);
  assert.equal(u.searchParams.get("categories"), "catering.restaurant");
  assert.equal(u.searchParams.get("filter"), "circle:10.75,59.91,1800");
  assert.equal(u.searchParams.get("apiKey"), KEY);
  await svc.nearby("u2", { lat: HERE.lat + 0.001, lon: HERE.lon, radius: 1000, cat: "dinner" });
  assert.equal(urls.length, 1, "same ~1 km area is served from cache");
  await assert.rejects(svc.nearby("u1", { lat: 200, lon: 0, radius: 1000, cat: "dinner" }), { code: "bad_location" });
  await assert.rejects(svc.nearby("u1", { ...HERE, radius: 999, cat: "dinner" }), { code: "bad_radius" });
  await assert.rejects(svc.nearby("u1", { ...HERE, radius: 1000, cat: "nightclub" }), { code: "bad_category" });
});

test("without a Geoapify key the server says so at once, so the phone can use OpenStreetMap", async () => {
  let called = false;
  const svc = new PlacesService(new MemoryStore(), { fetchImpl: async () => { called = true; }, geoapifyKey: "" });
  const t = Date.now();
  await assert.rejects(svc.nearby("u", { ...HERE, radius: 2000, cat: "dinner" }), { code: "places_not_configured", status: 501 });
  assert.ok(Date.now() - t < 100); assert.equal(called, false);
});

test("an unknown Geoapify category doesn't break the search; outages give a friendly error", async () => {
  const asked = [];
  const fetchImpl = async url => {
    const c = new URL(url).searchParams.get("categories"); asked.push(c);
    if (c.includes("catering.taproom")) return { ok: false, status: 400, json: async () => ({ message: "Unknown category" }) };
    return { ok: true, json: async () => ({ features: c === "catering.bar" ? [{ properties: { place_id: "b", name: "Velvet Bar", lat: 59.914, lon: 10.753, categories: ["catering.bar"] } }] : [] }) };
  };
  const svc = new PlacesService(new MemoryStore(), { fetchImpl, geoapifyKey: KEY });
  const r = await svc.nearby("u", { ...HERE, radius: 2000, cat: "drinks" });
  assert.deepEqual(r.places.map(p => [p.name, p.kind]), [["Velvet Bar", "Bar"]]);
  assert.equal(asked.length, 1 + 4);
  const down = new PlacesService(new MemoryStore(), { fetchImpl: async () => ({ ok: false, status: 500, json: async () => ({}) }), geoapifyKey: KEY });
  await assert.rejects(down.nearby("u", { ...HERE, radius: 2000, cat: "cafe" }), { code: "places_unavailable", status: 503 });
});

test("Overpass (the phone's fallback): a refused server moves on at once, all failing is reported", async () => {
  const urls = []; let fail = 1;
  const fetchImpl = async url => { urls.push(url); if (fail-- > 0) return { ok: false, status: 429 }; return { ok: true, json: async () => SAMPLE }; };
  const t = Date.now();
  const r = await fetchOverpass("q", { fetchImpl, stagger: 3000 });
  assert.equal(urls.length, 2); assert.ok(Date.now() - t < 1000); assert.equal(r.data.elements.length, SAMPLE.elements.length);
  await assert.rejects(fetchOverpass("q", { fetchImpl: async () => { throw new Error("offline"); } }), e => e.errors.length === 4);
});

test("a slow map server doesn't hold things up: the next one starts after the stagger", async () => {
  const started = [];
  const fetchImpl = (url, init) => { started.push(url); return url.includes("overpass-api.de")
    ? new Promise((_, rej) => init.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" }))))
    : Promise.resolve({ ok: true, json: async () => SAMPLE }); };
  const t = Date.now();
  const r = await fetchOverpass("q", { fetchImpl, stagger: 100, timeout: 5000 });
  assert.equal(r.server, "overpass.private.coffee");
  assert.ok(Date.now() - t < 1000);
  assert.equal(started.length, 2);
  // a "timed out" remark with no results counts as a failure
  const remark = await fetchOverpass("q", { fetchImpl: async url => ({ ok: true, json: async () => url.includes("overpass-api.de") ? { elements: [], remark: "runtime error: Query timed out" } : SAMPLE }), stagger: 50 });
  assert.notEqual(remark.server, "overpass-api.de");
  await assert.rejects(fetchOverpass("q", { fetchImpl: () => new Promise((_, rej) => setTimeout(() => rej(new Error("x")), 5)), stagger: 10, timeout: 50 }), e => e.errors.length === 4);
});

test("place search uses Nominatim with a proper User-Agent, and rate-limits", async () => {
  let ua, n = 0;
  const fetchImpl = async (url, init) => { n++; ua = init.headers["User-Agent"]; return { ok: true, json: async () => [{ display_name: "Lagos, Nigeria", lat: "6.4550575", lon: "3.3941795" }] }; };
  const svc = new PlacesService(new MemoryStore(), { fetchImpl });
  const r = await svc.geocode("u", "  Lagos  ");
  assert.deepEqual(r.results, [{ name: "Lagos, Nigeria", lat: 6.4551, lon: 3.3942 }]);
  assert.match(ua, /LoveBetter/);
  await svc.geocode("u", "lagos"); assert.equal(n, 1, "cached");
  await assert.rejects(svc.geocode("u", "x"), { code: "bad_query" });
  for (let i = 0; i < 29; i++) await svc.geocode("u", "town " + i);
  await assert.rejects(svc.geocode("u", "one more"), { code: "slow_down", status: 429 });
});

test("places API needs sign-in, works, and never sends the API key to the phone", async () => {
  const places = new PlacesService(new MemoryStore(), { fetchImpl: async () => ({ ok: true, json: async () => GEO }), geoapifyKey: KEY });
  await withServer(createApp({ store: new MemoryStore(), places }), async ({ call, base }) => {
    assert.equal((await call(null, "GET", "/api/places?lat=1&lon=1&radius=1000&cat=dinner")).status, 401);
    const r = await call(newKey(), "GET", `/api/places?lat=${HERE.lat}&lon=${HERE.lon}&radius=2000&cat=dinner`);
    assert.equal(r.status, 200); assert.equal(r.body.places[0].name, "Le Petit Coin");
    assert.ok(!JSON.stringify(r.body).includes(KEY));
    for (const f of ["/", "/app.js", "/places-core.js"]) assert.ok(!(await (await fetch(base + f)).text()).includes(KEY));
  });
});
