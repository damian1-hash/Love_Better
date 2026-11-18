// Minimal key-value layer with the few Redis commands the app needs.
//   MemoryKV – in-process, for local runs and tests (lost on restart)
//   RedisKV  – Upstash Redis over its REST API (used on Vercel)

export class MemoryKV {
  constructor() { this.m = new Map(); }
  #live(k) {
    const e = this.m.get(k);
    if (e && e.exp && e.exp <= Date.now()) { this.m.delete(k); return null; }
    return e ?? null;
  }
  #hash(k) {
    let e = this.#live(k);
    if (!e) { e = { v: new Map(), exp: 0 }; this.m.set(k, e); }
    return e.v;
  }
  async get(k) { return this.#live(k)?.v ?? null; }
  async set(k, v, { px, ex, nx } = {}) {
    if (nx && this.#live(k)) return false;
    this.m.set(k, { v: String(v), exp: px ? Date.now() + px : ex ? Date.now() + ex * 1000 : 0 });
    return true;
  }
  async getdel(k) { const v = this.#live(k)?.v ?? null; this.m.delete(k); return v; }
  async del(...ks) { for (const k of ks) this.m.delete(k); }
  async expire(k, sec) { const e = this.#live(k); if (e) e.exp = Date.now() + sec * 1000; }
  async hget(k, f) { return this.#live(k)?.v.get(f) ?? null; }
  async hset(k, f, v) { this.#hash(k).set(f, String(v)); }
  async hsetnx(k, f, v) { const h = this.#hash(k); if (h.has(f)) return false; h.set(f, String(v)); return true; }
  async hdel(k, ...fs) { const e = this.#live(k); if (e) for (const f of fs) e.v.delete(f); }
  async hgetall(k) { return Object.fromEntries(this.#live(k)?.v ?? []); }
  async hlen(k) { return this.#live(k)?.v.size ?? 0; }
  async incr(k) { const n = (Number(this.#live(k)?.v) || 0) + 1; const e = this.#live(k); this.m.set(k, { v: String(n), exp: e ? e.exp : 0 }); return n; }
  async mget(...ks) { return ks.map(k => { const e = this.#live(k); return e && typeof e.v === "string" ? e.v : null; }); }
}

export class RedisKV {
  constructor({ url, token, fetchImpl = fetch }) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
    this.fetch = fetchImpl;
  }
  async cmd(...args) {
    const res = await this.fetch(this.url, {
      method: "POST",
      headers: { Authorization: "Bearer " + this.token, "Content-Type": "application/json" },
      body: JSON.stringify(args.map(String)),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.error) throw new Error("Redis error: " + (data.error || res.status));
    return data.result;
  }
  async get(k) { return this.cmd("GET", k); }
  async set(k, v, { px, ex, nx } = {}) {
    const a = ["SET", k, v];
    if (px) a.push("PX", Math.max(1, Math.round(px)));
    else if (ex) a.push("EX", Math.max(1, Math.round(ex)));
    if (nx) a.push("NX");
    return (await this.cmd(...a)) === "OK";
  }
  async getdel(k) { return this.cmd("GETDEL", k); }
  async del(...ks) { if (ks.length) await this.cmd("DEL", ...ks); }
  async expire(k, sec) { await this.cmd("EXPIRE", k, sec); }
  async hget(k, f) { return this.cmd("HGET", k, f); }
  async hset(k, f, v) { await this.cmd("HSET", k, f, v); }
  async hsetnx(k, f, v) { return (await this.cmd("HSETNX", k, f, v)) === 1; }
  async hdel(k, ...fs) { if (fs.length) await this.cmd("HDEL", k, ...fs); }
  async hgetall(k) {
    const flat = (await this.cmd("HGETALL", k)) ?? [];
    const out = {};
    for (let i = 0; i < flat.length; i += 2) out[flat[i]] = flat[i + 1];
    return out;
  }
  async hlen(k) { return this.cmd("HLEN", k); }
  async incr(k) { return Number(await this.cmd("INCR", k)); }
  async mget(...ks) { return ks.length ? this.cmd("MGET", ...ks) : []; }
}

export function redisConfigFromEnv(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

export function createKV(env = process.env) {
  const cfg = redisConfigFromEnv(env);
  return cfg ? new RedisKV(cfg) : new MemoryKV();
}
