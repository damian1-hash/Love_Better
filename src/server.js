// Zero-dependency HTTP server for Love Better.
//
//   Static app        GET  /                      -> public/index.html
//   Linking API       GET  /api/link              -> your status (linked? pending code?)
//                     POST /api/link/invite       -> make a code to share
//                     DELETE /api/link/invite     -> cancel your code
//                     POST /api/link/redeem       -> { code } link with the code's owner
//                     DELETE /api/link            -> unlink
//   Couple room       GET  /api/room/events       -> live presence stream (SSE)
//                     POST /api/room/presence     -> { peer, patch } update your presence
//
// Identity: requests carry an "X-User-Id" header (or ?uid= for the SSE stream).
// The bundled page makes a random id per device. Replace this with your real
// auth (session cookie, JWT, ...) before going to production.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { MemoryStore } from "./store.js";
import { PairingService, PairingError } from "./pairing.js";

const PUBLIC_DIR = fileURLToPath(new URL("../public/", import.meta.url));
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json" };

export function createApp({ store = new MemoryStore(), pairingOptions } = {}) {
  const pairing = new PairingService(store, pairingOptions);
  // coupleId -> Map(peerId -> { userId, presence, res })
  const rooms = new Map();

  function roomFor(coupleId) {
    if (!rooms.has(coupleId)) rooms.set(coupleId, new Map());
    return rooms.get(coupleId);
  }
  function broadcast(coupleId) {
    const room = rooms.get(coupleId);
    if (!room) return;
    const list = [...room].filter(([, p]) => p.res).map(([peer, p]) => ({ peer, presence: p.presence }));
    const msg = "data: " + JSON.stringify(list) + "\n\n";
    for (const p of room.values()) p.res?.write(msg);
  }
  function closeRoom(coupleId) {
    const room = rooms.get(coupleId);
    if (!room) return;
    for (const p of room.values()) p.res?.end();
    rooms.delete(coupleId);
  }

  function send(res, status, body) {
    res.writeHead(status, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    res.end(JSON.stringify(body));
  }
  async function readJson(req) {
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      if (raw.length > 10_000) throw new PairingError("too_large", "Request too large.", 413);
    }
    try { return raw ? JSON.parse(raw) : {}; } catch { throw new PairingError("bad_json", "Invalid JSON."); }
  }

  async function handleApi(req, res, url) {
    const uid = req.headers["x-user-id"] || url.searchParams.get("uid") || "";
    const route = req.method + " " + url.pathname;

    switch (route) {
      case "GET /api/link": return send(res, 200, pairing.status(uid));
      case "POST /api/link/invite": return send(res, 201, pairing.createInvite(uid));
      case "DELETE /api/link/invite": return send(res, 200, pairing.cancelInvite(uid));
      case "POST /api/link/redeem": {
        const { code } = await readJson(req);
        return send(res, 200, pairing.redeemInvite(uid, code));
      }
      case "DELETE /api/link": {
        const result = pairing.unlink(uid);
        closeRoom(result.coupleId);
        return send(res, 200, result);
      }
      case "GET /api/room/events": {
        const s = pairing.status(uid);
        const peer = url.searchParams.get("peer");
        if (!s.linked) throw new PairingError("not_linked", "Link with your partner first.", 403);
        if (!peer) throw new PairingError("missing_peer", "Missing peer id.");
        const room = roomFor(s.coupleId);
        const entry = room.get(peer) ?? { userId: uid, presence: {} };
        if (entry.userId !== uid) throw new PairingError("forbidden", "Not your peer.", 403);
        res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
        res.write(": connected\n\n");
        entry.res = res;
        room.set(peer, entry);
        const ping = setInterval(() => res.write(": ping\n\n"), 25_000);
        req.on("close", () => {
          clearInterval(ping);
          if (room.get(peer)?.res === res) room.delete(peer);
          broadcast(s.coupleId);
        });
        return broadcast(s.coupleId);
      }
      case "POST /api/room/presence": {
        const s = pairing.status(uid);
        if (!s.linked) throw new PairingError("not_linked", "Link with your partner first.", 403);
        const { peer, patch } = await readJson(req);
        if (!peer || typeof patch !== "object" || !patch) throw new PairingError("bad_presence", "Need peer and patch.");
        const room = roomFor(s.coupleId);
        const entry = room.get(peer) ?? { userId: uid, presence: {} };
        if (entry.userId !== uid) throw new PairingError("forbidden", "Not your peer.", 403);
        entry.presence = { ...entry.presence, ...patch };
        room.set(peer, entry);
        broadcast(s.coupleId);
        return send(res, 200, { ok: true });
      }
    }
    throw new PairingError("not_found", "No such endpoint.", 404);
  }

  async function handleStatic(req, res, url) {
    const rel = url.pathname === "/" ? "index.html" : decodeURIComponent(url.pathname).replace(/^\/+/, "");
    const file = normalize(join(PUBLIC_DIR, rel));
    if (!file.startsWith(PUBLIC_DIR)) return send(res, 404, { error: "not_found" });
    try {
      const body = await readFile(file);
      res.writeHead(200, { "Content-Type": TYPES[extname(file)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      send(res, 404, { error: "not_found" });
    }
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, "http://localhost");
    try {
      if (url.pathname.startsWith("/api/")) await handleApi(req, res, url);
      else if (req.method === "GET") await handleStatic(req, res, url);
      else send(res, 405, { error: "method_not_allowed" });
    } catch (err) {
      if (err instanceof PairingError) return send(res, err.status, { error: err.code, message: err.message });
      console.error(err);
      if (!res.headersSent) send(res, 500, { error: "server_error", message: "Something went wrong." });
    }
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 3000;
  createApp().listen(port, () => console.log(`Love Better running at http://localhost:${port}`));
}
