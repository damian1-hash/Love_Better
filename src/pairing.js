// Code-based partner linking.
//
// Flow:
//   1. Partner A calls createInvite()   -> gets a short code like "K7MQ2X"
//   2. A shares the code (text, out loud, etc.)
//   3. Partner B calls redeemInvite(code) -> A and B are now linked as a couple
//
// Rules:
//   - Codes are 6 characters from an alphabet without look-alikes (no 0/O, 1/I/L).
//   - Codes are single-use and expire (24h by default).
//   - Each person has at most one active code; making a new one replaces the old.
//   - You can't redeem your own code, and nobody can be in two couples at once.
//   - Too many wrong guesses locks code entry for a while (brute-force protection).

import { randomInt, randomUUID } from "node:crypto";

export const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
export const CODE_LENGTH = 6;

export class PairingError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function normalizeCode(input) {
  return String(input ?? "").toUpperCase().replace(/[\s-]/g, "");
}

export function formatCode(code) {
  return code.slice(0, 3) + "-" + code.slice(3);
}

export class PairingService {
  constructor(store, opts = {}) {
    this.store = store;
    this.now = opts.now ?? (() => Date.now());
    this.ttlMs = opts.ttlMs ?? 24 * 60 * 60 * 1000;
    this.maxFailures = opts.maxFailures ?? 5;
    this.failureWindowMs = opts.failureWindowMs ?? 15 * 60 * 1000;
  }

  #requireUser(userId) {
    if (typeof userId !== "string" || !userId.trim()) {
      throw new PairingError("unauthenticated", "Missing user id.", 401);
    }
  }

  #generateCode() {
    for (let attempt = 0; attempt < 20; attempt++) {
      let code = "";
      for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
      const existing = this.store.getInvite(code);
      if (!existing || existing.expiresAt <= this.now()) return code;
    }
    throw new PairingError("code_space_exhausted", "Couldn't make a unique code. Try again.", 503);
  }

  #activeInviteFor(userId) {
    const invite = this.store.getInviteByOwner(userId);
    if (!invite) return null;
    if (invite.expiresAt <= this.now()) {
      this.store.deleteInvite(invite.code);
      return null;
    }
    return invite;
  }

  #recentFailures(userId) {
    const cutoff = this.now() - this.failureWindowMs;
    const list = this.store.getFailures(userId).filter(t => t > cutoff);
    this.store.setFailures(userId, list);
    return list;
  }

  #fail(userId, error) {
    this.store.setFailures(userId, [...this.#recentFailures(userId), this.now()]);
    throw error;
  }

  createInvite(userId) {
    this.#requireUser(userId);
    if (this.store.getCoupleForUser(userId)) {
      throw new PairingError("already_linked", "You're already linked with a partner.", 409);
    }
    const old = this.#activeInviteFor(userId);
    if (old) this.store.deleteInvite(old.code);

    const createdAt = this.now();
    const invite = { code: this.#generateCode(), ownerId: userId, createdAt, expiresAt: createdAt + this.ttlMs };
    this.store.saveInvite(invite);
    return { code: invite.code, display: formatCode(invite.code), expiresAt: invite.expiresAt };
  }

  cancelInvite(userId) {
    this.#requireUser(userId);
    const invite = this.#activeInviteFor(userId);
    if (invite) this.store.deleteInvite(invite.code);
    return { cancelled: !!invite };
  }

  redeemInvite(userId, rawCode) {
    this.#requireUser(userId);
    if (this.#recentFailures(userId).length >= this.maxFailures) {
      throw new PairingError("too_many_attempts", "Too many wrong codes. Wait a few minutes and try again.", 429);
    }
    if (this.store.getCoupleForUser(userId)) {
      throw new PairingError("already_linked", "You're already linked with a partner.", 409);
    }
    const code = normalizeCode(rawCode);
    if (code.length !== CODE_LENGTH || [...code].some(c => !CODE_ALPHABET.includes(c))) {
      this.#fail(userId, new PairingError("invalid_code", "That doesn't look like a valid code."));
    }
    const invite = this.store.getInvite(code);
    if (!invite) this.#fail(userId, new PairingError("invalid_code", "That code wasn't found.", 404));
    if (invite.expiresAt <= this.now()) {
      this.store.deleteInvite(code);
      this.#fail(userId, new PairingError("expired_code", "That code has expired. Ask for a new one.", 410));
    }
    if (invite.ownerId === userId) {
      throw new PairingError("own_code", "That's your own code. Send it to your partner instead.");
    }
    if (this.store.getCoupleForUser(invite.ownerId)) {
      this.store.deleteInvite(code);
      throw new PairingError("partner_already_linked", "That person is already linked with someone.", 409);
    }

    // Single-use: remove the code, plus any code the redeemer had out.
    this.store.deleteInvite(code);
    const mine = this.store.getInviteByOwner(userId);
    if (mine) this.store.deleteInvite(mine.code);
    this.store.setFailures(userId, []);

    const couple = { id: randomUUID(), members: [invite.ownerId, userId], createdAt: this.now() };
    this.store.saveCouple(couple);
    return { coupleId: couple.id, partnerId: invite.ownerId, linkedAt: couple.createdAt };
  }

  status(userId) {
    this.#requireUser(userId);
    const couple = this.store.getCoupleForUser(userId);
    if (couple) {
      return {
        linked: true,
        coupleId: couple.id,
        partnerId: couple.members.find(m => m !== userId),
        linkedAt: couple.createdAt,
      };
    }
    const invite = this.#activeInviteFor(userId);
    return {
      linked: false,
      invite: invite ? { code: invite.code, display: formatCode(invite.code), expiresAt: invite.expiresAt } : null,
    };
  }

  unlink(userId) {
    this.#requireUser(userId);
    const couple = this.store.getCoupleForUser(userId);
    if (!couple) throw new PairingError("not_linked", "You're not linked with anyone.", 409);
    this.store.deleteCouple(couple.id);
    return { unlinked: true, coupleId: couple.id };
  }
}
