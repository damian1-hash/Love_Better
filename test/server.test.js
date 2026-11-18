import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";
import { RedisStore } from "../src/store.js";
import vercelHandler from "../src/api.js";
import { startFakeUpstash } from "./fake-upstash.js";
import { createServer } from "node:http";

async function withServer(server, fn) {
  server.listen(0);
  await new Promise(r => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const call = (uid, method, path, body) =>
    fetch(base + path, { method, headers: { "X-User-Id": uid, "Content-Type": "application/json" }, body: body && JSON.stringify(body) })
      .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  try { await fn({ base, call }); } finally { server.closeAllConnections(); server.close(); }
}

async function linkAndShareRoom({ call }) {
  const invite = await call("a", "POST", "/api/link/invite");
  assert.equal(invite.status, 201);
  assert.equal((await call("b", "POST", "/api/link/redeem", { code: invite.body.display })).status, 200);
  assert.equal((await call("a", "GET", "/api/link")).body.partnerId, "b");

  // outsiders can't see or post to the room
  assert.equal((await call("x", "GET", "/api/room?peer=px")).status, 403);
  assert.equal((await call("x", "POST", "/api/room/presence", { peer: "pa", presence: {} })).status, 403);

  await call("a", "GET", "/api/room?peer=pa");
  await call("b", "POST", "/api/room/presence", { peer: "pb", presence: { g: 1, hold: true } });
  const seen = await call("a", "GET", "/api/room?peer=pa");
  assert.deepEqual(seen.body.peers.find(p => p.peer === "pb").presence, { g: 1, hold: true });
  assert.ok(seen.body.peers.some(p => p.peer === "pa"));

  // can't take over your partner's peer id
  assert.equal((await call("a", "POST", "/api/room/presence", { peer: "pb", presence: { hold: false } })).status, 403);

  assert.equal((await call("b", "DELETE", "/api/link")).status, 200);
  assert.equal((await call("a", "GET", "/api/link")).body.linked, false);
  assert.equal((await call("a", "GET", "/api/room?peer=pa")).status, 403);
}

test("local server: link two partners and share presence", () => withServer(createApp(), linkAndShareRoom));

test("local server on Redis: same flow", async () => {
  const f = await startFakeUpstash();
  try { await withServer(createApp({ store: new RedisStore(f) }), linkAndShareRoom); } finally { f.close(); }
});

test("serves the app and reports errors as JSON", () => withServer(createApp(), async ({ base, call }) => {
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Link with your partner/);
  const bad = await call("a", "POST", "/api/link/redeem", { code: "nope" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "invalid_code");
}));

test("Vercel function explains the missing database instead of failing silently", async () => {
  const saved = { ...process.env };
  for (const k of ["KV_REST_API_URL", "KV_REST_API_TOKEN", "UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"]) delete process.env[k];
  try {
    await withServer(createServer(vercelHandler), async ({ call }) => {
      const r = await call("a", "GET", "/api/link");
      assert.equal(r.status, 503);
      assert.equal(r.body.error, "setup_required");
    });
  } finally { Object.assign(process.env, saved); }
});

test("Vercel function works with a pre-parsed body", async () => {
  const f = await startFakeUpstash();
  process.env.KV_REST_API_URL = f.url; process.env.KV_REST_API_TOKEN = f.token;
  // Vercel parses JSON bodies onto req.body before the function runs.
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    req.body = raw ? JSON.parse(raw) : undefined;
    return vercelHandler(req, res);
  });
  try {
    await withServer(server, async ({ call }) => {
      const inv = await call("a", "POST", "/api/link/invite");
      assert.equal(inv.status, 201);
      assert.equal((await call("b", "POST", "/api/link/redeem", { code: inv.body.code })).status, 200);
    });
  } finally { delete process.env.KV_REST_API_URL; delete process.env.KV_REST_API_TOKEN; f.close(); }
});

test("a check-in landing at the same time as a presence update never erases it", async () => {
  const f = await startFakeUpstash();
  try {
    await withServer(createApp({ store: new RedisStore(f) }), async ({ call }) => {
      const inv = await call("a", "POST", "/api/link/invite");
      await call("b", "POST", "/api/link/redeem", { code: inv.body.code });
      for (let i = 0; i < 20; i++) {
        await Promise.all([
          call("a", "GET", "/api/room?peer=pa"),
          call("a", "POST", "/api/room/presence", { peer: "pa", presence: { g: 1, n: i } }),
          call("a", "GET", "/api/room?peer=pa"),
        ]);
        const seen = await call("b", "GET", "/api/room?peer=pb");
        assert.deepEqual(seen.body.peers.find(p => p.peer === "pa").presence, { g: 1, n: i });
      }
    });
  } finally { f.close(); }
});
