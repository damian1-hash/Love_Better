# Love Better

Love Better Daily is a page-a-day reminder for loving people better, plus a set of things to do with your partner.

<img src="public/icon-192.png" alt="Love Better logo" width="96" height="96">

![Love Better on a phone](docs/love-better-preview.png)

## Features

**Today:** the daily reminder and practice, your streak, saved reminders. Once your partner has taken the quiz, you also get a daily tip for loving them their way.

**Us** (after linking with your partner):
- **Days together:** counts from the day you linked, or from a date you set, with the next milestone and anniversary.
**Us → Long distance** (a switch at the top of the Us tab):
- **Right now:** set your status (free to talk, busy, asleep, awake) and see your partner's. Send a **good morning**, **good night** or **just because** note, either now (it buzzes their phone) or **waiting when they wake up** (it appears in their app from 07:00 their time).
- **Open-when letters:** sealed letters ("Open when you miss me…") that stay hidden until opened, optionally locked until a date. The writer learns when one is opened.
- **Photo wall:** share little moments. Photos are shrunk on the phone (max 1280 px), visible only to the two of you, and the wall keeps the latest 60.
- **Press play together:** a shared countdown (15 s, 30 s or 1 min) so you both press play on a film or song at the same second. Your partner gets a notification and sees the same countdown.
- **Virtual date night:** pick from 12 ideas for dates from afar, set a time, and both of you see a countdown in your own time zones.
- **The distance between us** (for long-distance couples): how many km and miles apart you are and which cities you're in, both your local times (morning or night there, hours ahead or behind), and a countdown to your next visit with a visit count. Each phone shares only its city (rounded to about 10 km), and only after choosing to.
- **Nudges:** one tap sends "Thinking of you", "Miss you", "Proud of you" or a hug. It pops up on your partner's screen and, with notifications on, on their phone.
- **Today:** your partner's mood and what would help them, plus your **shared streak**: the days you both practised the reminder.
- **Question for two:** a new question every day. Answers stay hidden until you've both answered. Earlier answers are kept.
- **How you each feel loved:** each person's love-language result, with a daily tip.
- **Dates to remember:** birthdays, anniversaries and trips, with countdowns. They can repeat every year.
- **Date ideas:** a shared list you both add to and tick off, with suggestions and a "Surprise me" button.

**Chat** (after linking): a private chat for the two of you. The **＋** button takes a photo with the **camera**, picks **photos and videos** from your library, or attaches any **file**. Photos are shrunk on the phone; videos and files can be up to 3 MB. It shows "Seen" receipts. **Swipe a message right to reply** to it (the reply quotes it; tap the quote to jump back). Tap a message, or press and hold a photo, for **Reply**, **Edit** (your own messages, marked "Edited"), **Copy text**, **Delete for me** (hidden only on your side) and **Delete for everyone** (your own messages). It sends notifications, and adds unread messages to the app icon badge. The newest 1,000 messages are kept. Only photos and videos display inside the app; every other file is a plain download, so an uploaded file can never run code in the app.

**Explore:** romantic and fun places near you, or near any town you search for. Pick a kind of place (romantic dinner, cafés & sweets, drinks, outdoors, culture, fun & games) and a distance (1–10 km). Each place shows its distance, walking time, cuisine, opening hours and outdoor seating, plus buttons for directions and its website. **Pick for us** chooses one for you, and **Save for a date** adds a place to your shared date ideas. Places come from **Geoapify** (fast, built on OpenStreetMap data). Without a Geoapify key, the phone asks OpenStreetMap's free servers directly instead, which works but can be slow.

**Games:** Heart Jump, the two-phone game, and the love-language quiz, at the bottom of the Us tab.

**Me:** your name, partner linking, your sign-in key, notifications, and installing the app.

**App icon badge and shortcuts:** once installed, the app icon shows a red number when your partner nudges you or answers the question for two. On Android, long-press the icon for shortcuts to Chat, Question for two, Places for two and Heart Jump. True home-screen widgets need a native app.

**Install and notifications:** the app installs to the home screen and works offline. It can send a morning reminder and a ping when your partner nudges you or answers the question.

## What's here

