import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.js";
import { PlacesService, parsePlaces, buildQuery, distanceM } from "../src/places.js";
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

test("nearby searches validate input, filter by distance and are cached", async () => {
  let calls = 0, lastBody;
  const fetchImpl = async (url, init) => { calls++; lastBody = decodeURIComponent(init.body); return { ok: true, json: async () => SAMPLE }; };
  const svc = new PlacesService(new MemoryStore(), { fetchImpl });
  const r = await svc.nearby("u1", { ...HERE, radius: "1000", cat: "dinner" });
  assert.deepEqual(r.places.map(p => p.name), ["Le Petit Coin", "Burger Hut"]); // the 1.8 km one is outside 1 km
  assert.match(lastBody, /around:1800,59.91,10.75/);
  await svc.nearby("u2", { lat: HERE.lat + 0.001, lon: HERE.lon, radius: 1000, cat: "dinner" });
  assert.equal(calls, 1, "same ~1 km area is served from cache");
  await assert.rejects(svc.nearby("u1", { lat: 200, lon: 0, radius: 1000, cat: "dinner" }), { code: "bad_location" });
  await assert.rejects(svc.nearby("u1", { ...HERE, radius: 999, cat: "dinner" }), { code: "bad_radius" });
  await assert.rejects(svc.nearby("u1", { ...HERE, radius: 1000, cat: "nightclub" }), { code: "bad_category" });
});

test("if the first map server fails, the backup is used; if both fail, a friendly error", async () => {
  const urls = [];
  let fail = 1;
  const fetchImpl = async url => { urls.push(url); if (fail-- > 0) return { ok: false, status: 504 }; return { ok: true, json: async () => SAMPLE }; };
  const svc = new PlacesService(new MemoryStore(), { fetchImpl });
  assert.equal((await svc.nearby("u", { ...HERE, radius: 2000, cat: "dinner" })).places.length, 3);
  assert.equal(urls.length, 2);
  const down = new PlacesService(new MemoryStore(), { fetchImpl: async () => { throw new Error("offline"); } });
  await assert.rejects(down.nearby("u", { ...HERE, radius: 2000, cat: "cafe" }), { code: "places_unavailable", status: 503 });
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

test("places API needs sign-in and is reachable", async () => {
  const places = new PlacesService(new MemoryStore(), { fetchImpl: async () => ({ ok: true, json: async () => SAMPLE }) });
  await withServer(createApp({ store: new MemoryStore(), places }), async ({ call }) => {
    assert.equal((await call(null, "GET", "/api/places?lat=1&lon=1&radius=1000&cat=dinner")).status, 401);
    const r = await call(newKey(), "GET", `/api/places?lat=${HERE.lat}&lon=${HERE.lon}&radius=2000&cat=dinner`);
    assert.equal(r.status, 200); assert.equal(r.body.places[0].name, "Le Petit Coin");
    assert.equal(r.body.attribution, "© OpenStreetMap contributors");
  });
});
