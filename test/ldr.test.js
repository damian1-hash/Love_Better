import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";
import { MemoryStore } from "../src/store.js";
import { PlacesService } from "../src/places.js";
import { withServer, newKey } from "./helpers.js";

const day = (n = 0) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

// Fake Nominatim reverse geocoding: Lagos or Oslo depending on latitude.
const reverseCalls = [];
const places = store => new PlacesService(store, { geoapifyKey: "", fetchImpl: async url => {
  reverseCalls.push(url);
  const lat = Number(new URL(url).searchParams.get("lat"));
  return { ok: true, json: async () => ({ address: lat > 30 ? { city: "Oslo", country: "Norway" } : { city: "Lagos", country: "Nigeria" } }) };
} });

test("long distance: city-level distance, time zones, and the next-visit countdown", async () => {
  const store = new MemoryStore();
  await withServer(createApp({ store, places: places(store), env: {} }), async ({ call }) => {
    const A = newKey(), B = newKey(), t = day();
    const inv = await call(A, "POST", "/api/link/invite");
    await call(B, "POST", "/api/link/redeem", { code: inv.body.code });

    // only one shared so far
    let r = await call(A, "PUT", "/api/us/where", { lat: 6.4281, lon: 3.4219 });
    assert.deepEqual(r.body, { city: "Lagos", country: "Nigeria" });
    let s = (await call(B, "GET", "/api/us?date=" + t)).body;
    assert.equal(s.partner.place.city, "Lagos"); assert.equal(s.apart, null);
    assert.ok(!("lat" in s.partner.place), "coordinates never sent to the partner");
    assert.match(reverseCalls.at(-1), /lat=6\.4&lon=3\.4/, "rounded to ~10 km before leaving the server");

    await call(B, "PUT", "/api/us/where", { lat: 59.9139, lon: 10.7522 });
    s = (await call(A, "GET", "/api/us?date=" + t)).body;
    assert.ok(s.apart.km > 5900 && s.apart.km < 6050, String(s.apart.km));   // Lagos ↔ Oslo ≈ 5,980 km
    assert.equal(s.partner.place.city, "Oslo");

    // time zones
    assert.equal((await call(A, "PUT", "/api/us/tz", { tz: "Africa/Lagos" })).status, 200);
    await call(B, "PUT", "/api/us/tz", { tz: "Europe/Oslo" });
    assert.equal((await call(B, "PUT", "/api/us/tz", { tz: "Mars/Olympus" })).status, 400);
    s = (await call(A, "GET", "/api/us?date=" + t)).body;
    assert.equal(s.me.tz, "Africa/Lagos"); assert.equal(s.partner.tz, "Europe/Oslo");

    // next visit
    assert.equal((await call(A, "PUT", "/api/us/reunion", { date: day(-3), today: t })).status, 400);
    await call(A, "PUT", "/api/us/reunion", { date: day(23), place: "Oslo for Christmas", today: t });
    s = (await call(B, "GET", "/api/us?date=" + t)).body;
    assert.equal(s.reunion.date, day(23)); assert.equal(s.reunion.place, "Oslo for Christmas"); assert.equal(s.visits, 0);

    // stop sharing
    await call(B, "DELETE", "/api/us/where");
    s = (await call(A, "GET", "/api/us?date=" + t)).body;
    assert.equal(s.apart, null); assert.equal(s.partner.place, null);
    assert.equal((await call(newKey(), "PUT", "/api/us/where", { lat: 1, lon: 1 })).status, 403);
  });
});

test("setting the next visit after the last one has passed counts the visit", async () => {
  const store = new MemoryStore();
  let now = Date.now();
  const { CoupleService } = await import("../src/couple.js");
  const svc = new CoupleService(store, { now: () => now });
  const couple = { id: "c1", members: ["a", "b"] };
  const d = n => new Date(now + n * 864e5).toISOString().slice(0, 10);
  await svc.setReunion("a", couple, { date: d(2), today: d(0) });
  now += 5 * 864e5;                                     // the visit has happened
  const r = await svc.setReunion("b", couple, { date: d(30), today: d(0) });
  assert.equal(r.visits, 1);
  await svc.setReunion("b", couple, { date: d(31), today: d(0) });   // just changing an upcoming date
  assert.equal(Number(await store.kv.get(store.key("c", "c1", "visits"))), 1);
  assert.deepEqual(await svc.setVisits(couple, 12), { visits: 12 });
});
