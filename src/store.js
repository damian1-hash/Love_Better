// Storage for linking and the Heart Jump room, built on the KV layer.
import { MemoryKV, RedisKV, createKV } from "./kv.js";
export { redisConfigFromEnv } from "./kv.js";

const ROOM_TTL_S = 6 * 60 * 60;
const J = v => (v == null ? null : JSON.parse(v));

export class Store {
  constructor(kv, prefix = "lb:") { this.kv = kv; this.p = prefix; }
  key(...parts) { return this.p + parts.join(":"); }

  // Invites
  async getInvite(code) { return J(await this.kv.get(this.key("invite", code))); }
  async getInviteByOwner(ownerId) {
    const code = await this.kv.get(this.key("invite_owner", ownerId));
    return code ? this.getInvite(code) : null;
  }
  async saveInvite(invite) {
    const px = Math.max(1, invite.expiresAt - Date.now());
    await this.kv.set(this.key("invite", invite.code), JSON.stringify(invite), { px });
    await this.kv.set(this.key("invite_owner", invite.ownerId), invite.code, { px });
  }
  async deleteInvite(code) { await this.takeInvite(code); }
  // Atomically claim a code: returns it and removes it, or null if already gone.
  async takeInvite(code) {
    const invite = J(await this.kv.getdel(this.key("invite", code)));
    if (invite) {
      const ownerKey = this.key("invite_owner", invite.ownerId);
      if ((await this.kv.get(ownerKey)) === code) await this.kv.del(ownerKey);
    }
    return invite;
  }

  // Couples
  async getCoupleForUser(userId) {
    const id = await this.kv.get(this.key("couple_of", userId));
    return id ? J(await this.kv.get(this.key("couple", id))) : null;
  }
  // Returns false if either person is already in a couple.
  async saveCouple(couple) {
    const claimed = [];
    for (const m of couple.members) {
      if (!(await this.kv.set(this.key("couple_of", m), couple.id, { nx: true }))) {
        if (claimed.length) await this.kv.del(...claimed.map(c => this.key("couple_of", c)));
        return false;
      }
      claimed.push(m);
    }
    await this.kv.set(this.key("couple", couple.id), JSON.stringify(couple));
    return true;
  }
  async updateCouple(couple) { await this.kv.set(this.key("couple", couple.id), JSON.stringify(couple)); }
  async deleteCouple(coupleId) {
    const couple = J(await this.kv.get(this.key("couple", coupleId)));
    if (couple) await this.kv.del(...couple.members.map(m => this.key("couple_of", m)));
    await this.kv.del(this.key("couple", coupleId), this.key("room", coupleId));
  }

  // Failed code attempts
  async getFailures(userId) { return J(await this.kv.get(this.key("fails", userId))) ?? []; }
  async setFailures(userId, list) {
    if (list.length) await this.kv.set(this.key("fails", userId), JSON.stringify(list), { ex: 3600 });
    else await this.kv.del(this.key("fails", userId));
  }

  // Heart Jump room. Fields per peer: u:<peer> owner, s:<peer> last check-in,
  // p:<peer> presence. Written separately so overlapping requests never clash.
  async getRoom(coupleId) {
    const out = {};
    for (const [f, v] of Object.entries(await this.kv.hgetall(this.key("room", coupleId)))) {
      const e = (out[f.slice(2)] ??= { uid: null, seen: 0, presence: {} });
      if (f[0] === "u") e.uid = v; else if (f[0] === "s") e.seen = Number(v); else if (f[0] === "p") e.presence = JSON.parse(v);
    }
    for (const k of Object.keys(out)) if (!out[k].uid) delete out[k];
    return out;
  }
  async claimPeer(coupleId, peer, uid) {
    const k = this.key("room", coupleId);
    await this.kv.hsetnx(k, "u:" + peer, uid);
    await this.kv.expire(k, ROOM_TTL_S);
    return this.kv.hget(k, "u:" + peer);
  }
  async touchPeer(coupleId, peer, now) { await this.kv.hset(this.key("room", coupleId), "s:" + peer, now); }
  async setPresence(coupleId, peer, presence) { await this.kv.hset(this.key("room", coupleId), "p:" + peer, JSON.stringify(presence)); }
  async deletePeers(coupleId, peers) {
    await this.kv.hdel(this.key("room", coupleId), ...peers.flatMap(p => ["u:" + p, "s:" + p, "p:" + p]));
  }
}

export class MemoryStore extends Store { constructor() { super(new MemoryKV()); } }
export class RedisStore extends Store { constructor(cfg) { super(new RedisKV(cfg)); } }
export function createStore(env = process.env) { return new Store(createKV(env)); }
