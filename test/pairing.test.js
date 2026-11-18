import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore, RedisStore } from "../src/store.js";
import { PairingService, CODE_ALPHABET } from "../src/pairing.js";
import { startFakeUpstash } from "./fake-upstash.js";

// Run every rule against both storage backends.
const backends = {
  memory: async () => ({ store: new MemoryStore(), close() {} }),
  redis: async () => { const f = await startFakeUpstash(); return { store: new RedisStore(f), close: f.close }; },
};

for (const [name, make] of Object.entries(backends)) {
  async function setup(opts = {}) {
    let t = Date.now();
    const clock = { now: () => t, advance: ms => { t += ms; } };
    const { store, close } = await make();
    return { svc: new PairingService(store, { now: clock.now, ...opts }), clock, close };
  }
  const it = (title, fn) => test(`[${name}] ${title}`, async () => {
    const ctx = await setup(fn.opts);
    try { await fn(ctx); } finally { ctx.close(); }
  });
  const withOpts = (opts, fn) => Object.assign(fn, { opts });

  it("partner A makes a code, partner B redeems it, both are linked", async ({ svc }) => {
    const { code, display } = await svc.createInvite("alice");
    assert.equal(code.length, 6);
    assert.ok([...code].every(c => CODE_ALPHABET.includes(c)));
    assert.equal(display, code.slice(0, 3) + "-" + code.slice(3));
    const r = await svc.redeemInvite("bob", display.toLowerCase());
    assert.equal(r.partnerId, "alice");
    assert.equal((await svc.status("alice")).partnerId, "bob");
    assert.equal((await svc.status("bob")).partnerId, "alice");
    assert.equal((await svc.status("alice")).coupleId, (await svc.status("bob")).coupleId);
  });

  it("codes are single-use", async ({ svc }) => {
    const { code } = await svc.createInvite("alice");
    await svc.redeemInvite("bob", code);
    await assert.rejects(svc.redeemInvite("carol", code), { code: "invalid_code" });
  });

  it("codes expire", withOpts({ ttlMs: 60_000 }, async ({ svc, clock }) => {
    const { code } = await svc.createInvite("alice");
    clock.advance(60_001);
    await assert.rejects(svc.redeemInvite("bob", code), { code: "expired_code" });
    assert.equal((await svc.status("alice")).invite, null);
  }));

  it("can't redeem your own code", async ({ svc }) => {
    const { code } = await svc.createInvite("alice");
    await assert.rejects(svc.redeemInvite("alice", code), { code: "own_code" });
  });

  it("a new code replaces the old one", async ({ svc }) => {
    const first = (await svc.createInvite("alice")).code;
    const second = (await svc.createInvite("alice")).code;
    assert.notEqual(first, second);
    await assert.rejects(svc.redeemInvite("bob", first), { code: "invalid_code" });
    await svc.redeemInvite("bob", second);
  });

  it("nobody can be in two couples", async ({ svc }) => {
    const a = (await svc.createInvite("alice")).code;
    const c = (await svc.createInvite("carol")).code;
    await svc.redeemInvite("bob", a);
    await assert.rejects(svc.createInvite("bob"), { code: "already_linked" });
    await assert.rejects(svc.redeemInvite("alice", c), { code: "already_linked" });
  });

  it("two people racing for one code: only one wins", async ({ svc }) => {
    const { code } = await svc.createInvite("alice");
    const results = await Promise.allSettled([svc.redeemInvite("bob", code), svc.redeemInvite("carol", code)]);
    assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  });

  it("redeeming clears the redeemer's own pending code", async ({ svc }) => {
    const a = (await svc.createInvite("alice")).code;
    const b = (await svc.createInvite("bob")).code;
    await svc.redeemInvite("bob", a);
    await assert.rejects(svc.redeemInvite("carol", b), { code: "invalid_code" });
  });

  it("unlink frees both partners", async ({ svc }) => {
    await svc.redeemInvite("bob", (await svc.createInvite("alice")).code);
    await svc.unlink("bob");
    assert.equal((await svc.status("alice")).linked, false);
    assert.equal((await svc.status("bob")).linked, false);
    await assert.rejects(svc.unlink("alice"), { code: "not_linked" });
    await svc.redeemInvite("alice", (await svc.createInvite("bob")).code);
  });

  it("too many wrong guesses locks code entry, then unlocks", withOpts({ maxFailures: 3, failureWindowMs: 60_000 }, async ({ svc, clock }) => {
    const { code } = await svc.createInvite("alice");
    for (let i = 0; i < 3; i++) await assert.rejects(svc.redeemInvite("mallory", "ZZZZZZ"));
    await assert.rejects(svc.redeemInvite("mallory", code), { code: "too_many_attempts" });
    clock.advance(60_001);
    await svc.redeemInvite("mallory", code);
  }));

  it("requires a user id", async ({ svc }) => {
    await assert.rejects(svc.createInvite(""), { code: "unauthenticated" });
  });
}
