import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { createApp } from "../src/server.js";
import { MemoryStore, RedisStore } from "../src/store.js";
import { ChatService } from "../src/chat.js";
import { startFakeUpstash } from "./fake-upstash.js";
import { withServer, newKey } from "./helpers.js";

const JPEG = "data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==";

for (const [name, make] of Object.entries({
  memory: async () => ({ store: new MemoryStore(), close() {} }),
  redis: async () => { const f = await startFakeUpstash(); return { store: new RedisStore(f), close: f.close }; },
})) {
  test(`[${name}] chat: messages, read receipts, photos, files, unsend`, async () => {
    const { store, close } = await make(), sent = [];
    const push = { enabled: true, getVapid: async () => ({ publicKey: "k" }), sendTo: async (uid, msg) => { sent.push({ uid, msg }); return { sent: 1 }; }, subscribe: async () => {}, unsubscribe: async () => {}, sendDaily: async () => ({}) };
    try {
      await withServer(createApp({ store, push, env: {} }), async ({ call, base }) => {
        const A = newKey(), B = newKey(), X = newKey();
        await call(A, "PUT", "/api/me", { name: "Ada" });
        const inv = await call(A, "POST", "/api/link/invite");
        await call(B, "POST", "/api/link/redeem", { code: inv.body.code });
        const idB = (await call(B, "GET", "/api/me")).body.id;

        // text
        const m1 = (await call(A, "POST", "/api/chat", { text: "Hi love" })).body;
        assert.equal(m1.seq, 1);
        assert.deepEqual([sent.at(-1).uid, sent.at(-1).msg.title, sent.at(-1).msg.body], [idB, "Ada 💬", "Hi love"]);
        await call(A, "POST", "/api/chat", { text: "Miss you" });
        let r = (await call(B, "GET", "/api/chat")).body;
        assert.deepEqual(r.messages.map(m => m.text), ["Hi love", "Miss you"]);
        assert.equal(r.unread, 2);
        const t = new Date().toISOString().slice(0, 10);
        assert.equal((await call(B, "GET", "/api/us?date=" + t)).body.chat.unread, 2);
        await call(B, "POST", "/api/chat/read", { seq: r.last });
        assert.equal((await call(A, "GET", "/api/chat")).body.partnerRead, 2, "Ada sees Seen");
        assert.equal((await call(B, "GET", "/api/us?date=" + t)).body.chat.unread, 0);

        // only new messages after #N
        await call(B, "POST", "/api/chat", { text: "Me too ❤️" });
        r = (await call(A, "GET", "/api/chat?after=2")).body;
        assert.deepEqual(r.messages.map(m => m.text), ["Me too ❤️"]);

        // photo
        const ph = (await call(B, "POST", "/api/chat", { file: { name: "view.jpg", type: "image/jpeg", data: JPEG, w: 1, h: 1 } })).body;
        assert.equal(ph.file.kind, "image"); assert.equal(sent.at(-1).msg.body, "📷 Photo");
        let f = await fetch(base + "/api/chat/file?id=" + ph.file.id, { headers: { Authorization: "Bearer " + A } });
        assert.equal(f.status, 200); assert.equal(f.headers.get("content-type"), "image/jpeg");
        assert.match(f.headers.get("content-security-policy"), /sandbox/);

        // a 2.5 MB file is split into pieces and comes back byte-for-byte
        const big = randomBytes(2.5 * 1024 * 1024);
        const doc = (await call(A, "POST", "/api/chat", { text: "Our tickets", file: { name: "tickets.pdf", type: "application/pdf", data: big.toString("base64") } })).body;
        assert.equal(doc.file.kind, "file"); assert.equal(doc.file.size, big.length);
        f = await fetch(base + "/api/chat/file?id=" + doc.file.id, { headers: { Authorization: "Bearer " + B } });
        assert.equal(f.headers.get("content-type"), "application/octet-stream");
        assert.match(f.headers.get("content-disposition"), /^attachment; filename\*=UTF-8''tickets\.pdf/);
        assert.ok(Buffer.from(await f.arrayBuffer()).equals(big));

        // HTML/SVG never shown inline (no script can run on our site)
        const evil = (await call(A, "POST", "/api/chat", { file: { name: "x.svg", type: "image/svg+xml", data: Buffer.from("<svg onload=alert(1)>").toString("base64") } })).body;
        assert.equal(evil.file.kind, "file");
        f = await fetch(base + "/api/chat/file?id=" + evil.file.id, { headers: { Authorization: "Bearer " + B } });
        assert.equal(f.headers.get("content-type"), "application/octet-stream"); assert.match(f.headers.get("content-disposition"), /^attachment/);

        // limits and privacy
        assert.equal((await call(A, "POST", "/api/chat", { file: { name: "huge", type: "video/mp4", data: randomBytes(3.2 * 1024 * 1024).toString("base64") } })).status, 413);
        assert.equal((await call(A, "POST", "/api/chat", { text: "   " })).status, 400);
        assert.equal((await fetch(base + "/api/chat/file?id=" + doc.file.id, { headers: { Authorization: "Bearer " + X } })).status, 403);
        assert.equal((await call(X, "GET", "/api/chat")).status, 403);

        // unsend: only your own; the file goes too
        assert.equal((await call(B, "DELETE", "/api/chat?seq=" + doc.seq)).status, 403);
        await call(A, "DELETE", "/api/chat?seq=" + doc.seq);
        r = (await call(B, "GET", "/api/chat")).body;
        assert.equal(r.edit, 1, "phones learn that an older message changed");
        const gone = r.messages.find(m => m.seq === doc.seq);
        assert.equal(gone.deleted, true); assert.equal(gone.text, undefined);
        assert.equal((await fetch(base + "/api/chat/file?id=" + doc.file.id, { headers: { Authorization: "Bearer " + B } })).status, 404);

        // unlinking deletes the chat
        await call(A, "DELETE", "/api/link");
        const inv2 = await call(A, "POST", "/api/link/invite"); await call(B, "POST", "/api/link/redeem", { code: inv2.body.code });
        assert.equal((await call(A, "GET", "/api/chat")).body.messages.length, 0);
      });
    } finally { close(); }
  });
}

test("chat keeps the newest 1,000 messages and pages back through older ones", async () => {
  const store = new MemoryStore(), svc = new ChatService(store), couple = { id: "c", members: ["a", "b"] };
  for (let i = 1; i <= 1005; i++) await svc.send(i % 2 ? "a" : "b", couple, { text: "m" + i });
  const latest = await svc.list("a", couple);
  assert.equal(latest.messages.length, 50); assert.equal(latest.messages.at(-1).text, "m1005"); assert.equal(latest.hasOlder, true);
  const older = await svc.list("a", couple, { before: latest.messages[0].seq });
  assert.equal(older.messages.at(-1).seq, latest.messages[0].seq - 1);
  assert.equal(await store.kv.get(store.key("c", "c", "msg", 5)), null, "oldest dropped");
  assert.ok(await store.kv.get(store.key("c", "c", "msg", 6)));
});
