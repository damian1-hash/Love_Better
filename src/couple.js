// Everything a linked couple shares: names, the daily question, nudges,
// practice streaks, mood check-ins, days together, special dates, date ideas
// and love-language results.

import { randomUUID } from "node:crypto";
import { PairingError } from "./pairing.js";

const J = v => (v == null ? null : JSON.parse(v));
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;

export const MOODS = ["great", "good", "okay", "low", "stressed", "tired"];
export const NEEDS = ["", "space", "hug", "talk", "help", "fun"];
export const NUDGES = ["thinking", "miss", "proud", "hug"];
export const LANGS = ["words", "time", "gifts", "service", "touch"];

export function dayNumber(date) {
  const [y, m, d] = date.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / DAY);
}
export function addDays(date, n) {
  return new Date((dayNumber(date) + n) * DAY).toISOString().slice(0, 10);
}

function text(value, max, field) {
  const s = String(value ?? "").trim().replace(/\s+/g, " ");
  if (!s) throw new PairingError("missing_" + field, "Please fill in the " + field + ".");
  if (s.length > max) throw new PairingError("too_long", "That's a bit long. Keep it under " + max + " characters.");
  return s;
}

export class CoupleService {
  constructor(store, opts = {}) {
    this.store = store;
    this.kv = store.kv;
    this.now = opts.now ?? (() => Date.now());
  }
  #k(...parts) { return this.store.key(...parts); }

  // The client sends its local date. Allow a day either side of UTC for time zones.
  checkDate(date) {
    if (!DATE_RE.test(String(date)) || Number.isNaN(dayNumber(date))) throw new PairingError("bad_date", "Invalid date.");
    const today = Math.floor(this.now() / DAY);
    if (Math.abs(dayNumber(date) - today) > 1) throw new PairingError("bad_date", "Your phone's date looks wrong.");
    return date;
  }

