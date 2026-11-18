// Long-distance features: how you're doing right now (status), good
// morning / good night notes, open-when letters, a shared photo wall, a
// "press play together" countdown, and a planned virtual date night.

import { randomUUID } from "node:crypto";
import { PairingError } from "./pairing.js";

const J = v => (v == null ? null : JSON.parse(v));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const STATUSES = ["free", "busy", "asleep", "awake"];
export const NOTE_KINDS = ["morning", "night", "love"];
const MAX_PHOTO_BYTES = 400 * 1024;

function text(value, max, field) {
  const s = String(value ?? "").trim();
  if (!s) throw new PairingError("missing_" + field, "Please write the " + field + ".");
  if (s.length > max) throw new PairingError("too_long", "That's a bit long. Keep it under " + max + " characters.");
  return s;
}

// Milliseconds since epoch of the next `hour`:00 in time zone `tz`.
export function nextLocalHour(tz, hour, now = Date.now()) {
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const parts = at => Object.fromEntries(fmt.formatToParts(at).map(p => [p.type, p.value]));
  const offset = at => { const p = parts(at); return Date.UTC(+p.year, p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second) - Math.floor(at / 1000) * 1000; };
  const p = parts(now);
  let target = Date.UTC(+p.year, p.month - 1, +p.day, hour, 0, 0) - offset(now);
  if (target <= now) target += 24 * 3600 * 1000;
  return target - (offset(target) - offset(now));   // adjust if a clock change happens in between
}

