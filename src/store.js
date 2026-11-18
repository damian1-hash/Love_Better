// Storage for invites, couples, failed attempts and the couple's live room.
//
// Two implementations with the same async methods:
//   MemoryStore – for local runs and tests. Lost on restart.
//   RedisStore  – Upstash Redis over its REST API. Use this on Vercel, where
//                 every request may run in a fresh function with no memory.
//
// createStore() picks Redis when its environment variables are set.

export class MemoryStore {
  constructor() {
    this.invitesByCode = new Map();
    this.inviteCodeByOwner = new Map();
    this.couples = new Map();
    this.coupleIdByUser = new Map();
    this.failures = new Map();
    this.rooms = new Map();
  }

  async getInvite(code) { return this.invitesByCode.get(code) ?? null; }
  async getInviteByOwner(ownerId) {
    const code = this.inviteCodeByOwner.get(ownerId);
    return code ? this.invitesByCode.get(code) ?? null : null;
  }
  async saveInvite(invite) {
    this.invitesByCode.set(invite.code, invite);
    this.inviteCodeByOwner.set(invite.ownerId, invite.code);
  }
  async deleteInvite(code) { this.#drop(this.invitesByCode.get(code)); }
  // Atomically claim a code: returns it and removes it, or null if gone.
  async takeInvite(code) {
    const invite = this.invitesByCode.get(code) ?? null;
    this.#drop(invite);
    return invite;
  }
  #drop(invite) {
    if (!invite) return;
    this.invitesByCode.delete(invite.code);
    if (this.inviteCodeByOwner.get(invite.ownerId) === invite.code) this.inviteCodeByOwner.delete(invite.ownerId);
  }

  async getCoupleForUser(userId) {
    const id = this.coupleIdByUser.get(userId);
    return id ? this.couples.get(id) ?? null : null;
  }
  // Returns false if either person is already in a couple.
  async saveCouple(couple) {
    if (couple.members.some(m => this.coupleIdByUser.has(m))) return false;
    this.couples.set(couple.id, couple);
    for (const m of couple.members) this.coupleIdByUser.set(m, couple.id);
    return true;
  }
  async deleteCouple(coupleId) {
    const couple = this.couples.get(coupleId);
    if (!couple) return;
    for (const m of couple.members) this.coupleIdByUser.delete(m);
    this.couples.delete(coupleId);
    this.rooms.delete(coupleId);
  }

  async getFailures(userId) { return this.failures.get(userId) ?? []; }
  async setFailures(userId, list) {
    if (list.length) this.failures.set(userId, list);
    else this.failures.delete(userId);
  }

