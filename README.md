# Love Better

Love Better Daily is a page-a-day reminder for loving people better. It includes **Heart Jump**, a game for two phones, and **code-based partner linking**.

## What's here

| Path | What it is |
| --- | --- |
| `public/index.html` | The app: daily reminders, streaks, saved reminders, Heart Jump, and the new **Link with your partner** card |
| `artifact/love-better-daily.html` | The original Love Better Daily artifact from claude.ai, unchanged, kept for reference |
| `src/pairing.js` | Partner-linking logic (invite codes) |
| `src/store.js` | In-memory storage (swap for a database) |
| `src/server.js` | Zero-dependency Node server: the app, the linking API, and a private live room for each couple |
| `test/` | Tests (`npm test`) |

## Run it

```bash
npm start          # http://localhost:3000  (PORT=... to change)
npm test
```

Needs Node 18+. There are no dependencies to install.

## How linking works

1. Partner A taps **Get a code** and gets a code like `KVK-DFY`, then shares it.
2. Partner B types it in and taps **Link**. Both phones now show "You're linked".
3. Heart Jump now connects the two linked phones through a private room that only the couple can join.

Rules:
- Codes are 6 characters with no look-alike characters (no 0/O or 1/I/L). Dashes, spaces and lowercase are accepted when typing.
- A code works **once** and **expires after 24 hours**. Making a new code cancels the old one.
- You can't use your own code, and nobody can be linked to two partners at once.
- After 5 wrong codes in 15 minutes, code entry is locked for a while to stop guessing.
- Either partner can **Unlink**. That ends the link for both of them and closes their room.

On claude.ai, Heart Jump still uses the artifact's built-in live room, as before.

## API

All requests identify the user with an `X-User-Id` header.

| Method & path | Body | Result |
| --- | --- | --- |
| `GET /api/link` | | `{ linked, partnerId, coupleId }` or `{ linked: false, invite }` |
| `POST /api/link/invite` | | `{ code, display, expiresAt }` |
| `DELETE /api/link/invite` | | `{ cancelled }` |
| `POST /api/link/redeem` | `{ code }` | `{ coupleId, partnerId, linkedAt }` |
| `DELETE /api/link` | | `{ unlinked, coupleId }` |
| `GET /api/room/events?uid=&peer=` | | Server-sent events: the couple's connected peers and their presence |
| `POST /api/room/presence` | `{ peer, patch }` | `{ ok }` |

Errors come back as `{ error, message }` with a fitting status code, for example `404 invalid_code`, `410 expired_code` or `429 too_many_attempts`.

## Before production

- **Identity:** each device makes a random id, which is fine for a demo. Replace `X-User-Id` with real sign-in so a link belongs to an account rather than a browser.
- **Storage:** `MemoryStore` is lost on restart. Back it with a database and run redeem in a transaction so two people can't claim the same code at the same moment.
