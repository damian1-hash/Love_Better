// In-memory storage for invites, couples and failed attempts.
// Swap this for a database-backed store with the same methods in production.
// When you do, run redeem inside a transaction so two people can't claim
// the same code (or the same partner) at the same moment.

export class MemoryStore {
  constructor() {
    this.invitesByCode = new Map();   // code -> { code, ownerId, createdAt, expiresAt }
    this.inviteCodeByOwner = new Map(); // ownerId -> code
    this.couples = new Map();         // coupleId -> { id, members: [a, b], createdAt }
    this.coupleIdByUser = new Map();  // userId -> coupleId
    this.failures = new Map();        // userId -> [timestamps]
  }

  // Invites
  getInvite(code) { return this.invitesByCode.get(code) ?? null; }
  getInviteByOwner(ownerId) {
    const code = this.inviteCodeByOwner.get(ownerId);
    return code ? this.getInvite(code) : null;
  }
  saveInvite(invite) {
    this.invitesByCode.set(invite.code, invite);
    this.inviteCodeByOwner.set(invite.ownerId, invite.code);
  }
  deleteInvite(code) {
    const invite = this.invitesByCode.get(code);
    if (!invite) return;
    this.invitesByCode.delete(code);
    if (this.inviteCodeByOwner.get(invite.ownerId) === code) {
      this.inviteCodeByOwner.delete(invite.ownerId);
    }
  }

  // Couples
  getCoupleForUser(userId) {
    const id = this.coupleIdByUser.get(userId);
    return id ? this.couples.get(id) ?? null : null;
  }
  saveCouple(couple) {
    this.couples.set(couple.id, couple);
    for (const m of couple.members) this.coupleIdByUser.set(m, couple.id);
  }
  deleteCouple(coupleId) {
    const couple = this.couples.get(coupleId);
    if (!couple) return;
    for (const m of couple.members) this.coupleIdByUser.delete(m);
    this.couples.delete(coupleId);
  }

  // Failed-attempt tracking (brute-force protection)
  getFailures(userId) { return this.failures.get(userId) ?? []; }
  setFailures(userId, list) {
    if (list.length) this.failures.set(userId, list);
    else this.failures.delete(userId);
  }
}
