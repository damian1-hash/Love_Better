// Web Push (RFC 8291 message encryption + RFC 8292 VAPID), using only
// node:crypto. Works with the push services browsers use (Google, Mozilla,
// Apple).
//
// Keys: if VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are set they're used;
// otherwise the server makes a key pair once and keeps it in the database,
// so notifications work with no setup. VAPID_SUBJECT is optional.

import { createECDH, createHash, createPrivateKey, createCipheriv, hkdfSync, randomBytes, sign, generateKeyPairSync } from "node:crypto";

const b64u = buf => Buffer.from(buf).toString("base64url");
const unb64u = s => Buffer.from(String(s), "base64url");

export function generateVapidKeys() {
  const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const pub = publicKey.export({ format: "jwk" }), priv = privateKey.export({ format: "jwk" });
  return { publicKey: b64u(Buffer.concat([Buffer.from([4]), unb64u(pub.x), unb64u(pub.y)])), privateKey: priv.d };
}

export function vapidFromEnv(env = process.env) {
  const publicKey = env.VAPID_PUBLIC_KEY, privateKey = env.VAPID_PRIVATE_KEY;
  if (!publicKey || !privateKey) return null;
  const raw = unb64u(publicKey);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error("VAPID_PUBLIC_KEY must be an uncompressed P-256 key (base64url).");
  return { publicKey, privateKey, subject: env.VAPID_SUBJECT || null };
}

function vapidHeader(endpoint, vapid, subjectFallback) {
  const aud = new URL(endpoint).origin;
  const raw = unb64u(vapid.publicKey);
  const key = createPrivateKey({ key: { kty: "EC", crv: "P-256", d: vapid.privateKey, x: b64u(raw.subarray(1, 33)), y: b64u(raw.subarray(33)) }, format: "jwk" });
  const header = b64u(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const payload = b64u(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: vapid.subject || subjectFallback || "https://love-better.app" }));
  const sig = sign("sha256", Buffer.from(header + "." + payload), { key, dsaEncoding: "ieee-p1363" });
  return "vapid t=" + header + "." + payload + "." + b64u(sig) + ", k=" + vapid.publicKey;
}

// Encrypt a payload for one subscription (aes128gcm content coding).
export function encryptPayload(subscription, plaintext, { salt = randomBytes(16), ecdh = createECDH("prime256v1") } = {}) {
  const uaPublic = unb64u(subscription.keys.p256dh), authSecret = unb64u(subscription.keys.auth);
  if (!ecdh.getPublicKey) throw new Error("bad ecdh");
  try { ecdh.getPrivateKey(); } catch { ecdh.generateKeys(); }
  const asPublic = ecdh.getPublicKey();
  const secret = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(hkdfSync("sha256", secret, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(plaintext), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4); rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

export async function sendPush(subscription, message, vapid, { fetchImpl = fetch, ttl = 24 * 3600, urgency = "normal", subject } = {}) {
  const body = encryptPayload(subscription, JSON.stringify(message));
  const res = await fetchImpl(subscription.endpoint, {
    method: "POST",
    headers: {
      Authorization: vapidHeader(subscription.endpoint, vapid, subject),
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: String(ttl),
      Urgency: urgency,
    },
    body,
  });
  return { status: res.status, gone: res.status === 404 || res.status === 410 };
}

const subId = endpoint => createHash("sha256").update(endpoint).digest("hex").slice(0, 24);

// Stores each person's subscriptions (one per device) and sends to them.
export const DEFAULT_SUBJECT = "https://love-better.vercel.app";

export class PushService {
  constructor(store, { vapid = vapidFromEnv(), fetchImpl = fetch, autoKeys = true } = {}) {
    this.store = store; this.kv = store.kv; this.vapid = vapid; this.fetch = fetchImpl; this.autoKeys = autoKeys;
  }
  get enabled() { return !!this.vapid || this.autoKeys; }

  // The key pair to sign with: from the environment, or made once and stored.
  async getVapid() {
    if (this.vapid) return this.vapid;
    if (!this.autoKeys) return null;
    const k = this.store.key("vapid");
    let saved = JSON.parse((await this.kv.get(k)) || "null");
    if (!saved) {
      await this.kv.set(k, JSON.stringify(generateVapidKeys()), { nx: true });   // first one wins
      saved = JSON.parse(await this.kv.get(k));
    }
    this.vapid = { ...saved, subject: process.env.VAPID_SUBJECT || null };
    return this.vapid;
  }

  static validate(sub) {
    let ok = false;
    try {
      const u = new URL(sub.endpoint);
      ok = u.protocol === "https:" && unb64u(sub.keys.p256dh).length === 65 && unb64u(sub.keys.auth).length >= 16;
    } catch {}
    if (!ok) throw Object.assign(new Error("bad subscription"), { bad: true });
    return { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } };
  }
  async subscribe(uid, sub) {
    const clean = PushService.validate(sub);
    const k = this.store.key("push", uid);
    if ((await this.kv.hlen(k)) >= 10) {
      const all = await this.kv.hgetall(k);
      await this.kv.hdel(k, ...Object.keys(all).slice(0, 5));
    }
    await this.kv.hset(k, subId(clean.endpoint), JSON.stringify(clean));
    await this.kv.hset(this.store.key("push_all"), uid, "1");
  }
  async unsubscribe(uid, endpoint) {
    await this.kv.hdel(this.store.key("push", uid), subId(String(endpoint)));
  }
  async sendTo(uid, message, opts = {}) {
    const vapid = await this.getVapid();
    if (!vapid) return { sent: 0 };
    const k = this.store.key("push", uid), subs = await this.kv.hgetall(k);
    let sent = 0;
    await Promise.all(Object.entries(subs).map(async ([id, raw]) => {
      try {
        const r = await sendPush(JSON.parse(raw), message, vapid, { fetchImpl: this.fetch, subject: DEFAULT_SUBJECT, ...opts });
        if (r.gone) await this.kv.hdel(k, id);
        else if (r.status < 300) sent++;
      } catch (e) { console.error("push failed", e.message); }
    }));
    if (!Object.keys(subs).length) await this.kv.hdel(this.store.key("push_all"), uid);
    return { sent };
  }
  // The daily reminder: at most once every 20 hours, whoever asks.
  async sendDaily(message, opts) {
    if (!(await this.kv.set(this.store.key("daily_sent"), Date.now(), { ex: 20 * 3600, nx: true }))) return { skipped: "already sent today" };
    return this.sendToEveryone(message, opts);
  }
  async sendToEveryone(message, opts) {
    const uids = Object.keys(await this.kv.hgetall(this.store.key("push_all")));
    let sent = 0;
    for (let i = 0; i < uids.length; i += 20) {
      const res = await Promise.all(uids.slice(i, i + 20).map(u => this.sendTo(u, message, opts)));
      sent += res.reduce((n, r) => n + r.sent, 0);
    }
    return { people: uids.length, sent };
  }
}
