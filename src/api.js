// The Love Better API, shared by the local server (src/server.js) and the
// Vercel function (api/index.js). See README.md for the full route list.
//
// Everyone signs in with a secret key sent as "Authorization: Bearer <key>"
// (see src/auth.js).

import { createStore, redisConfigFromEnv } from "./store.js";
import { PairingService, PairingError } from "./pairing.js";
import { CoupleService } from "./couple.js";
import { PushService } from "./push.js";
import { userIdFromRequest } from "./auth.js";
import { PlacesService } from "./places.js";
import { LdrService } from "./ldr.js";
import { ChatService, INLINE_TYPES } from "./chat.js";

const LIVE_MS = 6_000;     // a game screen that hasn't checked in for this long is gone
const PRUNE_MS = 60_000;   // forget game screens this stale

const NUDGE_TEXT = {
  thinking: ["is thinking of you", "💭"],
  miss: ["misses you", "🥺"],
  proud: ["is proud of you", "🌟"],
  hug: ["sent you a hug", "🤗"],
};

export function createHandler({ store = createStore(), pairingOptions, requireStorage = false, push, places, env = process.env } = {}) {
  const pairing = new PairingService(store, pairingOptions);
  const couples = new CoupleService(store, pairingOptions);
  const pushes = push ?? new PushService(store);
  const finder = places ?? new PlacesService(store);
  const ldr = new LdrService(store, pairingOptions);
  const chat = new ChatService(store, pairingOptions);

  function send(res, status, body) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
  }

  async function readJson(req, max = 20_000) {
    if (req.body !== undefined && req.body !== null) {   // already parsed (Vercel)
      if (typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
      try { return JSON.parse(String(req.body) || "{}"); } catch { throw new PairingError("bad_json", "Invalid JSON."); }
    }
    // Read the whole body even when it's too big, so the reply doesn't cut the upload off mid-way.
    let raw = "", size = 0;
    for await (const chunk of req) { size += chunk.length; if (size <= max) raw += chunk; }
    if (size > max) throw new PairingError("too_large", "Request too large.", 413);
    try { return raw ? JSON.parse(raw) : {}; } catch { throw new PairingError("bad_json", "Invalid JSON."); }
  }

  async function coupleOf(uid) {
    const couple = await store.getCoupleForUser(uid);
    if (!couple) throw new PairingError("not_linked", "Link with your partner first.", 403);
    return couple;
  }
  const partnerOf = (couple, uid) => couple.members.find(m => m !== uid);
  const nameOf = async uid => (await couples.getProfile(uid)).name || "Your partner";

  // Run work after the reply has gone out. On Vercel, waitUntil keeps the
  // function alive until the work finishes, so nobody waits for it. Where
  // that isn't available, wait at most 3 seconds so a slow push service never
  // holds up the reply for long.
  function later(work) {
    const p = Promise.resolve().then(work).catch(e => console.error(e));
    const ctx = globalThis[Symbol.for("@vercel/request-context")]?.get?.();
    if (ctx && typeof ctx.waitUntil === "function") { ctx.waitUntil(p); return Promise.resolve(); }
    return Promise.race([p, new Promise(r => setTimeout(r, 3000))]);
  }
  const notify = (uid, msg) => later(() => pushes.sendTo(uid, msg));

  function checkPeer(peer) {
    if (typeof peer !== "string" || !/^[\w-]{1,64}$/.test(peer)) throw new PairingError("bad_peer", "Missing or invalid peer id.");
  }
  async function claim(coupleId, uid, peer) {
    if ((await store.claimPeer(coupleId, peer, uid)) !== uid) throw new PairingError("forbidden", "Not your peer.", 403);
  }

  async function route(req, res, url, path) {
    // Vercel Cron: daily reminder to everyone with notifications on.
    if (path === "/api/cron/daily") {
      // With CRON_SECRET set, only Vercel Cron may call this. Without it,
      // anyone may, but the reminder still goes out at most once a day.
      if (env.CRON_SECRET && req.headers.authorization !== "Bearer " + env.CRON_SECRET) {
        throw new PairingError("forbidden", "Not allowed.", 403);
      }
      return send(res, 200, await pushes.sendDaily({
        title: "Love Better", body: "Today's reminder and your question for two are ready. 💛", url: "/", tag: "daily",
      }));
    }
    if (req.method + " " + path === "GET /api/push/key") {
      const vapid = pushes.getVapid ? await pushes.getVapid() : pushes.vapid;
      return send(res, 200, { enabled: !!vapid, publicKey: vapid ? vapid.publicKey : null });
    }

    const uid = userIdFromRequest(req);
    const q = url.searchParams;

    switch (req.method + " " + path) {
      // ----- me -----
      case "GET /api/me": {
        const [profile, status] = await Promise.all([couples.getProfile(uid), pairing.status(uid)]);
        if (status.linked) status.partnerName = (await couples.getProfile(status.partnerId)).name;
        return send(res, 200, { id: uid, name: profile.name, link: status });
      }
      case "PUT /api/me": {
        const { name } = await readJson(req);
        return send(res, 200, await couples.setName(uid, name));
      }

      // ----- linking -----
      case "GET /api/link": {
        const status = await pairing.status(uid);
        if (status.linked) status.partnerName = (await couples.getProfile(status.partnerId)).name;
        return send(res, 200, status);
      }
      case "POST /api/link/invite": return send(res, 201, await pairing.createInvite(uid));
      case "DELETE /api/link/invite": return send(res, 200, await pairing.cancelInvite(uid));
      case "POST /api/link/redeem": {
        const { code } = await readJson(req);
        const result = await pairing.redeemInvite(uid, code);
        await notify(result.partnerId, { title: "You're linked 💞", body: (await nameOf(uid)) + " linked with you on Love Better.", url: "/#us", tag: "link", badge: true });
        return send(res, 200, result);
      }
      case "DELETE /api/link": {
        const couple = await coupleOf(uid);
        await couples.deleteAll(couple);
        await ldr.deleteAll(couple);
        await chat.deleteAll(couple);
        return send(res, 200, await pairing.unlink(uid));
      }

      // ----- us -----
      case "GET /api/us": {
        const couple = await coupleOf(uid);
        const [summary, apart, chatStatus] = await Promise.all([couples.summary(uid, couple, q.get("date")), ldr.summary(uid, couple, q.get("date")), chat.status(uid, couple)]);
        return send(res, 200, { ...summary, ldr: apart, chat: chatStatus });
      }
      case "GET /api/us/answers": {
        const couple = await coupleOf(uid);
        return send(res, 200, { days: await couples.answerHistory(uid, couple, q.get("date")) });
      }
      case "POST /api/us/answer": {
        const couple = await coupleOf(uid), { date, text } = await readJson(req);
        const { first } = await couples.answer(uid, couple, date, text);
        if (first) {
          const partner = partnerOf(couple, uid), name = await nameOf(uid);
          const s = await couples.summary(partner, couple, date);
          await notify(partner, s.question.mine
            ? { title: "Both answers are in 💬", body: name + " answered today's question too. See what you both said.", url: "/#us", tag: "question", badge: true }
            : { title: name + " answered today's question 💬", body: "Answer it too to see what they said.", url: "/#us", tag: "question", badge: true });
        }
        return send(res, 200, { ok: true });
      }
      case "POST /api/us/nudge": {
        const couple = await coupleOf(uid), { kind } = await readJson(req);
        const { partner } = await couples.nudge(uid, couple, kind);
        const [verb, emoji] = NUDGE_TEXT[kind];
        await notify(partner, { title: (await nameOf(uid)) + " " + verb + " " + emoji, body: "Open Love Better to send one back.", url: "/#us", tag: "nudge", badge: true });
        return send(res, 200, { ok: true });
      }
      case "PUT /api/us/practice": {
        const couple = await coupleOf(uid), { dates } = await readJson(req);
        return send(res, 200, await couples.setPractice(uid, couple, dates));
      }
      case "PUT /api/us/mood": {
        const couple = await coupleOf(uid), { date, mood, need } = await readJson(req);
        return send(res, 200, await couples.setMood(uid, couple, date, mood, need));
      }
      // ----- chat -----
      case "GET /api/chat": return send(res, 200, await chat.list(uid, await coupleOf(uid), { after: q.get("after"), before: q.get("before") }));
      case "POST /api/chat": {
        const couple = await coupleOf(uid), body = await readJson(req, 4_600_000);
        const msg = await chat.send(uid, couple, body);
        const preview = msg.text ? (msg.text.length > 120 ? msg.text.slice(0, 117) + "…" : msg.text)
          : msg.file.kind === "image" ? "📷 Photo" : msg.file.kind === "video" ? "🎥 Video" : "📎 " + msg.file.name;
        // The partner's notification goes out after the reply, so sending feels instant.
        await later(async () => pushes.sendTo(partnerOf(couple, uid), { title: (await nameOf(uid)) + " 💬", body: preview, url: "/#chat", tag: "chat", badge: true }));
        return send(res, 201, msg);
      }
      // Delete for everyone (default), or ?for=me to hide it on your side only.
      case "DELETE /api/chat": {
        const couple = await coupleOf(uid);
        return send(res, 200, q.get("for") === "me" ? await chat.hide(uid, couple, q.get("seq")) : await chat.unsend(uid, couple, q.get("seq")));
      }
      case "PATCH /api/chat": {
        const couple = await coupleOf(uid), { seq, text } = await readJson(req);
        return send(res, 200, await chat.edit(uid, couple, seq, text));
      }
      case "POST /api/chat/read": {
        const couple = await coupleOf(uid), { seq } = await readJson(req);
        return send(res, 200, await chat.read(uid, couple, seq));
      }
      case "GET /api/chat/file": {
        const { meta, bytes } = await chat.getFile(await coupleOf(uid), q.get("id"));
        const inline = INLINE_TYPES.includes(meta.type);
        res.statusCode = 200;
        res.setHeader("Content-Type", inline ? meta.type : "application/octet-stream");
        res.setHeader("Content-Length", bytes.length);
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Content-Security-Policy", "default-src 'none'; sandbox");
        res.setHeader("Content-Disposition", (inline ? "inline" : "attachment") + "; filename*=UTF-8''" + encodeURIComponent(meta.name));
        res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
        return res.end(bytes);
      }

      // ----- long distance: status, notes, letters, photos, play together, date night -----
      case "PUT /api/us/status": {
        const couple = await coupleOf(uid), { state } = await readJson(req);
        return send(res, 200, await ldr.setStatus(uid, couple, state));
      }
      case "POST /api/us/notes": {
        const couple = await coupleOf(uid), body = await readJson(req);
        const note = await ldr.sendNote(uid, couple, body);
        if (note.deliverAt <= Date.now() + 1000) {
          const title = { morning: "Good morning ☀️", night: "Good night 🌙", love: "A note from " + (await nameOf(uid)) + " 💌" }[note.kind];
          await notify(note.to, { title: note.kind === "love" ? title : title + " from " + (await nameOf(uid)), body: note.text, url: "/#apart", tag: "note", badge: true });
        }
        if (body.kind === "night") await ldr.setStatus(uid, couple, "asleep");
        if (body.kind === "morning") await ldr.setStatus(uid, couple, "awake");
        return send(res, 201, note);
      }
      case "POST /api/us/letters": {
        const couple = await coupleOf(uid), letter = await ldr.writeLetter(uid, couple, await readJson(req));
        await notify(letter.to, { title: (await nameOf(uid)) + " wrote you a letter 💌", body: "“" + letter.title + "”" + (letter.unlockDate ? " · opens " + letter.unlockDate : ""), url: "/#apart", tag: "letter", badge: true });
        return send(res, 201, letter);
      }
      case "POST /api/us/letters/open": {
        const couple = await coupleOf(uid), { id, today } = await readJson(req);
        const { letter, first } = await ldr.openLetter(uid, couple, id, today);
        if (first) await notify(letter.from, { title: (await nameOf(uid)) + " opened your letter 💌", body: "“" + letter.title + "”", url: "/#apart", tag: "letter-open" });
        return send(res, 200, letter);
      }
      case "DELETE /api/us/letters": return send(res, 200, await ldr.deleteLetter(uid, await coupleOf(uid), q.get("id")));
      case "POST /api/us/photos": {
        const couple = await coupleOf(uid), photo = await ldr.addPhoto(uid, couple, await readJson(req, 700_000));
        await notify(partnerOf(couple, uid), { title: (await nameOf(uid)) + " shared a photo 📷", body: photo.caption || "Open Love Better to see it.", url: "/#apart", tag: "photo", badge: true });
        return send(res, 201, photo);
      }
      case "GET /api/us/photo": {
        const { type, bytes } = await ldr.getPhoto(await coupleOf(uid), q.get("id"));
        res.statusCode = 200;
        res.setHeader("Content-Type", type);
        res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
        return res.end(bytes);
      }
      case "DELETE /api/us/photos": return send(res, 200, await ldr.deletePhoto(uid, await coupleOf(uid), q.get("id")));
      case "POST /api/us/sync": {
        const couple = await coupleOf(uid), s = await ldr.startSync(uid, couple, await readJson(req));
        await notify(partnerOf(couple, uid), { title: "Press play together ▶️", body: (await nameOf(uid)) + " is starting " + (s.title ? "“" + s.title + "”" : "something") + ". Open the app to join the countdown!", url: "/#apart", tag: "sync", urgency: "high" });
        return send(res, 201, s);
      }
      case "DELETE /api/us/sync": return send(res, 200, await ldr.stopSync(await coupleOf(uid)));
      case "PUT /api/us/datenight": {
        const couple = await coupleOf(uid), body = await readJson(req), d = await ldr.planDateNight(uid, couple, body);
        if (d && d.at) await notify(partnerOf(couple, uid), { title: "Date night planned 🕯️", body: (await nameOf(uid)) + " planned " + (d.idea ? "“" + d.idea + "”" : "a date night") + ". Open the app to see when.", url: "/#apart", tag: "datenight", badge: true });
        return send(res, 200, d);
      }

      // ----- long distance -----
      case "PUT /api/us/where": {
        const couple = await coupleOf(uid), { lat, lon } = await readJson(req);
        const name = await finder.cityAt(lat, lon);
        return send(res, 200, await couples.setPlace(uid, couple, { lat, lon, ...name }));
      }
      case "DELETE /api/us/where": return send(res, 200, await couples.clearPlace(uid, await coupleOf(uid)));
      case "PUT /api/us/tz": {
        const couple = await coupleOf(uid), { tz } = await readJson(req);
        return send(res, 200, await couples.setTimeZone(uid, couple, tz));
      }
      case "PUT /api/us/reunion": {
        const couple = await coupleOf(uid), body = await readJson(req);
        return send(res, 200, await couples.setReunion(uid, couple, body));
      }
      case "PUT /api/us/visits": {
        const couple = await coupleOf(uid), { visits } = await readJson(req);
        return send(res, 200, await couples.setVisits(couple, visits));
      }

      case "PUT /api/us/since": {
        const couple = await coupleOf(uid), { since } = await readJson(req);
        return send(res, 200, await couples.setSince(couple, since));
      }
      case "POST /api/us/dates": {
        const couple = await coupleOf(uid);
        return send(res, 201, await couples.addDate(uid, couple, await readJson(req)));
      }
      case "DELETE /api/us/dates": return send(res, 200, await couples.removeDate(await coupleOf(uid), q.get("id")));
      case "POST /api/us/ideas": {
        const couple = await coupleOf(uid), { text } = await readJson(req);
        return send(res, 201, await couples.addIdea(uid, couple, text));
      }
      case "PATCH /api/us/ideas": {
        const couple = await coupleOf(uid), { id, done } = await readJson(req);
        return send(res, 200, await couples.setIdeaDone(couple, id, done));
      }
      case "DELETE /api/us/ideas": return send(res, 200, await couples.removeIdea(await coupleOf(uid), q.get("id")));
      case "PUT /api/us/lang": {
        const couple = await coupleOf(uid), { scores } = await readJson(req);
        return send(res, 200, await couples.setLang(uid, couple, scores));
      }

      // ----- places nearby -----
      case "GET /api/places":
        return send(res, 200, await finder.nearby(uid, { lat: q.get("lat"), lon: q.get("lon"), radius: q.get("radius"), cat: q.get("cat") }));
      case "GET /api/places/search":
        return send(res, 200, await finder.geocode(uid, q.get("q")));

      // ----- notifications -----
      case "POST /api/push/subscribe": {
        if (!pushes.enabled) throw new PairingError("push_not_configured", "Notifications aren't set up on this server yet.", 503);
        const { subscription } = await readJson(req);
        try { await pushes.subscribe(uid, subscription); } catch (e) { if (e.bad) throw new PairingError("bad_subscription", "Invalid subscription."); throw e; }
        return send(res, 201, { ok: true });
      }
      case "DELETE /api/push/subscribe": {
        const { endpoint } = await readJson(req);
        await pushes.unsubscribe(uid, endpoint);
        return send(res, 200, { ok: true });
      }
      case "POST /api/push/test": {
        const r = await pushes.sendTo(uid, { title: "Notifications are on 🔔", body: "This is how Love Better will reach you.", url: "/", tag: "test" });
        return send(res, 200, r);
      }

      // ----- Heart Jump room -----
      case "GET /api/room": {
        const { id: coupleId } = await coupleOf(uid);
        const peer = q.get("peer");
        checkPeer(peer);
        await claim(coupleId, uid, peer);
        const now = Date.now();
        await store.touchPeer(coupleId, peer, now);
        const room = await store.getRoom(coupleId);
        const stale = Object.keys(room).filter(p => p !== peer && now - room[p].seen > PRUNE_MS);
        if (stale.length) await store.deletePeers(coupleId, stale);
        const peers = Object.entries(room)
          .filter(([p, e]) => p === peer || now - e.seen <= LIVE_MS)
          .map(([p, e]) => ({ peer: p, presence: e.presence }));
        return send(res, 200, { peers });
      }
      // Each game screen sends its whole state, one update at a time.
      case "POST /api/room/presence": {
        const { id: coupleId } = await coupleOf(uid);
        const { peer, presence } = await readJson(req);
        checkPeer(peer);
        if (typeof presence !== "object" || !presence || Array.isArray(presence)) throw new PairingError("bad_presence", "Need a presence object.");
        if (JSON.stringify(presence).length > 2000) throw new PairingError("too_large", "Presence too large.", 413);
        await claim(coupleId, uid, peer);
        await store.setPresence(coupleId, peer, presence);
        await store.touchPeer(coupleId, peer, Date.now());
        return send(res, 200, { ok: true });
      }
    }
    throw new PairingError("not_found", "No such endpoint.", 404);
  }

  return async function handle(req, res) {
    const url = new URL(req.url, "http://localhost");
    // On Vercel every /api/* path is rewritten to /api/index?path=...
    let path = url.pathname.replace(/\/+$/, "");
    if ((path === "/api/index" || path === "/api") && url.searchParams.has("path")) {
      path = "/api/" + url.searchParams.get("path").replace(/^\/+/, "");
    }
    try {
      if (requireStorage && !redisConfigFromEnv(env)) {
        throw new PairingError("setup_required",
          "Partner linking needs a database. In Vercel, add Upstash Redis from Storage / Marketplace, connect it to this project, and redeploy.", 503);
      }
      await route(req, res, url, path);
    } catch (err) {
      if (err instanceof PairingError) return send(res, err.status, { error: err.code, message: err.message, ...(err.detail ? { detail: err.detail } : {}) });
      console.error(err);
      send(res, 500, { error: "server_error", message: "Something went wrong. Try again.", detail: String(err && err.message || err).slice(0, 200) });
    }
  };
}

// Used by api/index.js. On Vercel every request may hit a fresh copy of the
// function, so a real database (Upstash Redis) is required.
let vercel;
export default function vercelHandler(req, res) {
  vercel ??= createHandler({ requireStorage: true });
  return vercel(req, res);
}
