import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";
import { RedisStore, MemoryStore } from "../src/store.js";
import vercelHandler, { createHandler } from "../src/api.js";
import { startFakeUpstash } from "./fake-upstash.js";
import { withServer, newKey, createServer } from "./helpers.js";

const A = newKey(), B = newKey(), X = newKey();

async function linkAndShareRoom({ call }) {
  const invite = await call(A, "POST", "/api/link/invite");
  assert.equal(invite.status, 201);
  assert.equal((await call(B, "POST", "/api/link/redeem", { code: invite.body.display })).status, 200);
  const me = (await call(A, "GET", "/api/me")).body;
  assert.equal(me.link.linked, true);
  assert.match(me.link.partnerId, /^u_[0-9a-f]{32}$/);

  // outsiders can't see or post to the room
  assert.equal((await call(X, "GET", "/api/room?peer=px")).status, 403);
  assert.equal((await call(X, "POST", "/api/room/presence", { peer: "pa", presence: {} })).status, 403);

  await call(A, "GET", "/api/room?peer=pa");
  await call(B, "POST", "/api/room/presence", { peer: "pb", presence: { g: 1, hold: true } });
  const seen = await call(A, "GET", "/api/room?peer=pa");
  assert.deepEqual(seen.body.peers.find(p => p.peer === "pb").presence, { g: 1, hold: true });

  // can't take over your partner's game screen
  assert.equal((await call(A, "POST", "/api/room/presence", { peer: "pb", presence: { hold: false } })).status, 403);

  assert.equal((await call(B, "DELETE", "/api/link")).status, 200);
  assert.equal((await call(A, "GET", "/api/link")).body.linked, false);
  assert.equal((await call(A, "GET", "/api/room?peer=pa")).status, 403);
}

test("local server: link two partners and share presence", () => withServer(createApp({ store: new MemoryStore() }), linkAndShareRoom));

test("local server on Redis: same flow", async () => {
  const f = await startFakeUpstash();
  try { await withServer(createApp({ store: new RedisStore(f) }), linkAndShareRoom); } finally { f.close(); }
});

test("requests need a valid sign-in key; knowing someone's id isn't enough", () => withServer(createApp({ store: new MemoryStore() }), async ({ call, base }) => {
  assert.equal((await call(null, "GET", "/api/me")).status, 401);
  assert.equal((await call("not-a-key", "GET", "/api/me")).status, 401);
  const id = (await call(A, "GET", "/api/me")).body.id;
  const r = await fetch(base + "/api/me", { headers: { Authorization: "Bearer " + id, "X-User-Id": id } });
  assert.equal(r.status, 401);
  // keys are forgiving about case, dashes and look-alike characters
  const pretty = A.toLowerCase().match(/.{1,5}/g).join("-");
  assert.equal((await call(pretty, "GET", "/api/me")).body.id, id);
}));

test("serves the app and reports errors as JSON", () => withServer(createApp({ store: new MemoryStore() }), async ({ base, call }) => {
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /app\.js/);
  assert.equal((await fetch(base + "/manifest.webmanifest")).headers.get("content-type"), "application/manifest+json");
  const bad = await call(A, "POST", "/api/link/redeem", { code: "nope" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "invalid_code");
}));

test("Vercel rewrite form (/api/index?path=...) routes the same", () => withServer(createServer(createHandler({ store: new MemoryStore() })), async ({ call }) => {
  const r = await call(A, "POST", "/api/index?path=link/invite");
  assert.equal(r.status, 201);
  const s = await call(A, "GET", "/api/index?path=link");
  assert.equal(s.body.invite.code, r.body.code);
  const room = await call(A, "GET", "/api/index?path=room&peer=p1");
  assert.equal(room.status, 403); // not linked yet, but routed
}));

test("Vercel function explains the missing database instead of failing silently", async () => {
  const saved = { ...process.env };
  for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) delete process.env[k];
  try {
    await withServer(createServer(vercelHandler), async ({ call }) => {
      const r = await call(A, "GET", "/api/me");
      assert.equal(r.status, 503);
      assert.equal(r.body.error, "setup_required");
    });
  } finally { Object.assign(process.env, saved); }
});

test("a check-in landing at the same time as a presence update never erases it", async () => {
  const f = await startFakeUpstash();
  try {
    await withServer(createApp({ store: new RedisStore(f) }), async ({ call }) => {
      const inv = await call(A, "POST", "/api/link/invite");
      await call(B, "POST", "/api/link/redeem", { code: inv.body.code });
      for (let i = 0; i < 20; i++) {
        await Promise.all([
          call(A, "GET", "/api/room?peer=pa"),
          call(A, "POST", "/api/room/presence", { peer: "pa", presence: { g: 1, n: i } }),
          call(A, "GET", "/api/room?peer=pa"),
        ]);
        const seen = await call(B, "GET", "/api/room?peer=pb");
        assert.deepEqual(seen.body.peers.find(p => p.peer === "pa").presence, { g: 1, n: i });
      }
    });
  } finally { f.close(); }
});