  // Room: per peer, who owns it (uid), when it last checked in (seen) and its
  // presence. These are written separately so a check-in can never overwrite
  // a presence update that lands at the same moment.
  #room(coupleId) {
    if (!this.rooms.has(coupleId)) this.rooms.set(coupleId, new Map());
    return this.rooms.get(coupleId);
  }
  async getRoom(coupleId) {
    const out = {};
    for (const [peer, e] of this.rooms.get(coupleId) ?? []) out[peer] = { ...e };
    return out;
  }
  // Claims the peer id for uid if unclaimed; returns the owner.
  async claimPeer(coupleId, peer, uid) {
    const room = this.#room(coupleId);
    if (!room.has(peer)) room.set(peer, { uid, seen: 0, presence: {} });
    return room.get(peer).uid;
  }
  async touchPeer(coupleId, peer, now) { const e = this.#room(coupleId).get(peer); if (e) e.seen = now; }
  async setPresence(coupleId, peer, presence) { const e = this.#room(coupleId).get(peer); if (e) e.presence = presence; }
  async deletePeers(coupleId, peers) {
    const room = this.rooms.get(coupleId);
    if (room) for (const p of peers) room.delete(p);
  }
}

const ROOM_TTL_S = 6 * 60 * 60;

export class RedisStore {
  constructor({ url, token, fetchImpl = fetch, prefix = "lb:" }) {
    this.url = url.replace(/\/+$/, "");
    this.token = token;
    this.fetch = fetchImpl;
    this.p = prefix;
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
  #json(v) { return v == null ? null : JSON.parse(v); }
  #ttl(expiresAt) { return Math.max(1, expiresAt - Date.now()); }

  async getInvite(code) { return this.#json(await this.cmd("GET", this.p + "invite:" + code)); }
  async getInviteByOwner(ownerId) {
    const code = await this.cmd("GET", this.p + "invite_owner:" + ownerId);
    return code ? this.getInvite(code) : null;
  }
  async saveInvite(invite) {
    const px = this.#ttl(invite.expiresAt);
    await this.cmd("SET", this.p + "invite:" + invite.code, JSON.stringify(invite), "PX", px);
    await this.cmd("SET", this.p + "invite_owner:" + invite.ownerId, invite.code, "PX", px);
  }
  async deleteInvite(code) { await this.takeInvite(code); }
  async takeInvite(code) {
    const invite = this.#json(await this.cmd("GETDEL", this.p + "invite:" + code));
    if (invite) {
      const ownerKey = this.p + "invite_owner:" + invite.ownerId;
      if ((await this.cmd("GET", ownerKey)) === code) await this.cmd("DEL", ownerKey);
    }
    return invite;
  }

  async getCoupleForUser(userId) {
    const id = await this.cmd("GET", this.p + "couple_of:" + userId);
    return id ? this.#json(await this.cmd("GET", this.p + "couple:" + id)) : null;
  }
  async saveCouple(couple) {
    const claimed = [];
    for (const m of couple.members) {
      const ok = await this.cmd("SET", this.p + "couple_of:" + m, couple.id, "NX");
      if (!ok) {
        for (const c of claimed) await this.cmd("DEL", this.p + "couple_of:" + c);
        return false;
      }
      claimed.push(m);
    }
    await this.cmd("SET", this.p + "couple:" + couple.id, JSON.stringify(couple));
    return true;
  }
  async deleteCouple(coupleId) {
    const couple = this.#json(await this.cmd("GET", this.p + "couple:" + coupleId));
    if (couple) for (const m of couple.members) await this.cmd("DEL", this.p + "couple_of:" + m);
    await this.cmd("DEL", this.p + "couple:" + coupleId, this.p + "room:" + coupleId);
  }

  async getFailures(userId) { return this.#json(await this.cmd("GET", this.p + "fails:" + userId)) ?? []; }
  async setFailures(userId, list) {
    if (list.length) await this.cmd("SET", this.p + "fails:" + userId, JSON.stringify(list), "EX", 3600);
    else await this.cmd("DEL", this.p + "fails:" + userId);
  }

  // Room hash fields: u:<peer> owner uid, s:<peer> last check-in, p:<peer> presence JSON.
  #roomKey(coupleId) { return this.p + "room:" + coupleId; }
  async getRoom(coupleId) {
    const flat = (await this.cmd("HGETALL", this.#roomKey(coupleId))) ?? [];
    const out = {};
    for (let i = 0; i < flat.length; i += 2) {
      const [kind, peer] = [flat[i].slice(0, 1), flat[i].slice(2)];
      const e = (out[peer] ??= { uid: null, seen: 0, presence: {} });
      if (kind === "u") e.uid = flat[i + 1];
      else if (kind === "s") e.seen = Number(flat[i + 1]);
      else if (kind === "p") e.presence = JSON.parse(flat[i + 1]);
    }
    for (const k of Object.keys(out)) if (!out[k].uid) delete out[k];
    return out;
  }
  async claimPeer(coupleId, peer, uid) {
    const key = this.#roomKey(coupleId);
    await this.cmd("HSETNX", key, "u:" + peer, uid);
    await this.cmd("EXPIRE", key, ROOM_TTL_S);
    return this.cmd("HGET", key, "u:" + peer);
  }
  async touchPeer(coupleId, peer, now) { await this.cmd("HSET", this.#roomKey(coupleId), "s:" + peer, now); }
  async setPresence(coupleId, peer, presence) {
    await this.cmd("HSET", this.#roomKey(coupleId), "p:" + peer, JSON.stringify(presence));
  }
  async deletePeers(coupleId, peers) {
    const fields = peers.flatMap(p => ["u:" + p, "s:" + p, "p:" + p]);
    if (fields.length) await this.cmd("HDEL", this.#roomKey(coupleId), ...fields);
  }
}

export function redisConfigFromEnv(env = process.env) {
  const url = env.KV_REST_API_URL || env.UPSTASH_REDIS_REST_URL;
  const token = env.KV_REST_API_TOKEN || env.UPSTASH_REDIS_REST_TOKEN;
  return url && token ? { url, token } : null;
}

export function createStore(env = process.env) {
  const cfg = redisConfigFromEnv(env);
  return cfg ? new RedisStore(cfg) : new MemoryStore();
}
