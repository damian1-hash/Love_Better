import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp } from "../src/server.js";

async function withServer(fn) {
  const server = createApp().listen(0);
  await new Promise(r => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  const call = (uid, method, path, body) =>
    fetch(base + path, { method, headers: { "X-User-Id": uid, "Content-Type": "application/json" }, body: body && JSON.stringify(body) })
      .then(async r => ({ status: r.status, body: await r.json() }));
  try { await fn({ base, call }); } finally { server.closeAllConnections(); server.close(); }
}

test("link two partners over HTTP and share presence in the couple room", { timeout: 5000 }, () => withServer(async ({ base, call }) => {
  const invite = await call("a", "POST", "/api/link/invite");
  assert.equal(invite.status, 201);
  const redeem = await call("b", "POST", "/api/link/redeem", { code: invite.body.display });
  assert.equal(redeem.status, 200);
  assert.equal((await call("a", "GET", "/api/link")).body.partnerId, "b");

  // outsiders can't join the room
  assert.equal((await call("x", "POST", "/api/room/presence", { peer: "p", patch: {} })).status, 403);

  const ctrl = new AbortController();
  const res = await fetch(base + "/api/room/events?uid=a&peer=pa", { signal: ctrl.signal });
  const reader = res.body.getReader();
  const resB = await fetch(base + "/api/room/events?uid=b&peer=pb", { signal: ctrl.signal });
  assert.equal(resB.status, 200);
  await call("b", "POST", "/api/room/presence", { peer: "pb", patch: { g: 1, hold: true } });
  let text = "";
  while (!text.includes('"hold":true')) text += new TextDecoder().decode((await reader.read()).value);
  ctrl.abort();

  assert.equal((await call("b", "DELETE", "/api/link")).status, 200);
  assert.equal((await call("a", "GET", "/api/link")).body.linked, false);
}));

test("serves the app and reports errors as JSON", () => withServer(async ({ base, call }) => {
  const page = await fetch(base + "/");
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Link with your partner/);
  const bad = await call("a", "POST", "/api/link/redeem", { code: "nope" });
  assert.equal(bad.status, 400);
  assert.equal(bad.body.error, "invalid_code");
}));
