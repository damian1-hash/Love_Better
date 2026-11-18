import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";
import { MemoryStore, RedisStore } from "../src/store.js";
import { coupleStreak } from "../src/couple.js";
import { startFakeUpstash } from "./fake-upstash.js";
import { withServer, newKey } from "./helpers.js";

const day = (n = 0) => new Date(Date.now() + n * 864e5).toISOString().slice(0, 10);

// A fake push service that records what would be sent.
function fakePush() {
  const sent = [];
  return { sent, enabled: true, vapid: { publicKey: "test" }, sendTo: async (uid, msg) => { sent.push({ uid, msg }); return { sent: 1 }; },
    subscribe: async () => {}, unsubscribe: async () => {}, sendDaily: async msg => { sent.push({ all: true, msg }); return { people: 2, sent: 2 }; } };
}

async function linkedPair(call) {
  const A = newKey(), B = newKey();
  await call(A, "PUT", "/api/me", { name: "Ada" });
  await call(B, "PUT", "/api/me", { name: "Ben" });
  const inv = await call(A, "POST", "/api/link/invite");
  await call(B, "POST", "/api/link/redeem", { code: inv.body.code });
  const idA = (await call(A, "GET", "/api/me")).body.id, idB = (await call(B, "GET", "/api/me")).body.id;
  return { A, B, idA, idB };
}

const backends = {
  memory: async () => ({ store: new MemoryStore(), close() {} }),
  redis: async () => { const f = await startFakeUpstash(); return { store: new RedisStore(f), close: f.close }; },
};

