import { test } from "node:test";
import assert from "node:assert/strict";
import { createECDH, createDecipheriv, hkdfSync, randomBytes, createPublicKey, verify } from "node:crypto";
import { encryptPayload, sendPush, generateVapidKeys, PushService } from "../src/push.js";
import { MemoryStore } from "../src/store.js";

const b64u = b => Buffer.from(b).toString("base64url");

// What a browser does with an incoming push (RFC 8291), to prove we encrypt correctly.
function browser() {
  const ecdh = createECDH("prime256v1"); ecdh.generateKeys();
  const auth = randomBytes(16);
  return {
    sub: { endpoint: "https://push.example.com/send/abc", keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } },
    decrypt(body) {
      const salt = body.subarray(0, 16), idlen = body[20], asPublic = body.subarray(21, 21 + idlen), ct = body.subarray(21 + idlen);
      const secret = ecdh.computeSecret(asPublic);
      const ikm = Buffer.from(hkdfSync("sha256", secret, auth, Buffer.concat([Buffer.from("WebPush: info\0"), ecdh.getPublicKey(), asPublic]), 32));
      const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
      const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
      const d = createDecipheriv("aes-128-gcm", cek, nonce);
      d.setAuthTag(ct.subarray(ct.length - 16));
      const plain = Buffer.concat([d.update(ct.subarray(0, ct.length - 16)), d.final()]);
      assert.equal(plain[plain.length - 1], 2); // last-record delimiter
      return plain.subarray(0, -1).toString();
    },
  };
}

test("push payloads decrypt the way a browser decrypts them", () => {
  const b = browser();
  const msg = JSON.stringify({ title: "Ada misses you 🥺", body: "hi" });
  assert.equal(b.decrypt(encryptPayload(b.sub, msg)), msg);
});

test("sendPush signs a valid VAPID token and sends the right headers", async () => {
  const vapid = generateVapidKeys(), b = browser();
  let captured;
  const fetchImpl = async (url, init) => { captured = { url, init }; return { status: 201 }; };
  const r = await sendPush(b.sub, { title: "t" }, vapid, { fetchImpl, subject: "https://example.org" });
  assert.equal(r.status, 201);
  assert.equal(captured.url, b.sub.endpoint);
  const h = captured.init.headers;
  assert.equal(h["Content-Encoding"], "aes128gcm");
  assert.equal(JSON.parse(b.decrypt(captured.init.body)).title, "t");
  const m = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(h.Authorization);
  assert.ok(m, h.Authorization);
  const claims = JSON.parse(Buffer.from(m[2], "base64url"));
  assert.equal(claims.aud, "https://push.example.com");
  assert.equal(claims.sub, "https://example.org");
  assert.equal(m[4], vapid.publicKey);
  const raw = Buffer.from(vapid.publicKey, "base64url");
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(m[1] + "." + m[2]), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(m[3], "base64url")));
});

test("subscriptions that the push service says are gone get removed", async () => {
  const vapid = generateVapidKeys(), store = new MemoryStore();
  let status = 201;
  const svc = new PushService(store, { vapid, fetchImpl: async () => ({ status }) });
  await svc.subscribe("u1", browser().sub);
  assert.deepEqual(await svc.sendTo("u1", { title: "x" }), { sent: 1 });
  assert.deepEqual(await svc.sendToEveryone({ title: "x" }), { people: 1, sent: 1 });
  status = 410;
  assert.deepEqual(await svc.sendTo("u1", { title: "x" }), { sent: 0 });
  assert.equal(Object.keys(await store.kv.hgetall(store.key("push", "u1"))).length, 0);
  await assert.rejects(svc.subscribe("u1", { endpoint: "http://insecure", keys: {} }));
});
