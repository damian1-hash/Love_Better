import { test } from "node:test";
import assert from "node:assert/strict";
import { MemoryStore } from "../src/store.js";
import { PairingService, CODE_ALPHABET } from "../src/pairing.js";

function setup(opts = {}) {
  let t = 1_000_000;
  const clock = { now: () => t, advance: ms => { t += ms; } };
  const svc = new PairingService(new MemoryStore(), { now: clock.now, ...opts });
  return { svc, clock };
}

test("partner A makes a code, partner B redeems it, both are linked", () => {
  const { svc } = setup();
  const { code, display } = svc.createInvite("alice");
  assert.equal(code.length, 6);
  assert.ok([...code].every(c => CODE_ALPHABET.includes(c)));
  assert.equal(display, code.slice(0, 3) + "-" + code.slice(3));

  const r = svc.redeemInvite("bob", display.toLowerCase());
  assert.equal(r.partnerId, "alice");
  assert.deepEqual(
    [svc.status("alice").partnerId, svc.status("bob").partnerId],
    ["bob", "alice"]);
  assert.equal(svc.status("alice").coupleId, svc.status("bob").coupleId);
});

test("codes are single-use", () => {
  const { svc } = setup();
  const { code } = svc.createInvite("alice");
  svc.redeemInvite("bob", code);
  assert.throws(() => svc.redeemInvite("carol", code), { code: "invalid_code" });
});

test("codes expire", () => {
  const { svc, clock } = setup({ ttlMs: 1000 });
  const { code } = svc.createInvite("alice");
  clock.advance(1001);
  assert.throws(() => svc.redeemInvite("bob", code), { code: "expired_code" });
  assert.equal(svc.status("alice").invite, null);
});

test("can't redeem your own code", () => {
  const { svc } = setup();
  const { code } = svc.createInvite("alice");
  assert.throws(() => svc.redeemInvite("alice", code), { code: "own_code" });
});

test("a new code replaces the old one", () => {
  const { svc } = setup();
  const first = svc.createInvite("alice").code;
  const second = svc.createInvite("alice").code;
  assert.notEqual(first, second);
  assert.throws(() => svc.redeemInvite("bob", first), { code: "invalid_code" });
  svc.redeemInvite("bob", second);
});

test("nobody can be in two couples", () => {
  const { svc } = setup();
  const a = svc.createInvite("alice").code;
  const c = svc.createInvite("carol").code;
  svc.redeemInvite("bob", a);
  assert.throws(() => svc.createInvite("bob"), { code: "already_linked" });
  assert.throws(() => svc.redeemInvite("alice", c), { code: "already_linked" });
});

test("redeeming clears the redeemer's own pending code", () => {
  const { svc } = setup();
  const a = svc.createInvite("alice").code;
  const b = svc.createInvite("bob").code;
  svc.redeemInvite("bob", a);
  assert.throws(() => svc.redeemInvite("carol", b), { code: "invalid_code" });
});

test("unlink frees both partners", () => {
  const { svc } = setup();
  svc.redeemInvite("bob", svc.createInvite("alice").code);
  svc.unlink("bob");
  assert.equal(svc.status("alice").linked, false);
  assert.equal(svc.status("bob").linked, false);
  assert.throws(() => svc.unlink("alice"), { code: "not_linked" });
  svc.redeemInvite("alice", svc.createInvite("bob").code);
});

test("too many wrong guesses locks code entry, then unlocks", () => {
  const { svc, clock } = setup({ maxFailures: 3, failureWindowMs: 60_000 });
  const { code } = svc.createInvite("alice");
  for (let i = 0; i < 3; i++) assert.throws(() => svc.redeemInvite("mallory", "ZZZZZZ"));
  assert.throws(() => svc.redeemInvite("mallory", code), { code: "too_many_attempts" });
  clock.advance(60_001);
  svc.redeemInvite("mallory", code);
});

test("requires a user id", () => {
  const { svc } = setup();
  assert.throws(() => svc.createInvite(""), { code: "unauthenticated" });
});
