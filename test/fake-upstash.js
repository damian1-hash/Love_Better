// A tiny stand-in for the Upstash Redis REST API, covering the commands the
// app uses, so RedisStore can be tested without a real database.
import { createServer } from "node:http";

export async function startFakeUpstash(token = "test-token") {
  const kv = new Map(); // key -> { v, exp }
  const live = k => { const e = kv.get(k); if (e && e.exp && e.exp <= Date.now()) { kv.delete(k); return null; } return e ?? null; };
  const run = ([cmd, ...a]) => {
    switch (cmd.toUpperCase()) {
      case "GET": return live(a[0])?.v ?? null;
      case "SET": {
        const [k, v, ...opts] = a; let exp = 0, nx = false;
        for (let i = 0; i < opts.length; i++) {
          const o = opts[i].toUpperCase();
          if (o === "PX") exp = Date.now() + Number(opts[++i]);
          else if (o === "EX") exp = Date.now() + Number(opts[++i]) * 1000;
          else if (o === "NX") nx = true;
        }
        if (nx && live(k)) return null;
        kv.set(k, { v, exp }); return "OK";
      }
      case "GETDEL": { const e = live(a[0]); kv.delete(a[0]); return e?.v ?? null; }
      case "DEL": return a.reduce((n, k) => n + (kv.delete(k) ? 1 : 0), 0);
      case "HSET": { const e = live(a[0]) ?? { v: new Map(), exp: 0 }; e.v.set(a[1], a[2]); kv.set(a[0], e); return 1; }
      case "HSETNX": { const e = live(a[0]) ?? { v: new Map(), exp: 0 }; kv.set(a[0], e); if (e.v.has(a[1])) return 0; e.v.set(a[1], a[2]); return 1; }
      case "HGET": return live(a[0])?.v.get(a[1]) ?? null;
      case "HLEN": return live(a[0])?.v.size ?? 0;
      case "HGETALL": { const e = live(a[0]); return e ? [...e.v].flat() : []; }
      case "HDEL": { const e = live(a[0]); let n = 0; if (e) for (const f of a.slice(1)) n += e.v.delete(f) ? 1 : 0; return n; }
      case "EXPIRE": { const e = live(a[0]); if (!e) return 0; e.exp = Date.now() + Number(a[1]) * 1000; return 1; }
    }
    throw new Error("unsupported " + cmd);
  };
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const c of req) raw += c;
    res.setHeader("Content-Type", "application/json");
    if (req.headers.authorization !== "Bearer " + token) { res.statusCode = 401; return res.end(JSON.stringify({ error: "Unauthorized" })); }
    try { res.end(JSON.stringify({ result: run(JSON.parse(raw)) })); }
    catch (e) { res.statusCode = 400; res.end(JSON.stringify({ error: e.message })); }
  }).listen(0);
  await new Promise(r => server.once("listening", r));
  return { url: "http://127.0.0.1:" + server.address().port, token, close: () => server.close(), kv };
}
