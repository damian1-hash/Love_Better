import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { KEY_ALPHABET } from "../src/auth.js";

export const newKey = () => [...randomBytes(25)].map(b => KEY_ALPHABET[b & 31]).join("");

export async function withServer(server, fn) {
  server.listen(0);
  await new Promise(r => server.once("listening", r));
  const base = "http://127.0.0.1:" + server.address().port;
  // call(key, method, path, body)
  const call = (key, method, path, body) =>
    fetch(base + path, { method, headers: { ...(key ? { Authorization: "Bearer " + key } : {}), "Content-Type": "application/json" }, body: body && JSON.stringify(body) })
      .then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
  try { return await fn({ base, call }); } finally { server.closeAllConnections(); server.close(); }
}
export { createServer };