| Path | What it is |
| --- | --- |
| `public/index.html` | The original Love Better Daily page, arranged into tabs |
| `public/app.js` | Sign-in, linking, the Us tab, the quiz, notifications, install |
| `public/sw.js`, `manifest.webmanifest` | Installable app, offline support, notifications |
| `public/icon-*.png`, `apple-touch-icon.png`, `favicon-*.png`, `logo-mark.png`, `og-image.jpg` | Logo and app icons, made from `docs/logo-original.png` |
| `artifact/love-better-daily.html` | The original artifact from claude.ai, unchanged |
| `src/api.js` | Every API route, shared by the local server and Vercel |
| `src/auth.js` | Sign-in keys |
| `src/pairing.js` | Linking with invite codes |
| `src/couple.js` | Everything a couple shares |
| `src/push.js` | Web Push notifications (no dependencies) |
| `src/chat.js` | Chat messages and attachments |
| `src/ldr.js` | Long-distance features: status, notes, letters, photo wall, press play together, date night |
| `src/places.js` | Nearby places from Geoapify, and place search (Nominatim), cached |
| `public/places-core.js` | Place categories and the OpenStreetMap fallback, shared by phone and server |
| `src/store.js`, `src/kv.js` | Storage: Upstash Redis on Vercel, in-memory locally |
| `src/server.js` | Local server for `npm start` |
| `api/index.js` | The single Vercel function |
| `vercel.json` | Vercel settings: static `public/`, API rewrite, daily cron |
| `test/` | Tests (`npm test`) |

## Run it locally

```bash
npm start     # http://localhost:3000 (PORT=... to change)
npm test
```

Needs Node 18+. There are no dependencies to install. Locally, data is kept in memory unless the Upstash variables below are set.

## Deploy on Vercel