export class LdrService {
  constructor(store, opts = {}) {
    this.store = store; this.kv = store.kv;
    this.now = opts.now ?? (() => Date.now());
  }
  #k(C, ...parts) { return this.store.key("c", C, ...parts); }
  #partner(couple, uid) { return couple.members.find(m => m !== uid); }
  async #trim(hashKey, keep, onDrop) {
    const all = Object.entries(await this.kv.hgetall(hashKey)).map(([id, v]) => [id, J(v)]).sort((a, b) => b[1].at - a[1].at);
    const drop = all.slice(keep);
    if (!drop.length) return;
    await this.kv.hdel(hashKey, ...drop.map(d => d[0]));
    if (onDrop) for (const d of drop) await onDrop(d[1]);
  }

  async summary(uid, couple, today) {
    const C = couple.id, partner = this.#partner(couple, uid), now = this.now();
    const [statuses, notes, letters, photos, sync, datenight] = await Promise.all([
      this.kv.hgetall(this.#k(C, "status")), this.kv.hgetall(this.#k(C, "notes")), this.kv.hgetall(this.#k(C, "letters")),
      this.kv.hgetall(this.#k(C, "photos")), this.kv.get(this.#k(C, "sync")), this.kv.get(this.#k(C, "datenight")),
    ]);
    const allNotes = Object.values(notes).map(J).sort((a, b) => b.deliverAt - a.deliverAt);
    const allLetters = Object.values(letters).map(J).sort((a, b) => b.at - a.at);
    return {
      serverNow: now,
      status: { me: J(statuses[uid]), partner: J(statuses[partner]) },
      notes: {
        toMe: allNotes.filter(n => n.to === uid && n.deliverAt <= now).slice(0, 10),
        fromMe: allNotes.filter(n => n.from === uid).slice(0, 5),
      },
      letters: {
        // Letters to you: the words stay sealed until you open them (and not before their date).
        toMe: allLetters.filter(l => l.to === uid).map(l => ({
          id: l.id, title: l.title, at: l.at, unlockDate: l.unlockDate, openedAt: l.openedAt,
          locked: !!(l.unlockDate && today && l.unlockDate > today), body: l.openedAt ? l.body : null,
        })),
        fromMe: allLetters.filter(l => l.from === uid),
      },
      photos: Object.values(photos).map(J).sort((a, b) => b.at - a.at),
      sync: J(sync),
      datenight: J(datenight),
    };
  }

  // ----- status -----
  async setStatus(uid, couple, state) {
    if (!STATUSES.includes(state)) throw new PairingError("bad_status", "Unknown status.");
    const s = { state, at: this.now() };
    await this.kv.hset(this.#k(couple.id, "status"), uid, JSON.stringify(s));
    return s;
  }

  // ----- good morning / good night notes -----
  async sendNote(uid, couple, { kind, text: body, when }) {
    if (!NOTE_KINDS.includes(kind)) throw new PairingError("bad_note", "Unknown kind of note.");
    const partner = this.#partner(couple, uid), now = this.now();
    let deliverAt = now;
    if (when === "wake") {
      const tz = await this.kv.hget(this.#k(couple.id, "tz"), partner);
      if (tz) { try { deliverAt = nextLocalHour(tz, 7, now); } catch {} }
      if (deliverAt - now > 20 * 3600 * 1000 || deliverAt - now < 0) deliverAt = now;   // already morning there
    }
    const note = { id: randomUUID(), from: uid, to: partner, kind, text: text(body, 300, "note"), at: now, deliverAt };
    const k = this.#k(couple.id, "notes");
    await this.kv.hset(k, note.id, JSON.stringify(note));
    await this.#trim(k, 40);
    return note;
  }

  // ----- open-when letters -----
  async writeLetter(uid, couple, { title, body, unlockDate }) {
    if (unlockDate && (!DATE_RE.test(String(unlockDate)))) throw new PairingError("bad_date", "Invalid date.");
    const k = this.#k(couple.id, "letters");
    if ((await this.kv.hlen(k)) >= 100) throw new PairingError("too_many", "That's a lot of letters! Delete an old one first.");
    const letter = { id: randomUUID(), from: uid, to: this.#partner(couple, uid), title: text(title, 80, "title"), body: text(body, 5000, "letter"),
      unlockDate: unlockDate || null, at: this.now(), openedAt: null };
    await this.kv.hset(k, letter.id, JSON.stringify(letter));
    return letter;
  }
  async openLetter(uid, couple, id, today) {
    const k = this.#k(couple.id, "letters"), l = J(await this.kv.hget(k, String(id)));
    if (!l || l.to !== uid) throw new PairingError("not_found", "That letter isn't here.", 404);
    if (l.unlockDate && (!today || l.unlockDate > today)) throw new PairingError("locked", "This letter can't be opened yet.", 423);
    const first = !l.openedAt;
    if (first) { l.openedAt = this.now(); await this.kv.hset(k, l.id, JSON.stringify(l)); }
    return { letter: l, first };
  }
  async deleteLetter(uid, couple, id) {
    const k = this.#k(couple.id, "letters"), l = J(await this.kv.hget(k, String(id)));
    if (!l) return { removed: false };
    if (l.from !== uid && l.to !== uid) throw new PairingError("forbidden", "Not your letter.", 403);
    await this.kv.hdel(k, l.id);
    return { removed: true };
  }

  // ----- photo wall -----
  async addPhoto(uid, couple, { data, caption, w, h }) {
    const m = /^data:image\/(jpeg|webp|png);base64,([A-Za-z0-9+/=]+)$/.exec(String(data || ""));
    if (!m) throw new PairingError("bad_photo", "That doesn't look like a photo.");
    const bytes = Math.floor(m[2].length * 3 / 4);
    if (bytes > MAX_PHOTO_BYTES) throw new PairingError("too_large", "That photo is too big.", 413);
    const photo = { id: randomUUID(), from: uid, caption: caption ? text(caption, 140, "caption") : "", at: this.now(),
      w: Math.min(4000, Number(w) || 0), h: Math.min(4000, Number(h) || 0), type: "image/" + m[1] };
    await this.kv.set(this.#k(couple.id, "photo", photo.id), m[2]);
    const k = this.#k(couple.id, "photos");
    await this.kv.hset(k, photo.id, JSON.stringify(photo));
    await this.#trim(k, 60, async old => this.kv.del(this.#k(couple.id, "photo", old.id)));
    return photo;
  }
  async getPhoto(couple, id) {
    const meta = J(await this.kv.hget(this.#k(couple.id, "photos"), String(id)));
    const b64 = meta && await this.kv.get(this.#k(couple.id, "photo", meta.id));
    if (!b64) throw new PairingError("not_found", "That photo is gone.", 404);
    return { type: meta.type, bytes: Buffer.from(b64, "base64") };
  }
  async deletePhoto(uid, couple, id) {
    const k = this.#k(couple.id, "photos"), meta = J(await this.kv.hget(k, String(id)));
    if (!meta) return { removed: false };
    if (meta.from !== uid) throw new PairingError("forbidden", "Only the person who shared a photo can remove it.", 403);
    await this.kv.hdel(k, meta.id);
    await this.kv.del(this.#k(couple.id, "photo", meta.id));
    return { removed: true };
  }

  // ----- press play together -----
  async startSync(uid, couple, { title, delay }) {
    delay = Math.max(10, Math.min(120, Number(delay) || 30));
    const s = { title: title ? text(title, 80, "title") : "", startAt: this.now() + delay * 1000, by: uid, at: this.now() };
    await this.kv.set(this.#k(couple.id, "sync"), JSON.stringify(s), { ex: 3600 });
    return s;
  }
  async stopSync(couple) { await this.kv.del(this.#k(couple.id, "sync")); return { stopped: true }; }

  // ----- virtual date night -----
  async planDateNight(uid, couple, { at, idea }) {
    const k = this.#k(couple.id, "datenight");
    if (at === null || at === "") { await this.kv.del(k); return { datenight: null }; }
    at = Number(at);
    if (!Number.isFinite(at) || at < this.now() - 3 * 3600 * 1000 || at > this.now() + 366 * 864e5) throw new PairingError("bad_date", "Pick a time in the coming year.");
    const d = { at, idea: idea ? text(idea, 120, "idea") : "", by: uid, set: this.now() };
    await this.kv.set(k, JSON.stringify(d));
    return d;
  }

  async deleteAll(couple) {
    const C = couple.id;
    const photos = Object.keys(await this.kv.hgetall(this.#k(C, "photos")));
    await this.kv.del(...["status", "notes", "letters", "photos", "sync", "datenight"].map(x => this.#k(C, x)), ...photos.map(id => this.#k(C, "photo", id)));
  }
}