  // ----- profiles -----
  async getProfile(uid) { return J(await this.kv.get(this.#k("profile", uid))) ?? { name: "" }; }
  async setName(uid, name) {
    const profile = { ...(await this.getProfile(uid)), name: name ? text(name, 40, "name") : "" };
    await this.kv.set(this.#k("profile", uid), JSON.stringify(profile));
    return profile;
  }

  // ----- the summary the "Us" tab shows -----
  async summary(uid, couple, date) {
    this.checkDate(date);
    const C = couple.id, partner = couple.members.find(m => m !== uid);
    const [me, them, moods, answers, nudges, myDone, theirDone, since, dates, ideas, langs] = await Promise.all([
      this.getProfile(uid), this.getProfile(partner),
      this.kv.hgetall(this.#k("c", C, "mood")),
      this.kv.hgetall(this.#k("c", C, "q", date)),
      this.kv.hgetall(this.#k("c", C, "nudge")),
      this.#done(C, uid), this.#done(C, partner),
      this.kv.get(this.#k("c", C, "since")),
      this.kv.hgetall(this.#k("c", C, "dates")),
      this.kv.hgetall(this.#k("c", C, "ideas")),
      this.kv.hgetall(this.#k("c", C, "lang")),
    ]);
    const mood = id => { const m = J(moods[id]); return m && m.date === date ? m : null; };
    const mine = J(answers[uid]), theirs = J(answers[partner]);
    const linkedDate = new Date(couple.createdAt).toISOString().slice(0, 10);
    const start = since || linkedDate;
    return {
      date,
      me: { name: me.name, mood: mood(uid), practised: myDone.includes(date), lang: J(langs[uid]) },
      partner: { name: them.name, mood: mood(partner), practised: theirDone.includes(date), lang: J(langs[partner]) },
      question: { mine, theirs: mine && theirs ? theirs : null, partnerAnswered: !!theirs },
      nudge: J(nudges[uid]),
      streak: coupleStreak(myDone, theirDone, date),
      together: { since: start, sinceSet: !!since, linkedAt: couple.createdAt, days: dayNumber(date) - dayNumber(start) },
      dates: Object.values(dates).map(J).sort((a, b) => a.date < b.date ? -1 : 1),
      ideas: Object.values(ideas).map(J).sort((a, b) => b.at - a.at),
    };
  }

  // ----- daily question -----
  async answer(uid, couple, date, answer) {
    this.checkDate(date);
    const k = this.#k("c", couple.id, "q", date);
    const first = !(await this.kv.hget(k, uid));
    await this.kv.hset(k, uid, JSON.stringify({ text: text(answer, 500, "answer"), at: this.now() }));
    await this.kv.expire(k, 120 * 24 * 3600);
    return { first };
  }
  // Past days where both answered (answers stay hidden until both have).
  async answerHistory(uid, couple, date, days = 14) {
    this.checkDate(date);
    const partner = couple.members.find(m => m !== uid), out = [];
    for (let i = 1; i <= days; i++) {
      const d = addDays(date, -i), a = await this.kv.hgetall(this.#k("c", couple.id, "q", d));
      if (a[uid] && a[partner]) out.push({ date: d, mine: J(a[uid]), theirs: J(a[partner]) });
    }
    return out;
  }

  // ----- nudges -----
  async nudge(uid, couple, kind) {
    if (!NUDGES.includes(kind)) throw new PairingError("bad_nudge", "Unknown nudge.");
    const partner = couple.members.find(m => m !== uid);
    const n = { kind, from: uid, at: this.now() };
    await this.kv.hset(this.#k("c", couple.id, "nudge"), partner, JSON.stringify(n));
    return { partner, nudge: n };
  }

  // ----- practice / streak -----
  async #done(C, uid) { return J(await this.kv.get(this.#k("c", C, "done", uid))) ?? []; }
  async setPractice(uid, couple, dates) {
    if (!Array.isArray(dates)) throw new PairingError("bad_dates", "Need a list of dates.");
    const clean = [...new Set(dates.filter(d => DATE_RE.test(String(d))))].sort().slice(-400);
    await this.kv.set(this.#k("c", couple.id, "done", uid), JSON.stringify(clean));
    return { count: clean.length };
  }

  // ----- mood -----
  async setMood(uid, couple, date, mood, need = "") {
    this.checkDate(date);
    if (!MOODS.includes(mood)) throw new PairingError("bad_mood", "Unknown mood.");
    if (!NEEDS.includes(need)) throw new PairingError("bad_need", "Unknown need.");
    const m = { mood, need, date, at: this.now() };
    await this.kv.hset(this.#k("c", couple.id, "mood"), uid, JSON.stringify(m));
    return m;
  }

  // ----- days together & special dates -----
  async setSince(couple, since) {
    if (since === null || since === "") { await this.kv.del(this.#k("c", couple.id, "since")); return { since: null }; }
    if (!DATE_RE.test(String(since)) || Number.isNaN(dayNumber(since))) throw new PairingError("bad_date", "Invalid date.");
    if (dayNumber(since) > Math.floor(this.now() / DAY) + 1) throw new PairingError("bad_date", "That date is in the future.");
    await this.kv.set(this.#k("c", couple.id, "since"), since);
    return { since };
  }
  async addDate(uid, couple, { title, date, yearly }) {
    if (!DATE_RE.test(String(date)) || Number.isNaN(dayNumber(date))) throw new PairingError("bad_date", "Pick a date.");
    const k = this.#k("c", couple.id, "dates");
    if ((await this.kv.hlen(k)) >= 50) throw new PairingError("too_many", "That's a lot of dates! Remove one first.");
    const item = { id: randomUUID(), title: text(title, 60, "title"), date, yearly: !!yearly, by: uid, at: this.now() };
    await this.kv.hset(k, item.id, JSON.stringify(item));
    return item;
  }
  async removeDate(couple, id) { await this.kv.hdel(this.#k("c", couple.id, "dates"), String(id)); return { removed: true }; }

  // ----- date ideas -----
  async addIdea(uid, couple, ideaText) {
    const k = this.#k("c", couple.id, "ideas");
    if ((await this.kv.hlen(k)) >= 200) throw new PairingError("too_many", "Your list is full. Remove a few first.");
    const item = { id: randomUUID(), text: text(ideaText, 120, "idea"), done: false, by: uid, at: this.now() };
    await this.kv.hset(k, item.id, JSON.stringify(item));
    return item;
  }
  async setIdeaDone(couple, id, done) {
    const k = this.#k("c", couple.id, "ideas"), item = J(await this.kv.hget(k, String(id)));
    if (!item) throw new PairingError("not_found", "That idea is gone.", 404);
    item.done = !!done; item.doneAt = done ? this.now() : null;
    await this.kv.hset(k, item.id, JSON.stringify(item));
    return item;
  }
  async removeIdea(couple, id) { await this.kv.hdel(this.#k("c", couple.id, "ideas"), String(id)); return { removed: true }; }

  // ----- love languages -----
  async setLang(uid, couple, scores) {
    if (!scores || typeof scores !== "object") throw new PairingError("bad_scores", "Need quiz scores.");
    const clean = {};
    for (const l of LANGS) {
      const n = Number(scores[l] ?? 0);
      if (!Number.isInteger(n) || n < 0 || n > 20) throw new PairingError("bad_scores", "Invalid quiz scores.");
      clean[l] = n;
    }
    const primary = LANGS.reduce((a, b) => clean[b] > clean[a] ? b : a);
    const result = { primary, scores: clean, at: this.now() };
    await this.kv.hset(this.#k("c", couple.id, "lang"), uid, JSON.stringify(result));
    return result;
  }

  // Remove everything shared when a couple unlinks.
  async deleteAll(couple) {
    const C = couple.id;
    await this.kv.del(...["mood", "nudge", "since", "dates", "ideas", "lang"].map(x => this.#k("c", C, x)),
      ...couple.members.map(m => this.#k("c", C, "done", m)));
  }
}

// Consecutive days, ending today (or yesterday if today isn't done by both
// yet), on which both partners practised.
export function coupleStreak(a, b, today) {
  const both = new Set(a.filter(d => b.includes(d)));
  let day = both.has(today) ? today : addDays(today, -1), n = 0;
  while (both.has(day)) { n++; day = addDays(day, -1); }
  return { days: n, bothToday: both.has(today) };
}
