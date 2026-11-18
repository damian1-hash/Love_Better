// The Love Better API, shared by the local server (src/server.js) and the
// Vercel functions (api/). Routes on the request path.
//
//   GET    /api/link                 your status (linked? pending code?)
//   POST   /api/link/invite          make a code to share
//   DELETE /api/link/invite          cancel your code
//   POST   /api/link/redeem          { code } link with the code's owner
//   DELETE /api/link                 unlink
//   GET    /api/room?peer=ID         check in and get the couple's live peers
//   POST   /api/room/presence        { peer, presence } set your presence
//
// Identity: requests carry an "X-User-Id" header. The bundled page makes a
// random id per device. Replace this with real sign-in before production.

import { createStore, redisConfigFromEnv } from "./store.js";
import { PairingService, PairingError } from "./pairing.js";

const LIVE_MS = 6_000;     // a peer that hasn't checked in for this long is gone
const PRUNE_MS = 60_000;   // forget peers this stale

export function createHandler({ store = createStore(), pairingOptions, requireStorage = false } = {}) {
  const pairing = new PairingService(store, pairingOptions);

  function send(res, status, body) {
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json");
    res.setHeader("Cache-Control", "no-store");
    res.end(JSON.stringify(body));
  }

  async function readJson(req) {
    if (req.body !== undefined && req.body !== null) {   // already parsed (Vercel)
      if (typeof req.body === "object" && !Buffer.isBuffer(req.body)) return req.body;
      try { return JSON.parse(String(req.body) || "{}"); } catch { throw new PairingError("bad_json", "Invalid JSON."); }
    }
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 10_000) throw new PairingError("too_large", "Request too large.", 413);
    }
    try { return raw ? JSON.parse(raw) : {}; } catch { throw new PairingError("bad_json", "Invalid JSON."); }
  }

  async function linkedCouple(uid) {
    const s = await pairing.status(uid);
    if (!s.linked) throw new PairingError("not_linked", "Link with your partner first.", 403);
    return s.coupleId;
  }

  function checkPeer(peer) {
    if (typeof peer !== "string" || !/^[\w-]{1,64}$/.test(peer)) throw new PairingError("bad_peer", "Missing or invalid peer id.");
  }

  async function claim(coupleId, uid, peer) {
    if ((await store.claimPeer(coupleId, peer, uid)) !== uid) throw new PairingError("forbidden", "Not your peer.", 403);
  }

  async function route(req, res, url) {
    const uid = String(req.headers["x-user-id"] || "");
    const path = url.pathname.replace(/\/+$/, "");

    switch (req.method + " " + path) {
      case "GET /api/link": return send(res, 200, await pairing.status(uid));
      case "POST /api/link/invite": return send(res, 201, await pairing.createInvite(uid));
      case "DELETE /api/link/invite": return send(res, 200, await pairing.cancelInvite(uid));
      case "POST /api/link/redeem": {
        const { code } = await readJson(req);
        return send(res, 200, await pairing.redeemInvite(uid, code));
      }
      case "DELETE /api/link": return send(res, 200, await pairing.unlink(uid));

      case "GET /api/room": {
        const coupleId = await linkedCouple(uid);
        const peer = url.searchParams.get("peer");
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
      // The page sends its whole presence each time (one update in flight at
      // a time), so the server simply stores the latest copy.
      case "POST /api/room/presence": {
        const coupleId = await linkedCouple(uid);
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
    try {
      if (requireStorage && !redisConfigFromEnv()) {
        throw new PairingError("setup_required",
          "Partner linking needs a database. In Vercel, add Upstash Redis from Storage / Marketplace, connect it to this project, and redeploy.", 503);
      }
      await route(req, res, url);
    } catch (err) {
      if (err instanceof PairingError) return send(res, err.status, { error: err.code, message: err.message });
      console.error(err);
      send(res, 500, { error: "server_error", message: "Something went wrong. Try again." });
    }
  };
}

// Used by the files in api/. On Vercel every request may hit a fresh copy of
// the function, so a real database (Upstash Redis) is required.
let vercel;
export default function vercelHandler(req, res) {
  vercel ??= createHandler({ requireStorage: true });
  return vercel(req, res);
}