for (const [name, make] of Object.entries(backends)) {
  test(`[${name}] everything a couple shares`, async () => {
    const { store, close } = await make();
    const push = fakePush();
    try {
      await withServer(createApp({ store, push, env: {} }), async ({ call }) => {
        const { A, B, idA, idB } = await linkedPair(call);
        const t = day();
        assert.deepEqual(push.sent.map(s => [s.uid, s.msg.tag]), [[idA, "link"]]);
        assert.match(push.sent[0].msg.body, /Ben linked with you/);

        // names
        let s = (await call(A, "GET", "/api/us?date=" + t)).body;
        assert.equal(s.me.name, "Ada"); assert.equal(s.partner.name, "Ben");
        assert.equal(s.together.days, 0);

        // daily question: hidden until both answered
        await call(A, "POST", "/api/us/answer", { date: t, text: "Your laugh" });
        s = (await call(B, "GET", "/api/us?date=" + t)).body;
        assert.equal(s.question.partnerAnswered, true);
        assert.equal(s.question.theirs, null);
        assert.equal(push.sent.at(-1).uid, idB);
        assert.match(push.sent.at(-1).msg.title, /Ada answered/);
        await call(B, "POST", "/api/us/answer", { date: t, text: "Sunday pancakes" });
        assert.match(push.sent.at(-1).msg.title, /Both answers are in/);
        s = (await call(A, "GET", "/api/us?date=" + t)).body;
        assert.equal(s.question.theirs.text, "Sunday pancakes");
        assert.equal(s.question.mine.text, "Your laugh");
        // editing doesn't notify again
        const before = push.sent.length;
        await call(A, "POST", "/api/us/answer", { date: t, text: "Your laugh, always" });
        assert.equal(push.sent.length, before);
        assert.equal((await call(A, "POST", "/api/us/answer", { date: "2020-01-01", text: "x" })).status, 400);
        assert.equal((await call(A, "POST", "/api/us/answer", { date: t, text: "   " })).status, 400);

        // nudges
        await call(B, "POST", "/api/us/nudge", { kind: "hug" });
        assert.match(push.sent.at(-1).msg.title, /Ben sent you a hug/);
        s = (await call(A, "GET", "/api/us?date=" + t)).body;
        assert.equal(s.nudge.kind, "hug");
        assert.equal((await call(B, "GET", "/api/us?date=" + t)).body.nudge, null);
        assert.equal((await call(B, "POST", "/api/us/nudge", { kind: "spam" })).status, 400);

        // practice & couple streak
        await call(A, "PUT", "/api/us/practice", { dates: [day(-2), day(-1), t] });
        await call(B, "PUT", "/api/us/practice", { dates: [day(-1), t, "junk"] });
        s = (await call(A, "GET", "/api/us?date=" + t)).body;
        assert.deepEqual(s.streak, { days: 2, bothToday: true });
        assert.equal(s.partner.practised, true);

        // mood (only today's shows)
        await call(B, "PUT", "/api/us/mood", { date: t, mood: "tired", need: "hug" });
        s = (await call(A, "GET", "/api/us?date=" + t)).body;
        assert.equal(s.partner.mood.mood, "tired"); assert.equal(s.partner.mood.need, "hug");
        assert.equal((await call(B, "PUT", "/api/us/mood", { date: t, mood: "angry" })).status, 400);

        // together since
        await call(A, "PUT", "/api/us/since", { since: "2024-02-14" });
        s = (await call(B, "GET", "/api/us?date=" + t)).body;
        assert.equal(s.together.since, "2024-02-14"); assert.ok(s.together.days > 600);
        assert.equal((await call(A, "PUT", "/api/us/since", { since: "2999-01-01" })).status, 400);

        // special dates
        const d = await call(B, "POST", "/api/us/dates", { title: "Ada's birthday", date: "1995-06-02", yearly: true });
        assert.equal(d.status, 201);
        s = (await call(A, "GET", "/api/us?date=" + t)).body;
        assert.equal(s.dates[0].title, "Ada's birthday");
        await call(A, "DELETE", "/api/us/dates?id=" + d.body.id);
        assert.equal((await call(A, "GET", "/api/us?date=" + t)).body.dates.length, 0);

        // date ideas
        const idea = (await call(A, "POST", "/api/us/ideas", { text: "Picnic in the park" })).body;
        await call(B, "PATCH", "/api/us/ideas", { id: idea.id, done: true });
        s = (await call(A, "GET", "/api/us?date=" + t)).body;
        assert.equal(s.ideas[0].done, true);
        await call(B, "DELETE", "/api/us/ideas?id=" + idea.id);
        assert.equal((await call(A, "GET", "/api/us?date=" + t)).body.ideas.length, 0);

        // love languages
        await call(B, "PUT", "/api/us/lang", { scores: { words: 1, time: 4, gifts: 0, service: 2, touch: 3 } });
        s = (await call(A, "GET", "/api/us?date=" + t)).body;
        assert.equal(s.partner.lang.primary, "time");
        assert.equal((await call(B, "PUT", "/api/us/lang", { scores: { words: 99 } })).status, 400);

        // answer history
        const hist = (await call(A, "GET", "/api/us/answers?date=" + day(1))).body.days;
        assert.equal(hist[0].date, t); assert.equal(hist[0].theirs.text, "Sunday pancakes");

        // XSS-ish text is stored as plain text (the page renders it with textContent)
        await call(A, "POST", "/api/us/ideas", { text: "<img src=x onerror=alert(1)>" });
        assert.equal((await call(B, "GET", "/api/us?date=" + t)).body.ideas[0].text, "<img src=x onerror=alert(1)>");

        // outsiders can't read anything
        assert.equal((await call(newKey(), "GET", "/api/us?date=" + t)).status, 403);

        // unlinking clears the shared data
        await call(A, "DELETE", "/api/link");
        const inv = await call(A, "POST", "/api/link/invite");
        await call(B, "POST", "/api/link/redeem", { code: inv.body.code });
        s = (await call(A, "GET", "/api/us?date=" + t)).body;
        assert.equal(s.ideas.length, 0); assert.equal(s.partner.mood, null); assert.equal(s.together.sinceSet, false);
      });
    } finally { close(); }
  });
}

test("daily cron only runs with the right secret", async () => {
  const push = fakePush();
  await withServer(createApp({ store: new MemoryStore(), push, env: { CRON_SECRET: "s3cret" } }), async ({ base }) => {
    assert.equal((await fetch(base + "/api/cron/daily")).status, 403);
    assert.equal((await fetch(base + "/api/cron/daily", { headers: { Authorization: "Bearer wrong" } })).status, 403);
    const ok = await fetch(base + "/api/cron/daily", { headers: { Authorization: "Bearer s3cret" } });
    assert.equal(ok.status, 200);
    assert.equal(push.sent.at(-1).all, true);
  });
  // Without CRON_SECRET anyone may call it; PushService.sendDaily keeps it to once a day.
  await withServer(createApp({ store: new MemoryStore(), push, env: {} }), async ({ base }) => {
    assert.equal((await fetch(base + "/api/cron/daily")).status, 200);
  });
});

test("couple streak counts days you both practised", () => {
  const t = "2026-11-18";
  assert.deepEqual(coupleStreak(["2026-11-16", "2026-11-17"], ["2026-11-16", "2026-11-17", t], t), { days: 2, bothToday: false });
  assert.deepEqual(coupleStreak(["2026-11-15", "2026-11-17", t], ["2026-11-15", "2026-11-17", t], t), { days: 2, bothToday: true });
  assert.deepEqual(coupleStreak([], [t], t), { days: 0, bothToday: false });
});
