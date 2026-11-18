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

// A tiny valid JPEG (1×1) as a data URL.
const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

test("status, notes, letters, photos, play together and date night", async () => {
  const store = new MemoryStore(), sent = [];
  const push = { enabled: true, getVapid: async () => ({ publicKey: "k" }), sendTo: async (uid, msg) => { sent.push({ uid, msg }); return { sent: 1 }; }, subscribe: async () => {}, unsubscribe: async () => {}, sendDaily: async () => ({}) };
  await withServer(createApp({ store, push, places: places(store), env: {} }), async ({ call, base }) => {
    const A = newKey(), B = newKey(), t = day();
    await call(A, "PUT", "/api/me", { name: "Ada" });
    const inv = await call(A, "POST", "/api/link/invite");
    await call(B, "POST", "/api/link/redeem", { code: inv.body.code });
    const idB = (await call(B, "GET", "/api/me")).body.id;
    const us = async k => (await call(k, "GET", "/api/us?date=" + t)).body.ldr;

    // status
    await call(A, "PUT", "/api/us/status", { state: "free" });
    assert.equal((await us(B)).status.partner.state, "free");
    assert.equal((await call(A, "PUT", "/api/us/status", { state: "partying" })).status, 400);

    // notes: now → pushed + visible; wake → waiting until 07:00 their time; good night sets asleep
    await call(B, "PUT", "/api/us/tz", { tz: "Pacific/Kiritimati" });   // UTC+14: almost never already 07:00
    await call(A, "POST", "/api/us/notes", { kind: "love", text: "Miss you", when: "now" });
    assert.equal(sent.at(-1).uid, idB); assert.match(sent.at(-1).msg.title, /A note from Ada/);
    let L = await us(B);
    assert.equal(L.notes.toMe[0].text, "Miss you");
    const n = sent.length;
    const w = (await call(A, "POST", "/api/us/notes", { kind: "morning", text: "Morning!", when: "wake" })).body;
    if (w.deliverAt > Date.now() + 60000) {
      assert.equal(sent.length, n, "no push for a note that's waiting");
      assert.ok(!(await us(B)).notes.toMe.some(x => x.text === "Morning!"), "not visible before their morning");
      assert.ok((await us(A)).notes.fromMe.some(x => x.text === "Morning!"));
    }
    await call(A, "POST", "/api/us/notes", { kind: "night", text: "Night night", when: "now" });
    assert.equal((await us(B)).status.partner.state, "asleep");

    // letters: sealed until opened; date-locked ones can't be opened early; author learns it was opened
    const l1 = (await call(A, "POST", "/api/us/letters", { title: "Open when you miss me", body: "I'm right here." })).body;
    const l2 = (await call(A, "POST", "/api/us/letters", { title: "Open on our anniversary", body: "Happy anniversary!", unlockDate: day(30) })).body;
    assert.match(sent.at(-1).msg.title, /Ada wrote you a letter/);
    L = await us(B);
    const inbox = Object.fromEntries(L.letters.toMe.map(x => [x.id, x]));
    assert.equal(inbox[l1.id].body, null, "sealed"); assert.equal(inbox[l2.id].locked, true);
    assert.equal((await call(B, "POST", "/api/us/letters/open", { id: l2.id, today: t })).status, 423);
    assert.equal((await call(A, "POST", "/api/us/letters/open", { id: l1.id, today: t })).status, 404, "only the recipient opens it");
    const opened = await call(B, "POST", "/api/us/letters/open", { id: l1.id, today: t });
    assert.equal(opened.body.body, "I'm right here.");
    assert.match(sent.at(-1).msg.title, /opened your letter/);
    assert.ok((await us(A)).letters.fromMe.find(x => x.id === l1.id).openedAt);

    // photos: stored privately, fetched with your key, only the sharer can delete
    const ph = await call(B, "POST", "/api/us/photos", { data: JPEG, caption: "My view", w: 1, h: 1 });
    assert.equal(ph.status, 201);
    assert.equal((await us(A)).photos[0].caption, "My view");
    const img = await fetch(base + "/api/us/photo?id=" + ph.body.id, { headers: { Authorization: "Bearer " + A } });
    assert.equal(img.status, 200); assert.equal(img.headers.get("content-type"), "image/jpeg");
    assert.deepEqual([...new Uint8Array(await img.arrayBuffer())].slice(0, 2), [0xff, 0xd8]);
    assert.equal((await fetch(base + "/api/us/photo?id=" + ph.body.id)).status, 401);
    assert.equal((await fetch(base + "/api/us/photo?id=" + ph.body.id, { headers: { Authorization: "Bearer " + newKey() } })).status, 403);
    assert.equal((await call(A, "DELETE", "/api/us/photos?id=" + ph.body.id)).status, 403);
    assert.equal((await call(B, "POST", "/api/us/photos", { data: "data:text/html;base64,PGgxPg==" })).status, 400);
    assert.equal((await call(B, "POST", "/api/us/photos", { data: "data:image/jpeg;base64," + "A".repeat(600000) })).status, 413);

    // press play together
    const s = (await call(A, "POST", "/api/us/sync", { title: "Our film", delay: 30 })).body;
    L = await us(B);
    assert.equal(L.sync.title, "Our film"); assert.ok(Math.abs(L.sync.startAt - L.serverNow - 30000) < 2000);
    assert.match(sent.at(-1).msg.title, /Press play together/);
    await call(B, "DELETE", "/api/us/sync");
    assert.equal((await us(A)).sync, null);

    // date night
    const at = Date.now() + 2 * 864e5;
    await call(B, "PUT", "/api/us/datenight", { at, idea: "Cook the same recipe on video" });
    assert.equal((await us(A)).datenight.at, at);
    assert.equal((await call(B, "PUT", "/api/us/datenight", { at: Date.now() + 400 * 864e5 })).status, 400);

    // unlinking removes it all
    await call(A, "DELETE", "/api/link");
    const inv2 = await call(A, "POST", "/api/link/invite"); await call(B, "POST", "/api/link/redeem", { code: inv2.body.code });
    L = await us(A);
    assert.deepEqual([L.photos.length, L.letters.toMe.length, L.notes.toMe.length, L.datenight, L.status.partner], [0, 0, 0, null, null]);
    assert.equal(Object.keys(store.kv.m).filter(k => k.includes(":photo:")).length, 0, "photo data deleted too");
  });
});