1. **Database (required).** In the Vercel project, open **Storage** (or **Marketplace**), add **Upstash for Redis**, and connect it to this project. This sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`.
2. **Notifications:** no setup needed. The server creates its notification keys the first time they're needed and stores them in the database. If you'd rather manage the keys yourself, run `npm run vapid` and set `VAPID_PUBLIC_KEY` and `VAPID_PRIVATE_KEY` (mark the private key Sensitive).
3. **Morning reminder:** works out of the box. Vercel calls `/api/cron/daily` every day at 07:00 UTC, and the reminder can't go out more than once a day, however often that address is called. Optionally, set `CRON_SECRET` (Sensitive) so only Vercel can trigger it. To change the time, edit `crons` in `vercel.json`. On the Hobby plan, Vercel runs it once a day, sometime within that hour.
4. **Fast place search (recommended).** Create a free account at [geoapify.com](https://www.geoapify.com/), create a project, copy its API key, and add it as `GEOAPIFY_API_KEY`. The free plan covers 3,000 requests a day, and results are cached per area for a day. The key stays on the server.
5. **Redeploy** so the variables take effect.

Without a database, the page still works and the Me tab explains what's missing.

**Notifications on iPhone:** add the app to the Home Screen first (Safari → Share → Add to Home Screen), then turn notifications on from the installed app. This needs iOS 16.4 or newer.

## Places and privacy

The phone rounds its location to about 100 m before sending it. The server caches results for each area (about 1 km) for a day, and the phone keeps its last 8 searches for a day. That keeps searches fast and the free quota safe. Each person can run up to 30 new searches a minute. The page credits Geoapify and OpenStreetMap contributors (ODbL), as their terms require.

Notes set to "waiting when they wake up" appear on time, but don't buzz the phone at 07:00. Vercel's Hobby plan runs scheduled jobs only once a day, so an exact-time notification would need a scheduling service such as Upstash QStash.

## Accounts and sign-in

There are no passwords. Each phone makes a secret **sign-in key** (25 characters), and the server only stores a hash of it. To use the same account on a new phone, copy the key or the **sign-in link** from the Me tab. Lose the key and the account is lost, so the app reminds people to save it.

## How linking works

1. Partner A taps **Get a code** (for example `KVK-DFY`) and shares it.
2. Partner B enters it and taps **Link**.
3. Codes work once, expire after 24 hours, and can't be used by their owner. Nobody can be linked to two people. After 5 wrong codes in 15 minutes, code entry is locked for a while.
4. Either partner can **Unlink**. That deletes everything the couple shared.

## API

Every request (except `/api/push/key` and the cron) sends `Authorization: Bearer <sign-in key>`. Errors come back as `{ error, message }`.

| Route | Body / query | |
| --- | --- | --- |
| `GET /api/me`, `PUT /api/me` | `{ name }` | Your profile and link status |
| `GET /api/link` | | Link status |
| `POST /api/link/invite`, `DELETE /api/link/invite` | | Make or cancel your code |
| `POST /api/link/redeem` | `{ code }` | Link with the code's owner |
| `DELETE /api/link` | | Unlink, deleting shared data |
| `GET /api/us` | `?date=YYYY-MM-DD` | Everything for the Us tab |
| `GET /api/us/answers` | `?date=` | The last 14 days both of you answered |
| `POST /api/us/answer` | `{ date, text }` | Answer the question for two |
| `POST /api/us/nudge` | `{ kind }`: `thinking`, `miss`, `proud`, `hug` | |
| `PUT /api/us/practice` | `{ dates: [...] }` | Days you practised |
| `PUT /api/us/mood` | `{ date, mood, need }` | |
| `PUT /api/us/since` | `{ since }` | Together-since date |
| `PUT /api/us/where`, `DELETE /api/us/where` | `{ lat, lon }` | Share or stop sharing your city (stored rounded to ~10 km) |
| `PUT /api/us/tz` | `{ tz }` | Your time zone |
| `PUT /api/us/reunion` | `{ date, place, today }` | Next visit (`date: null` removes it) |
| `PUT /api/us/visits` | `{ visits }` | Correct the visit count |
| `PUT /api/us/status` | `{ state }`: `free`, `busy`, `asleep`, `awake` | Your status |
| `POST /api/us/notes` | `{ kind: morning\|night\|love, text, when: now\|wake }` | Send a note |
| `POST /api/us/letters`, `DELETE /api/us/letters?id=` | `{ title, body, unlockDate }` | Write or delete a letter |
| `POST /api/us/letters/open` | `{ id, today }` | Open a letter addressed to you |
| `POST /api/us/photos`, `DELETE /api/us/photos?id=` | `{ data (image data URL), caption, w, h }` | Share or remove a photo (≤ 400 KB) |
| `GET /api/us/photo?id=` | | The photo itself (needs your key) |
| `POST /api/us/sync`, `DELETE /api/us/sync` | `{ title, delay }` | Start or cancel a press-play countdown |
| `PUT /api/us/datenight` | `{ at (ms), idea }` | Plan (or clear with `at: null`) a date night |
| `POST /api/us/dates`, `DELETE /api/us/dates?id=` | `{ title, date, yearly }` | |
| `POST /api/us/ideas`, `PATCH /api/us/ideas`, `DELETE /api/us/ideas?id=` | `{ text }`, `{ id, done }` | |
| `PUT /api/us/lang` | `{ scores }` | Quiz result |
| `GET /api/places` | `?lat=&lon=&radius=1000\|2000\|5000\|10000&cat=dinner\|cafe\|drinks\|outdoors\|culture\|fun` | Places nearby |
| `GET /api/places/search` | `?q=` | Find a town or area |
| `GET /api/chat` | `?after=N` or `?before=N` | Messages (newest 50, after #N, or 50 before #N), plus read receipts |
| `POST /api/chat` | `{ text, file: { name, type, data (base64), w, h }, replyTo }` | Send a message (file ≤ 3 MB), optionally replying to message #`replyTo` |
| `PATCH /api/chat` | `{ seq, text }` | Edit your own message |
| `DELETE /api/chat?seq=` | | Delete your message for everyone |
| `DELETE /api/chat?for=me&seq=` | | Delete any message for yourself only |
| `POST /api/chat/read` | `{ seq }` | Mark messages read |
| `GET /api/chat/file?id=` | | An attachment (needs your key) |
| `GET /api/push/key` | | Public key for notifications |
| `POST /api/push/subscribe`, `DELETE /api/push/subscribe` | `{ subscription }`, `{ endpoint }` | |
| `POST /api/push/test` | | Sends yourself a test notification |
| `GET /api/room?peer=`, `POST /api/room/presence` | `{ peer, presence }` | Heart Jump |
| `GET /api/cron/daily` | `Authorization: Bearer $CRON_SECRET` | Morning reminder to everyone |
