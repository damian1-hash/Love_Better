// Private chat for a linked couple: text, photos, videos and files.
//
// Messages are numbered (1, 2, 3…) so phones can ask "anything after #41?"
// with one cheap read. Attachments live in the same database, split into
// 700 KB pieces (Upstash takes at most 1 MB per request). The newest 1,000
// messages are kept; older ones and their attachments are removed.

import { randomUUID } from "node:crypto";
import { PairingError } from "./pairing.js";

const J = v => (v == null ? null : JSON.parse(v));
export const MAX_FILE_BYTES = 3 * 1024 * 1024;
const CHUNK = 700 * 1024;
const KEEP = 1000;
// Only these are ever shown inline; everything else is a download.
export const INLINE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif", "video/mp4", "video/quicktime", "video/webm"];

export class ChatService {
  constructor(store, opts = {}) { this.store = store; this.kv = store.kv; this.now = opts.now ?? (() => Date.now()); }
  #k(C, ...p) { return this.store.key("c", C, ...p); }

  async status(uid, couple) {
    const C = couple.id, partner = couple.members.find(m => m !== uid);
    const [last, reads, edit] = await Promise.all([this.kv.get(this.#k(C, "chatlast")), this.kv.hgetall(this.#k(C, "chatread")), this.kv.get(this.#k(C, "chatedit"))]);
    const lastSeq = Number(last) || 0, myRead = Number(reads[uid]) || 0;
    let unread = 0;
    if (lastSeq > myRead) {
      const from = Math.max(myRead + 1, lastSeq - 49);
      unread = (await this.#get(C, from, lastSeq)).filter(m => m.from === partner && !m.deleted).length;
    }
    // "edit" goes up whenever an older message changes (unsend), so phones know to refresh.
    return { last: lastSeq, myRead, partnerRead: Number(reads[partner]) || 0, unread, edit: Number(edit) || 0 };
  }

  async #get(C, from, to) {
    if (to < from) return [];
    const keys = []; for (let i = from; i <= to; i++) keys.push(this.#k(C, "msg", i));
    return (await this.kv.mget(...keys)).map(J).filter(Boolean);
  }

  // Newest messages (default), messages after #after, or 50 before #before.
  async list(uid, couple, { after, before } = {}) {
    const C = couple.id;
    const [st, hidden] = await Promise.all([this.status(uid, couple), this.kv.hgetall(this.#k(C, "chathide", uid))]);
    const last = st.last;
    let from, to;
    if (after != null && after !== "") { from = Number(after) + 1; to = Math.min(last, from + 199); }
    else { to = before ? Math.min(last, Number(before) - 1) : last; from = Math.max(1, to - 49); }
    // Messages you deleted for yourself are left out; your partner still sees them.
    const messages = (await this.#get(C, Math.max(from, last - KEEP + 1, 1), to)).filter(m => !hidden[m.seq]);
    return { ...st, messages, hasOlder: from > Math.max(1, last - KEEP + 1) };
  }

  async send(uid, couple, { text, file, replyTo }) {
    const C = couple.id;
    const body = String(text ?? "").trim();
    if (body.length > 4000) throw new PairingError("too_long", "That message is too long.");
    const reply = replyTo != null && replyTo !== "" ? await this.#quote(C, replyTo) : null;
    let att = null;
    if (file) att = await this.#saveFile(uid, C, file);
    if (!body && !att) throw new PairingError("empty", "Write something or attach a file.");
    const seq = await this.kv.incr(this.#k(C, "chatseq"));
    const msg = { seq, id: randomUUID(), from: uid, text: body, file: att, at: this.now() };
    if (reply) msg.reply = reply;
    // These writes don't depend on each other, so do them at the same time:
    // each database call is a network round trip, and they add up.
    await Promise.all([
      this.kv.set(this.#k(C, "msg", seq), JSON.stringify(msg)),
      this.#bumpLast(C, seq),
      this.read(uid, couple, seq),
      seq > KEEP ? this.#drop(C, seq - KEEP) : null,
    ]);
    return msg;
  }

  // "last" only moves forward, even if two messages are sent at the same moment.
  async #bumpLast(C, seq) {
    const cur = Number(await this.kv.get(this.#k(C, "chatlast"))) || 0;
    if (seq > cur) await this.kv.set(this.#k(C, "chatlast"), seq);
  }

  async #saveFile(uid, C, { name, type, data, w, h }) {
    const b64 = String(data || "").replace(/^data:[^;,]*;base64,/, "");
    if (!b64 || !/^[A-Za-z0-9+/=]+$/.test(b64)) throw new PairingError("bad_file", "That file couldn't be read.");
    const bytes = Buffer.from(b64, "base64");
    if (bytes.length > MAX_FILE_BYTES) throw new PairingError("too_large", "Files can be up to 3 MB.", 413);
    type = String(type || "application/octet-stream").toLowerCase().slice(0, 100);
    if (!/^[\w.+-]+\/[\w.+-]+$/.test(type)) type = "application/octet-stream";
    const kind = type.startsWith("image/") && INLINE_TYPES.includes(type) ? "image" : type.startsWith("video/") && INLINE_TYPES.includes(type) ? "video" : "file";
    const id = randomUUID(), chunks = Math.ceil(bytes.length / CHUNK);
    const meta = { id, from: uid, name: String(name || "file").replace(/[\\/\r\n"]/g, "_").slice(0, 120), type, size: bytes.length, kind, chunks,
      w: Math.min(10000, Number(w) || 0), h: Math.min(10000, Number(h) || 0) };
    // Nobody knows the file id until the message is saved, so the pieces and
    // the file details can all be written at once.
    await Promise.all([
      ...Array.from({ length: chunks }, (_, i) => this.kv.set(this.#k(C, "file", id, i), bytes.subarray(i * CHUNK, (i + 1) * CHUNK).toString("base64"))),
      this.kv.set(this.#k(C, "file", id), JSON.stringify(meta)),
    ]);
    return { id, name: meta.name, type, size: meta.size, kind, w: meta.w, h: meta.h };
  }

  async getFile(couple, id) {
    const C = couple.id, meta = J(await this.kv.get(this.#k(C, "file", String(id))));
    if (!meta) throw new PairingError("not_found", "That file is gone.", 404);
    const parts = await this.kv.mget(...Array.from({ length: meta.chunks }, (_, i) => this.#k(C, "file", meta.id, i)));
    if (parts.some(p => p == null)) throw new PairingError("not_found", "That file is gone.", 404);
    return { meta, bytes: Buffer.concat(parts.map(p => Buffer.from(p, "base64"))) };
  }

  async #deleteFile(C, id) {
    const meta = J(await this.kv.get(this.#k(C, "file", id)));
    if (!meta) return;
    await this.kv.del(this.#k(C, "file", id), ...Array.from({ length: meta.chunks }, (_, i) => this.#k(C, "file", id, i)));
  }
  async #drop(C, seq) {
    const m = J(await this.kv.get(this.#k(C, "msg", seq)));
    if (m && m.file) await this.#deleteFile(C, m.file.id);
    await this.kv.del(this.#k(C, "msg", seq));
  }

  // A short copy of the message being replied to, so the reply still makes
  // sense when the original is far up the chat.
  async #quote(C, seq) {
    seq = Number(seq);
    const m = Number.isInteger(seq) && seq > 0 ? J(await this.kv.get(this.#k(C, "msg", seq))) : null;
    if (!m || m.deleted) throw new PairingError("not_found", "The message you're replying to is gone.", 404);
    const text = m.text ? (m.text.length > 140 ? m.text.slice(0, 139) + "…" : m.text) : "";
    return { seq: m.seq, from: m.from, text, kind: m.file ? m.file.kind : null, name: m.file && m.file.kind === "file" ? m.file.name : undefined };
  }

  // Change the words of one of your own messages.
  async edit(uid, couple, seq, text) {
    const C = couple.id, k = this.#k(C, "msg", Number(seq)), m = J(await this.kv.get(k));
    if (!m || m.deleted) throw new PairingError("not_found", "That message is gone.", 404);
    if (m.from !== uid) throw new PairingError("forbidden", "You can only edit your own messages.", 403);
    const body = String(text ?? "").trim();
    if (body.length > 4000) throw new PairingError("too_long", "That message is too long.");
    if (!body && !m.file) throw new PairingError("empty", "A message can't be empty. Delete it instead.");
    if (body === m.text) return m;
    const out = { ...m, text: body, edited: this.now() };
    await this.kv.set(k, JSON.stringify(out));
    await this.kv.incr(this.#k(C, "chatedit"));
    return out;
  }

  // Delete for me: hide a message on your own phones only.
  async hide(uid, couple, seq) {
    seq = Number(seq);
    if (!Number.isInteger(seq) || seq < 1) throw new PairingError("bad_seq", "Invalid message number.");
    await this.kv.hset(this.#k(couple.id, "chathide", uid), String(seq), 1);
    return { hidden: true };
  }

  // Delete for everyone: only for your own messages.
  async unsend(uid, couple, seq) {
    const C = couple.id, k = this.#k(C, "msg", Number(seq)), m = J(await this.kv.get(k));
    if (!m) throw new PairingError("not_found", "That message is gone.", 404);
    if (m.from !== uid) throw new PairingError("forbidden", "You can only unsend your own messages.", 403);
    if (m.file) await this.#deleteFile(C, m.file.id);
    await this.kv.set(k, JSON.stringify({ seq: m.seq, id: m.id, from: m.from, at: m.at, deleted: true }));
    await this.kv.incr(this.#k(C, "chatedit"));
    return { unsent: true };
  }

  async read(uid, couple, seq) {
    seq = Number(seq);
    if (!Number.isInteger(seq) || seq < 0) throw new PairingError("bad_seq", "Invalid message number.");
    const k = this.#k(couple.id, "chatread"), cur = Number(await this.kv.hget(k, uid)) || 0;
    if (seq > cur) await this.kv.hset(k, uid, seq);
    return { read: Math.max(seq, cur) };
  }

  async deleteAll(couple) {
    const C = couple.id, last = Number(await this.kv.get(this.#k(C, "chatlast"))) || 0;
    for (let i = Math.max(1, last - KEEP + 1); i <= last; i++) await this.#drop(C, i);
    await this.kv.del(this.#k(C, "chatseq"), this.#k(C, "chatlast"), this.#k(C, "chatread"), this.#k(C, "chatedit"),
      ...couple.members.map(m => this.#k(C, "chathide", m)));
  }
}
