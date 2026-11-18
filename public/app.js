/* Love Better: accounts, partner linking, the "Us" tab, the quiz,
   notifications and install. Loaded before the original page script, which
   calls into window.LB at a few points. */
(function () {
"use strict";

/* ---------------- helpers ---------------- */
const $ = id => document.getElementById(id);
function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "text") el.textContent = v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
  return el;
}
const ls = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  del(k) { try { localStorage.removeItem(k); } catch (e) {} },
};
const pad = n => String(n).padStart(2, "0");
const today = () => { const d = new Date(); return d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()); };
const dayNum = s => { const [y, m, d] = s.split("-").map(Number); return Math.round(Date.UTC(y, m - 1, d) / 864e5); };
const fmtDate = (s, opts) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d).toLocaleDateString(undefined, opts || { day: "numeric", month: "long", year: "numeric" }); };
const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
const dailyPick = (list, salt) => list[(((dayNum(today()) + (salt || 0)) % list.length) + list.length) % list.length];

/* ---------------- content ---------------- */
const QUESTIONS = [
"What's a small thing I do that makes you feel loved?",
"What's a memory of us you replay when you miss me?",
"What's one thing you'd love us to try together this year?",
"When did you first know you really liked me?",
"What does a perfect lazy Sunday with me look like?",
"What's something you're proud of me for lately?",
"What's one way I could support you better this week?",
"Which song feels like our song, and why?",
"What's a habit of mine you secretly find adorable?",
"Where in the world would you take me tomorrow if you could?",
"What did your family teach you about love?",
"What's a dream you haven't told many people?",
"What's the best gift you've ever received, from anyone?",
"What makes you feel most at home with me?",
"What's one thing you'd like us to do more of?",
"What's a fear you'd like me to understand better?",
"What's your favourite photo of us, and why?",
"How do you like to be comforted when you're sad?",
"What's something new you've learned about yourself this year?",
"If our relationship were a film, what would it be called?",
"What's a tiny tradition you'd like us to start?",
"What's the funniest moment we've shared?",
"What's one thing you need more of from me right now?",
"What's a compliment you'd love to hear more often?",
"What does a good day look like for you?",
"What are you looking forward to most this month?",
"What did you think of me the first time we met?",
"What's a place that feels special because of us?",
"What's one thing on your mind that you haven't said yet?",
"How can I make your mornings a little easier?",
"What's a challenge we got through that made us stronger?",
"What's something you want us to be like in ten years?",
"What's your favourite way to spend time with me?",
"What's a meal that reminds you of us?",
"What's one thing I do that instantly calms you down?",
"What's a skill you'd like us to learn together?",
"What made you smile today?",
"What's something you're grateful for about us this week?",
"If you could relive one day with me, which would it be?",
"What's a promise you'd like to make to me?",
"What's one thing that always cheers you up?",
"What's something you'd like me to ask you about more often?",
"When do you feel closest to me?",
"What's a book, show or film you'd like us to share?",
"What's a way I've changed you for the better?",
"What would you write in a note to us a year from now?",
"How do you like to celebrate good news?",
"What's one boundary that helps you feel safe with me?",
"What's a childhood memory that still makes you happy?",
"What does romance mean to you?",
"What's one small adventure we could have this weekend?",
"What's a quality of mine you hope never changes?",
"What's something you've forgiven me for that I might not know about?",
"When you're stressed, what do you wish I'd do?",
"What's the kindest thing someone did for you recently?",
"What are three words you'd use to describe us?",
"What's a goal of yours I can help with?",
"Which of our inside jokes is your favourite?",
"What's something about the future that excites you?",
"What's one thing you'd like to say thank you for?"
];

const MOODS = [["great", "😄", "Great"], ["good", "🙂", "Good"], ["okay", "😐", "Okay"], ["low", "😔", "Low"], ["stressed", "😣", "Stressed"], ["tired", "😴", "Tired"]];
const NEEDS = [["space", "Some space"], ["hug", "A hug"], ["talk", "To talk"], ["help", "A hand"], ["fun", "Some fun"]];
const NUDGES = [["thinking", "💭", "Thinking of you", "is thinking of you"], ["miss", "🥺", "Miss you", "misses you"], ["proud", "🌟", "Proud of you", "is proud of you"], ["hug", "🤗", "Hug", "sent you a hug"]];

const LANGS = {
  words: { name: "Words of affirmation", short: "Words", tips: [
    "Tell them one specific thing you admire about them today.",
    "Leave a short note where they'll find it.",
    "Send a message in the middle of their day saying why you're glad they're yours.",
    "Praise them in front of someone else.",
    "Say thank you for something small, out loud." ] },
  time: { name: "Quality time", short: "Time", tips: [
    "Give them twenty phone-free minutes tonight.",
    "Go for a short walk together, just the two of you.",
    "Ask about their day, then ask a follow-up question.",
    "Cook or eat together without a screen on.",
    "Plan one small thing to look forward to this week." ] },
  gifts: { name: "Thoughtful gifts", short: "Gifts", tips: [
    "Bring them their favourite snack, just because.",
    "Pick a flower, a leaf or a stone on your walk and give it to them.",
    "Save something that reminded you of them and hand it over tonight.",
    "Make them a playlist.",
    "Write a tiny card. The thought is the gift." ] },
  service: { name: "Acts of service", short: "Help", tips: [
    "Do one chore they usually do, without mentioning it.",
    "Ask: what's one thing I can take off your plate today?",
    "Make their tea or coffee exactly how they like it.",
    "Handle a small errand they've been putting off.",
    "Get something ready for their tomorrow tonight." ] },
  touch: { name: "Physical touch", short: "Touch", tips: [
    "Give them a long hug, longer than usual.",
    "Hold hands on your next walk.",
    "Sit close on the sofa tonight.",
    "Offer a shoulder or hand massage.",
    "Greet them with a kiss when you see them." ] },
};
const QUIZ = [
  ["words", "They tell me how much I mean to them.", "time", "We spend an evening together with no distractions."],
  ["words", "I get a sweet message out of the blue.", "gifts", "They bring me a small surprise they picked out."],
  ["words", "They say they're proud of me.", "service", "They take care of a task I've been dreading."],
  ["words", "They compliment me sincerely.", "touch", "They hug me when they get home."],
  ["time", "We go for a long walk and really talk.", "gifts", "They remember something I wanted and get it for me."],
  ["time", "They give me their full attention.", "service", "They cook dinner so I can rest."],
  ["time", "We do a hobby together.", "touch", "We sit close and hold hands."],
  ["gifts", "They bring back something from a trip that made them think of me.", "service", "They help me without being asked."],
  ["gifts", "A thoughtful gift on an ordinary day.", "touch", "A back rub after a long day."],
  ["service", "They fix something that's been bugging me.", "touch", "They reach for my hand in public."],
];

const IDEAS = [
  "Cook a dish neither of you has made before", "Sunrise or sunset walk", "Picnic in the park", "Board game night",
  "Visit a museum or gallery", "Try a new café across town", "Stargazing with a blanket", "Dance in the kitchen",
  "Write each other letters, read them aloud", "Bike ride somewhere new", "Movie marathon with homemade snacks",
  "Take a class together", "Breakfast in bed", "Go to a live music night", "Photo walk: capture 10 things you love",
  "Plan a dream trip together", "Volunteer together for a morning", "Have an indoor picnic", "Go to a farmers' market",
  "Recreate your first date", "Karaoke night", "Bake something together", "Try a sport neither of you plays",
  "Phone-free evening", "Visit a botanical garden", "Make a scrapbook of your year", "Spa night at home",
  "Watch the sunrise from somewhere high", "Explore a neighbourhood you've never walked", "Build a blanket fort",
];

/* ---------------- account ---------------- */
const KEY_ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const normKey = s => String(s || "").toUpperCase().replace(/[^0-9A-Z]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1").replace(/U/g, "V");
const validKey = k => k.length === 25 && [...k].every(c => KEY_ALPHABET.includes(c));
const showKey = k => k.match(/.{1,5}/g).join("-");
function newKey() {
  const b = new Uint8Array(25); crypto.getRandomValues(b);
  return [...b].map(x => KEY_ALPHABET[x & 31]).join("");
}
let KEY = ls.get("lb-key", null);
if (!KEY || !validKey(KEY)) { KEY = newKey(); ls.set("lb-key", KEY); ls.set("lb-key-new", true); }

// Signing in on another phone with a link: .../#key=XXXXX-...
(function importKeyFromLink() {
  const m = /[#&]key=([0-9A-Za-z-]+)/.exec(location.hash);
  if (!m) return;
  const k = normKey(m[1]);
  history.replaceState(null, "", location.pathname + location.search);
  if (!validKey(k) || k === KEY) return;
  if (confirm("Sign in on this phone with the key from your link? This replaces the account on this phone.")) {
    KEY = k; ls.set("lb-key", k); ls.del("lb-key-new"); ls.set("lb-tab", "me");
  }
})();

async function api(method, path, body) {
  const res = await fetch(path, {
    method, headers: { "Content-Type": "application/json", Authorization: "Bearer " + KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) { const e = new Error(data.message || "Something went wrong. Try again."); e.code = data.error; e.status = res.status; throw e; }
  return data;
}

/* ---------------- state ---------------- */
const S = {
  online: null,       // null = unknown, true = API reachable, false = no API (e.g. opened as a file)
  setup: null,        // server says a database is needed
  me: null,           // { id, name, link }
  us: null,           // summary for the Us tab
  usErr: null,
  history: null,
  tab: ls.get("lb-tab", "today"),
  pushOn: false,
  pushKey: undefined,
  installEvt: null,
};
const linked = () => !!(S.me && S.me.link && S.me.link.linked);
const partnerName = () => (S.us && S.us.partner.name) || (S.me && S.me.link && S.me.link.partnerName) || "your partner";
const PartnerName = () => { const n = partnerName(); return n === "your partner" ? "Your partner" : n; };

async function loadMe() {
  try {
    const was = linked();
    S.me = await api("GET", "/api/me"); S.online = true; S.setup = null;
    if (was !== linked() && !/^Linked!/.test(meMsg.text)) meMsg = { text: "", err: false };
  } catch (e) {
    if (e.code === "setup_required") { S.online = true; S.setup = e.message; }
    else if (S.online == null) S.online = false;
  }
  renderAll();
  if (linked()) { await loadUs(); syncPractice(); }
}
async function loadUs() {
  if (!linked()) { S.us = null; return renderAll(); }
  try { S.us = await api("GET", "/api/us?date=" + today()); S.usErr = null; }
  catch (e) { S.usErr = e.message; if (e.code === "not_linked") return loadMe(); }
  checkNudge();
  renderAll();
}

/* ---------------- tabs ---------------- */
const TABS = ["today", "us", "explore", "play", "me"];
function setTab(t, fromHash) {
  if (!TABS.includes(t)) t = "today";
  S.tab = t; ls.set("lb-tab", t);
  for (const el of document.querySelectorAll(".tab")) el.hidden = el.dataset.tab !== t;
  for (const b of document.querySelectorAll(".tabbar button")) {
    if (b.dataset.go === t) b.setAttribute("aria-current", "page"); else b.removeAttribute("aria-current");
  }
  if (!fromHash) window.scrollTo(0, 0);
  if (t === "us" && linked()) loadUs();
  if (t === "explore" && X.where && !X.places && !X.loading) loadPlaces();
  renderAll();
}
document.querySelectorAll(".tabbar button").forEach(b => b.addEventListener("click", () => setTab(b.dataset.go)));
function tabFromHash() {
  const t = location.hash.replace("#", "");
  if (TABS.includes(t)) { setTab(t, true); history.replaceState(null, "", location.pathname + location.search); }
}
window.addEventListener("hashchange", tabFromHash);

/* ---------------- toast ---------------- */
let toastTimer = null;
function toast(emoji, text, btnText, onBtn) {
  $("toastEmoji").textContent = emoji; $("toastText").textContent = text;
  const b = $("toastBtn"); b.hidden = !btnText; b.textContent = btnText || "";
  b.onclick = () => { $("toast").classList.remove("show"); onBtn && onBtn(); };
  $("toast").classList.add("show");
  clearTimeout(toastTimer); toastTimer = setTimeout(() => $("toast").classList.remove("show"), 6000);
}
function checkNudge() {
  const n = S.us && S.us.nudge;
  if (!n) return;
  const seen = ls.get("lb-nudge-seen", 0);
  if (n.at <= seen) return;
  ls.set("lb-nudge-seen", n.at);
  if (Date.now() - n.at > 3 * 864e5) return;
  const kind = NUDGES.find(x => x[0] === n.kind) || NUDGES[0];
  toast(kind[1], PartnerName() + " " + kind[3], "Send one back", () => setTab("us"));
}

/* ---------------- Me tab ---------------- */
let meMsg = { text: "", err: false };
const say = (text, err) => { meMsg = { text, err: !!err }; renderMe(); };

function renderMe() {
  const tab = $("tab-me"); tab.replaceChildren();
  if (S.online === false) {
    tab.append(h("section", { class: "card" }, h("h2", { text: "Link with your partner" }),
      h("p", { class: "sub", text: "Linking needs the Love Better server. Open the app from its web address to link with your partner." })));
    return;
  }
  if (S.setup) {
    tab.append(h("section", { class: "card" }, h("h2", { text: "Link with your partner" }), h("p", { class: "msg err", text: S.setup })));
    return;
  }
  if (!S.me) { tab.append(h("section", { class: "card" }, h("p", { class: "sub", text: "Loading…" }))); return; }

  // Name
  const nameIn = h("input", { class: "field", id: "nameIn", maxlength: 40, autocomplete: "given-name", placeholder: "Your first name", value: S.me.name || "" });
  tab.append(h("section", { class: "card", "aria-labelledby": "nameH" },
    h("h2", { id: "nameH", text: "Your name" }),
    h("p", { class: "sub", text: "Your partner sees this on nudges and answers." }),
    h("form", { class: "row", onsubmit: async e => {
      e.preventDefault();
      try { const p = await api("PUT", "/api/me", { name: nameIn.value }); S.me.name = p.name; say("Saved."); }
      catch (err) { say(err.message, true); }
    } }, nameIn, h("button", { class: "btn", type: "submit", text: "Save" }))));

  // Link
  const L = S.me.link;
  const link = h("section", { class: "card", id: "linkCard", "aria-labelledby": "linkH" }, h("h2", { id: "linkH", text: "Link with your partner" }));
  if (L.linked) {
    link.append(
      h("p", { class: "linked", text: "You're linked with " + (L.partnerName || "your partner") + " ♥" }),
      h("p", { class: "small", text: "Since " + new Date(L.linkedAt).toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" }) }),
      h("div", { class: "row" }, h("button", { class: "btn small", text: "Unlink", onclick: async () => {
        if (!confirm("Unlink from " + (L.partnerName || "your partner") + "? Your shared answers, dates and ideas will be deleted for both of you.")) return;
        try { await api("DELETE", "/api/link"); say("Unlinked."); S.us = null; await loadMe(); } catch (e) { say(e.message, true); }
      } })));
  } else {
    const inv = L.invite;
    const codeIn = h("input", { class: "field code", id: "codeIn", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", maxlength: 9, placeholder: "ABC-123", "aria-label": "Partner's code" });
    link.append(h("p", { class: "sub", text: "Make a code and send it to your partner, or enter the code they sent you. Codes work once and expire after 24 hours." }));
    if (inv) link.append(h("div", {}, h("p", { class: "eyebrow", text: "Your code" }), h("p", { class: "codebox", id: "myCode", text: inv.display }),
      h("p", { class: "small", text: "Expires " + new Date(inv.expiresAt).toLocaleString(undefined, { weekday: "short", hour: "numeric", minute: "2-digit" }) })));
    link.append(
      h("div", { class: "row" },
        h("button", { class: "btn accent", id: "makeCode", text: inv ? "New code" : "Get a code", onclick: async () => {
          try { await api("POST", "/api/link/invite"); meMsg = { text: "Send this code to your partner.", err: false }; await loadMe(); } catch (e) { say(e.message, true); }
        } }),
        inv && h("button", { class: "btn", id: "shareCode", text: "Share code", onclick: async () => {
          const text = "Link with me on Love Better ♥ My code is " + inv.display;
          try { if (navigator.share) await navigator.share({ text, url: location.origin }); else { await navigator.clipboard.writeText(text + " " + location.origin); say("Copied. Paste it to your partner."); } } catch (e) {}
        } }),
        inv && h("button", { class: "btn", text: "Cancel code", onclick: async () => { try { await api("DELETE", "/api/link/invite"); meMsg = { text: "", err: false }; await loadMe(); } catch (e) { say(e.message, true); } } })),
      h("form", { class: "row", id: "redeemForm", onsubmit: async e => {
        e.preventDefault();
        if (!codeIn.value.trim()) return say("Enter the code your partner sent you.", true);
        try { await api("POST", "/api/link/redeem", { code: codeIn.value }); meMsg = { text: "Linked! Head to Us to see what you can do together.", err: false }; await loadMe(); }
        catch (err) { say(err.message, true); }
      } }, codeIn, h("button", { class: "btn", type: "submit", text: "Link" })));
  }
  link.append(h("p", { class: "msg" + (meMsg.err ? " err" : ""), id: "linkMsg", "aria-live": "polite", text: meMsg.text }));
  tab.append(link);

  // Sign-in key
  const shown = !!S.showKey;
  const isNew = ls.get("lb-key-new", false);
  const keyIn = h("input", { class: "field", autocomplete: "off", autocapitalize: "characters", spellcheck: "false", placeholder: "XXXXX-XXXXX-XXXXX-XXXXX-XXXXX", "aria-label": "Sign-in key" });
  tab.append(h("section", { class: "card", "aria-labelledby": "keyH" },
    h("h2", { id: "keyH", text: "Your sign-in key" }),
    h("p", { class: "sub", text: "This key is your account. Save it somewhere safe, like a password manager. Use it to sign in on a new phone. Anyone with it can act as you, so keep it private." }),
    isNew && L.linked && h("p", { class: "msg err", text: "You haven't saved your key yet. If you lose this phone, you'll lose your link." }),
    shown ? h("p", { class: "keybox", id: "keyText", text: showKey(KEY) }) : null,
    h("div", { class: "row" },
      h("button", { class: "btn small", text: shown ? "Hide key" : "Show key", onclick: () => { S.showKey = !shown; renderMe(); } }),
      h("button", { class: "btn small", text: "Copy key", onclick: async () => {
        try { await navigator.clipboard.writeText(showKey(KEY)); ls.del("lb-key-new"); say("Key copied. Paste it somewhere safe."); } catch (e) { S.showKey = true; ls.del("lb-key-new"); say("Copy is blocked here. Write the key down instead."); }
      } }),
      h("button", { class: "btn small", text: "Sign-in link", onclick: async () => {
        const url = location.origin + location.pathname + "#key=" + showKey(KEY);
        try { await navigator.clipboard.writeText(url); ls.del("lb-key-new"); say("Sign-in link copied. Open it on your other phone. Don't send it to anyone else."); } catch (e) { say("Copy is blocked here.", true); }
      } })),
    h("details", {}, h("summary", { class: "linkbtn", text: "Use a key from another phone" }),
      h("form", { class: "row", style: "margin-top:10px", onsubmit: e => {
        e.preventDefault();
        const k = normKey(keyIn.value);
        if (!validKey(k)) return say("That key doesn't look right. It's 25 letters and numbers.", true);
        if (!confirm("Switch this phone to that account? Save this phone's current key first if you still need it.")) return;
        KEY = k; ls.set("lb-key", k); ls.del("lb-key-new"); S.me = null; S.us = null; say("Signed in."); loadMe();
      } }, keyIn, h("button", { class: "btn", type: "submit", text: "Sign in" })))));

  // Notifications
  tab.append(renderNotifyCard());
  // Install
  tab.append(renderInstallCard());
}

/* ---------------- Us tab ---------------- */
const draft = ls.get("lb-drafts", {});
const saveDraft = (k, v) => { draft[k] = v; ls.set("lb-drafts", draft); };
let usMsg = "";

function nextOccurrence(date, yearly, from) {
  if (!yearly) return date;
  const [, m, d] = date.split("-");
  const y = Number(from.slice(0, 4));
  let cand = y + "-" + m + "-" + d;
  if (dayNum(cand) < dayNum(from)) cand = (y + 1) + "-" + m + "-" + d;
  return cand;
}
function milestone(days, since, t) {
  const opts = [];
  const next100 = (Math.floor(days / 100) + 1) * 100;
  opts.push([next100 - days, next100.toLocaleString() + " days together"]);
  const ann = nextOccurrence(since, true, t), years = Number(ann.slice(0, 4)) - Number(since.slice(0, 4));
  if (years > 0) opts.push([dayNum(ann) - dayNum(t), years === 1 ? "Your first anniversary" : "Your " + years + "-year anniversary"]);
  opts.sort((a, b) => a[0] - b[0]);
  return opts[0];
}

function renderUs() {
  const tab = $("tab-us"); tab.replaceChildren();
  if (!linked()) {
    tab.append(h("section", { class: "card", style: "align-items:flex-start" },
      h("h2", { text: "Just the two of you" }),
      h("p", { class: "sub", text: "Link with your partner to unlock a daily question for two, nudges, a shared streak, mood check-ins, your days together, special dates and a date-idea list." }),
      h("button", { class: "btn accent", text: S.setup ? "See what's needed" : "Link with your partner", onclick: () => setTab("me") })));
    return;
  }
  const U = S.us;
  if (!U) { tab.append(h("section", { class: "card" }, h("p", { class: "sub", text: S.usErr || "Loading…" }))); return; }
  const t = U.date, P = PartnerName(), p = partnerName();

  // Days together
  const [inDays, label] = milestone(U.together.days, U.together.since, t);
  const sinceIn = h("input", { class: "field", type: "date", value: U.together.since, max: t, "aria-label": "Together since" });
  tab.append(h("section", { class: "card hero" },
    h("span", { class: "names", text: (U.me.name || "You") + " & " + P }),
    h("div", { class: "big" }, U.together.days.toLocaleString(), h("small", { text: U.together.days === 1 ? "day together" : "days together" })),
    h("p", { class: "sub", text: "Since " + fmtDate(U.together.since) + (inDays > 0 ? " · " + label + " in " + plural(inDays, "day") : " · " + label + " today 🎉") }),
    S.editSince
      ? h("form", { class: "row", onsubmit: async e => { e.preventDefault(); try { await api("PUT", "/api/us/since", { since: sinceIn.value }); S.editSince = false; loadUs(); } catch (err) { usMsg = err.message; renderUs(); } } },
          sinceIn, h("button", { class: "btn accent small", type: "submit", text: "Save" }))
      : h("button", { class: "linkbtn", style: "align-self:flex-start", text: U.together.sinceSet ? "Change the date" : "Been together longer? Set the date", onclick: () => { S.editSince = true; renderUs(); } })));

  // Nudges
  tab.append(h("section", { class: "card", "aria-labelledby": "nudgeH" },
    h("h2", { id: "nudgeH", text: "Send " + p + " a little something" }),
    h("div", { class: "nudges" }, NUDGES.map(([kind, emoji, text]) => h("button", { onclick: async ev => {
      const b = ev.currentTarget; b.disabled = true;
      try { await api("POST", "/api/us/nudge", { kind }); toast(emoji, "Sent to " + p + "."); }
      catch (e) { toast("⚠️", e.message); }
      setTimeout(() => { b.disabled = false; }, 1500);
    } }, h("span", { text: emoji }), text)))));

  // Today: partner status + streak
  const pm = U.partner.mood, moodOf = m => MOODS.find(x => x[0] === m.mood), needOf = m => NEEDS.find(x => x[0] === m.need);
  tab.append(h("section", { class: "card", "aria-labelledby": "todayH" },
    h("h2", { id: "todayH", text: "Today" }),
    h("div", { class: "stats" },
      h("div", { class: "stat" }, h("span", { class: "eyebrow", text: P + " feels" }),
        pm ? h("b", { text: moodOf(pm)[1] + " " + moodOf(pm)[2] }) : h("b", { class: "small", style: "font-size:16px", text: "Not shared yet" }),
        pm && pm.need ? h("span", { class: "small", text: "Would love " + needOf(pm)[1].toLowerCase() }) : null),
      h("div", { class: "stat" }, h("span", { class: "eyebrow", text: "Shared streak" }),
        h("b", { text: plural(U.streak.days, "day") }),
        h("span", { class: "small" + (U.streak.bothToday ? " ok" : ""), text: U.streak.bothToday ? "You both practised today ✓" : U.partner.practised ? P + " practised today. Your turn!" : U.me.practised ? "You practised. Waiting on " + p + "." : "Practise today's reminder together" }))),
    h("p", { class: "eyebrow", style: "margin-top:4px", text: "How are you feeling?" }),
    h("div", { class: "chips", role: "group", "aria-label": "Your mood" }, MOODS.map(([m, e, l]) => h("button", { class: "chip", "aria-pressed": String(!!(U.me.mood && U.me.mood.mood === m)), onclick: () => setMood(m, U.me.mood && U.me.mood.need || "") }, e + " " + l))),
    U.me.mood ? h("p", { class: "eyebrow", text: "What would help?" }) : null,
    U.me.mood ? h("div", { class: "chips", role: "group", "aria-label": "What would help" }, NEEDS.map(([n, l]) => h("button", { class: "chip", "aria-pressed": String(U.me.mood.need === n), onclick: () => setMood(U.me.mood.mood, U.me.mood.need === n ? "" : n) }, l))) : null));

  // Question for two
  const Q = U.question, qText = dailyPick(QUESTIONS);
  const qCard = h("section", { class: "card", "aria-labelledby": "qH" }, h("span", { class: "eyebrow", id: "qH", text: "Question for two" }), h("p", { class: "qtext", text: qText }));
  const ansBox = (who, a) => h("div", { class: "answer" }, h("span", { class: "eyebrow", text: who }), h("p", { text: a.text }));
  if (Q.mine && !S.editAnswer) {
    qCard.append(ansBox("You", Q.mine));
    qCard.append(Q.theirs ? ansBox(P, Q.theirs) : h("p", { class: "sub", text: P + " hasn't answered yet. Their answer appears here once they do." }));
    qCard.append(h("button", { class: "linkbtn", style: "align-self:flex-start", text: "Edit my answer", onclick: () => { S.editAnswer = true; saveDraft("q" + t, Q.mine.text); renderUs(); } }));
  } else {
    const ta = h("textarea", { class: "field", maxlength: 500, placeholder: "Your answer…", "aria-label": "Your answer", oninput: e => saveDraft("q" + t, e.target.value) });
    ta.value = draft["q" + t] || "";
    qCard.append(
      Q.partnerAnswered && !Q.mine ? h("p", { class: "sub", text: P + " has answered! Answer too to see what they said." }) : null,
      ta,
      h("div", { class: "row" }, h("button", { class: "btn accent", text: Q.mine ? "Save answer" : "Share my answer", onclick: async ev => {
        if (!ta.value.trim()) return;
        ev.currentTarget.disabled = true;
        try { await api("POST", "/api/us/answer", { date: t, text: ta.value }); delete draft["q" + t]; ls.set("lb-drafts", draft); S.editAnswer = false; await loadUs(); }
        catch (e) { usMsg = e.message; renderUs(); }
      } })));
  }
  qCard.append(h("details", { ontoggle: async e => {
    if (!e.target.open || S.history) return;
    try { S.history = (await api("GET", "/api/us/answers?date=" + t)).days; } catch (err) { S.history = []; }
    renderUs();
  }, open: S.history ? true : null }, h("summary", { class: "linkbtn", text: "Earlier answers" }),
    S.history == null ? h("p", { class: "small", text: "Loading…" })
      : !S.history.length ? h("p", { class: "small", style: "margin-top:8px", text: "Days you've both answered will show up here." })
      : h("div", { style: "display:flex;flex-direction:column;gap:14px;margin-top:10px" }, S.history.map(d => h("div", { style: "display:flex;flex-direction:column;gap:6px" },
          h("span", { class: "eyebrow", text: fmtDate(d.date, { weekday: "short", day: "numeric", month: "short" }) }),
          h("p", { style: "font-family:var(--display);font-size:18px", text: QUESTIONS[((dayNum(d.date) % QUESTIONS.length) + QUESTIONS.length) % QUESTIONS.length] }),
          ansBox("You", d.mine), ansBox(P, d.theirs))))));
  tab.append(qCard);

  // Love languages
  const pl = U.partner.lang, ml = U.me.lang;
  tab.append(h("section", { class: "card", "aria-labelledby": "langH" },
    h("h2", { id: "langH", text: "How you each feel loved" }),
    h("div", { class: "stats" },
      h("div", { class: "stat" }, h("span", { class: "eyebrow", text: "You" }), h("b", { style: "font-size:20px", text: ml ? LANGS[ml.primary].name : "Take the quiz" })),
      h("div", { class: "stat" }, h("span", { class: "eyebrow", text: P }), h("b", { style: "font-size:20px", text: pl ? LANGS[pl.primary].name : "Not yet" }))),
    pl ? h("p", { text: "💡 " + dailyPick(LANGS[pl.primary].tips, 3) }) : h("p", { class: "sub", text: "When " + p + " takes the quiz, you'll get a daily tip for loving them their way." }),
    !ml ? h("button", { class: "btn accent", style: "align-self:flex-start", text: "Take the 1-minute quiz", onclick: () => { setTab("play"); startQuiz(); } }) : null));

  // Special dates
  const titleIn = h("input", { class: "field", maxlength: 60, placeholder: "e.g. Anniversary, Ada's birthday", "aria-label": "What's the date?" });
  const dateIn = h("input", { class: "field", type: "date", "aria-label": "Date" });
  const yearlyIn = h("input", { type: "checkbox", checked: true });
  const dates = U.dates.map(d => ({ ...d, next: nextOccurrence(d.date, d.yearly, t) })).sort((a, b) => dayNum(a.next) - dayNum(b.next));
  tab.append(h("section", { class: "card", "aria-labelledby": "datesH" },
    h("h2", { id: "datesH", text: "Dates to remember" }),
    dates.length ? h("ul", { class: "list" }, dates.map(d => {
      const n = dayNum(d.next) - dayNum(t);
      return h("li", {},
        h("div", { class: "grow" }, h("strong", { text: d.title }), h("span", { class: "small", text: fmtDate(d.next, { weekday: "short", day: "numeric", month: "long", year: d.yearly ? undefined : "numeric" }) + (d.yearly ? " · every year" : "") })),
        h("div", { class: "count" }, n === 0 ? "Today 🎉" : n > 0 ? String(n) : String(-n), n !== 0 ? h("small", { text: n > 0 ? (n === 1 ? "day to go" : "days to go") : "days ago" }) : null),
        h("button", { class: "x", "aria-label": "Remove " + d.title, text: "×", onclick: async () => { if (!confirm("Remove “" + d.title + "”?")) return; await api("DELETE", "/api/us/dates?id=" + encodeURIComponent(d.id)).catch(() => {}); loadUs(); } }));
    })) : h("p", { class: "sub", text: "Add birthdays, anniversaries and trips. You'll both see a countdown." }),
    h("details", { open: S.addDate ? true : null, ontoggle: e => { S.addDate = e.target.open; } }, h("summary", { class: "linkbtn", text: "Add a date" }),
      h("form", { style: "display:flex;flex-direction:column;gap:10px;margin-top:10px", onsubmit: async e => {
        e.preventDefault();
        try { await api("POST", "/api/us/dates", { title: titleIn.value, date: dateIn.value, yearly: yearlyIn.checked }); S.addDate = false; loadUs(); }
        catch (err) { usMsg = err.message; renderUs(); }
      } }, titleIn, dateIn, h("label", { class: "check" }, yearlyIn, "Repeats every year"), h("button", { class: "btn accent", style: "align-self:flex-start", type: "submit", text: "Add date" })))));

  // Date ideas
  const ideaIn = h("input", { class: "field", maxlength: 120, placeholder: "Add a date idea…", "aria-label": "New date idea" });
  const open = U.ideas.filter(i => !i.done), done = U.ideas.filter(i => i.done);
  const suggestions = IDEAS.filter(s => !U.ideas.some(i => i.text.toLowerCase() === s.toLowerCase()));
  const addIdea = async text => { try { await api("POST", "/api/us/ideas", { text }); await loadUs(); } catch (e) { usMsg = e.message; renderUs(); } };
  const ideaRow = i => h("li", {},
    h("input", { type: "checkbox", checked: i.done, "aria-label": "Done: " + i.text, style: "width:20px;height:20px;accent-color:var(--accent)", onchange: async e => { await api("PATCH", "/api/us/ideas", { id: i.id, done: e.target.checked }).catch(() => {}); loadUs(); } }),
    h("div", { class: "grow" }, h("span", { class: i.done ? "done-text" : "", text: i.text })),
    h("button", { class: "x", "aria-label": "Remove " + i.text, text: "×", onclick: async () => { await api("DELETE", "/api/us/ideas?id=" + encodeURIComponent(i.id)).catch(() => {}); loadUs(); } }));
  tab.append(h("section", { class: "card", "aria-labelledby": "ideasH" },
    h("div", { class: "row between" }, h("h2", { id: "ideasH", text: "Date ideas" }),
      h("button", { class: "btn small accent", text: "🎲 Surprise me", onclick: () => {
        const pool = open.length ? open.map(i => i.text) : suggestions.length ? suggestions : IDEAS;
        S.surprise = pool[Math.floor(Math.random() * pool.length)]; S.surpriseFromList = !!open.length; renderUs();
      } })),
    S.surprise ? h("div", { class: "surprise" }, S.surprise,
      !S.surpriseFromList ? h("div", { class: "row", style: "margin-top:10px" }, h("button", { class: "btn small", text: "Add to our list", onclick: () => { addIdea(S.surprise); S.surprise = null; } })) : null) : null,
    h("form", { class: "row", onsubmit: e => { e.preventDefault(); if (ideaIn.value.trim()) addIdea(ideaIn.value); } }, ideaIn, h("button", { class: "btn", type: "submit", text: "Add" })),
    open.length ? h("ul", { class: "list" }, open.map(ideaRow)) : h("p", { class: "sub", text: "Your shared list is empty. Add your own, or pick from these:" }),
    !open.length ? h("div", { class: "chips" }, suggestions.slice(0, 6).map(s => h("button", { class: "chip", onclick: () => addIdea(s) }, "+ " + s))) : null,
    done.length ? h("details", {}, h("summary", { class: "linkbtn", text: "Done together (" + done.length + ")" }), h("ul", { class: "list" }, done.map(ideaRow))) : null));

  if (usMsg) { tab.append(h("p", { class: "msg err", text: usMsg })); usMsg = ""; }
}
async function setMood(mood, need) {
  try { await api("PUT", "/api/us/mood", { date: today(), mood, need }); await loadUs(); } catch (e) { usMsg = e.message; renderUs(); }
}


/* ---------------- Explore tab: places nearby ---------------- */
const PLACE_CATS = [["dinner", "🍷", "Romantic dinner"], ["cafe", "☕", "Cafés & sweets"], ["drinks", "🍸", "Drinks"], ["outdoors", "🌳", "Outdoors"], ["culture", "🎭", "Culture"], ["fun", "🎳", "Fun & games"]];
const RADII = [[1000, "1 km"], [2000, "2 km"], [5000, "5 km"], [10000, "10 km"]];
const X = {
  where: ls.get("lb-where", null),   // { lat, lon, label }
  cat: ls.get("lb-place-cat", "dinner"),
  radius: ls.get("lb-place-radius", 2000),
  places: null, loading: false, err: "", locating: false,
  search: null, pick: null, added: {},
};
const fmtDist = m => m < 950 ? Math.max(50, Math.round(m / 50) * 50) + " m" : (m < 9500 ? String(Math.round(m / 100) / 10) : String(Math.round(m / 1000))) + " km";
const walkMin = m => Math.max(1, Math.round(m / 80));
// Round to ~100 m before the location leaves the phone.
const roughly = n => Math.round(n * 1000) / 1000;

function setWhere(lat, lon, label) {
  X.where = { lat: roughly(lat), lon: roughly(lon), label };
  ls.set("lb-where", X.where); X.search = null; loadPlaces();
}
function locate() {
  if (!navigator.geolocation) { X.err = "This browser can't share your location. Search for a place instead."; return renderExplore(); }
  X.locating = true; X.err = ""; renderExplore();
  navigator.geolocation.getCurrentPosition(
    pos => { X.locating = false; setWhere(pos.coords.latitude, pos.coords.longitude, "Near you"); },
    err => { X.locating = false; X.err = err.code === 1 ? "Location is blocked. Allow it in your browser settings, or search for a place instead." : "Couldn't find your location. Try again or search instead."; renderExplore(); },
    { enableHighAccuracy: false, timeout: 15000, maximumAge: 5 * 60000 });
}
// Places: our server asks Geoapify (fast). If that isn't set up or fails,
// the phone asks OpenStreetMap's free Overpass servers itself (slower).
// Answers are kept on the phone for a day.
let placesCore = null;
const PLACE_CACHE_MS = 24 * 3600 * 1000;
function cachedPlaces(k) {
  const c = ls.get("lb-places-cache", {});
  return c[k] && Date.now() - c[k].at < PLACE_CACHE_MS ? c[k].places : null;
}
function cachePlaces(k, places) {
  const c = ls.get("lb-places-cache", {});
  c[k] = { at: Date.now(), places, source: X.source };
  const keys = Object.keys(c).sort((a, b) => c[b].at - c[a].at);
  for (const old of keys.slice(8)) delete c[old];   // keep the 8 most recent searches
  ls.set("lb-places-cache", c);
}
async function findPlaces(where, cat, radius) {
  const k = [cat, radius, where.lat, where.lon].join("|");
  const hit = cachedPlaces(k);
  if (hit) { X.source = (ls.get("lb-places-cache", {})[k] || {}).source || "osm"; return hit; }
  let places = null, source = "geoapify";
  try {
    places = (await api("GET", "/api/places?lat=" + where.lat + "&lon=" + where.lon + "&radius=" + radius + "&cat=" + cat)).places;
  } catch (e) {
    if (e.code !== "places_not_configured" && e.code !== "places_unavailable") throw e;
    console.warn("Server place search unavailable (" + e.code + "), asking OpenStreetMap directly");
    placesCore = placesCore || await import("./places-core.js");
    const { data } = await placesCore.fetchOverpass(placesCore.buildQuery(cat, where.lat, where.lon, radius), { stagger: 3500, timeout: 15000 });
    places = placesCore.parsePlaces(cat, data, where.lat, where.lon).filter(p => p.distance <= radius);
    source = "osm";
  }
  X.source = source;
  cachePlaces(k, places);
  return places;
}
async function loadPlaces() {
  if (!X.where) return renderExplore();
  const ticket = (X.ticket = (X.ticket || 0) + 1);
  X.loading = true; X.err = ""; X.pick = null; renderExplore();
  try {
    const places = await findPlaces(X.where, X.cat, X.radius);
    if (ticket !== X.ticket) return;          // a newer search started meanwhile
    X.places = places;
  } catch (e) {
    if (ticket !== X.ticket) return;
    X.places = null;
    X.err = e.errors ? "The map servers are busy right now. Try again in a minute." : e.message;
  }
  X.loading = false; renderExplore();
}
async function searchArea(q) {
  X.err = ""; X.search = { q, results: null }; renderExplore();
  try { X.search.results = (await api("GET", "/api/places/search?q=" + encodeURIComponent(q))).results; }
  catch (e) { X.search = null; X.err = e.message; }
  renderExplore();
}
function mapsUrl(p) {
  if (isIOS()) return "https://maps.apple.com/?daddr=" + p.lat + "," + p.lon + "&q=" + encodeURIComponent(p.name);
  return "https://www.google.com/maps/dir/?api=1&destination=" + p.lat + "," + p.lon + "&travelmode=walking";
}
async function addPlaceIdea(p) {
  try {
    await api("POST", "/api/us/ideas", { text: (p.kind === "Place" ? "" : p.kind + ": ") + p.name + " (" + fmtDist(p.distance) + " away)" });
    X.added[p.id] = true; toast("💌", "Added to your date ideas with " + partnerName() + ".", "See list", () => setTab("us"));
    renderExplore(); if (S.us) loadUs();
  } catch (e) { toast("⚠️", e.message); }
}

function placeCard(p) {
  const meta = [h("span", {}, h("b", { text: fmtDist(p.distance) }), p.distance <= 3000 ? " · " + walkMin(p.distance) + " min walk" : null), h("span", { text: p.kind })];
  if (p.cuisine) meta.push(h("span", { text: p.cuisine }));
  if (p.address) meta.push(h("span", { text: p.address }));
  if (p.outdoor) meta.push(h("span", { text: "☀️ Outdoor seating" }));
  return h("article", { class: "place" + (X.pick === p.id ? " pick" : ""), id: "place-" + p.id },
    X.pick === p.id ? h("span", { class: "eyebrow", style: "color:var(--accent)", text: "🎲 Tonight's pick" }) : null,
    h("h3", { text: p.name }),
    h("div", { class: "meta" }, meta),
    p.hours ? h("p", { class: "small", text: "🕒 " + p.hours }) : null,
    h("div", { class: "actions" },
      h("a", { class: "btn small accent", href: mapsUrl(p), target: "_blank", rel: "noopener", text: "Directions" }),
      linked() ? h("button", { class: "btn small", disabled: !!X.added[p.id], text: X.added[p.id] ? "✓ In date ideas" : "♡ Save for a date", onclick: () => addPlaceIdea(p) }) : null,
      p.website ? h("a", { class: "btn small", href: p.website, target: "_blank", rel: "noopener nofollow", text: "Website" }) : null));
}

function renderExplore() {
  const tab = $("tab-explore"); tab.replaceChildren();
  if (S.online === false) { tab.append(h("section", { class: "card" }, h("h2", { text: "Places for two" }), h("p", { class: "sub", text: "Exploring needs the Love Better server. Open the app from its web address." }))); return; }
  if (S.setup) { tab.append(h("section", { class: "card" }, h("h2", { text: "Places for two" }), h("p", { class: "msg err", text: S.setup }))); return; }

  const q = h("input", { class: "field", type: "search", placeholder: "Search a town or area", "aria-label": "Search a place", enterkeyhint: "search", value: X.search ? X.search.q : "" });
  const head = h("section", { class: "card", "aria-labelledby": "exploreH" },
    h("h2", { id: "exploreH", text: "Places for two" }),
    h("p", { class: "sub", text: "Romantic and fun spots around you, for your next date." }),
    X.where ? h("div", { class: "where" }, h("span", { text: "📍" }), h("b", { text: X.where.label }), h("button", { class: "linkbtn", text: X.locating ? "Locating…" : "Use my location", onclick: locate, disabled: X.locating })) :
      h("button", { class: "btn accent", style: "align-self:flex-start", text: X.locating ? "Finding you…" : "📍 Use my location", onclick: locate, disabled: X.locating }),
    h("form", { class: "row", onsubmit: e => { e.preventDefault(); if (q.value.trim()) searchArea(q.value.trim()); } }, q, h("button", { class: "btn", type: "submit", text: "Search" })));
  if (X.search) {
    head.append(X.search.results == null ? h("p", { class: "small", text: "Searching…" })
      : !X.search.results.length ? h("p", { class: "small", text: "Nothing found for “" + X.search.q + "”. Try a different spelling or a nearby town." })
      : h("ul", { class: "list" }, X.search.results.map(r => h("li", {}, h("div", { class: "grow" }, h("span", { text: r.name })),
          h("button", { class: "btn small", text: "Go", onclick: () => setWhere(r.lat, r.lon, r.name.split(",").slice(0, 2).join(",")) })))));
  }
  head.append(
    h("div", { class: "chips scroll", role: "group", "aria-label": "Kind of place" }, PLACE_CATS.map(([c, e, l]) => h("button", { class: "chip", "aria-pressed": String(X.cat === c), onclick: () => { X.cat = c; ls.set("lb-place-cat", c); loadPlaces(); } }, e + " " + l))),
    h("div", { class: "row", role: "group", "aria-label": "How far" }, h("span", { class: "eyebrow", text: "Within" }), h("div", { class: "chips" }, RADII.map(([r, l]) => h("button", { class: "chip", "aria-label": "Within " + l, "aria-pressed": String(X.radius === r), onclick: () => { X.radius = r; ls.set("lb-place-radius", r); loadPlaces(); } }, l)))));
  if (X.err) head.append(h("p", { class: "msg err", text: X.err }));
  tab.append(head);

  if (!X.where) return;
  if (X.loading) { tab.append(h("section", { class: "card" }, h("p", { class: "sub", text: "Finding lovely places… this can take a few seconds." }))); return; }
  if (X.err && !X.places) { tab.append(h("button", { class: "btn accent", style: "align-self:flex-start", text: "Try again", onclick: loadPlaces })); return; }
  if (!X.places) return;
  const cat = PLACE_CATS.find(c => c[0] === X.cat);
  if (!X.places.length) {
    tab.append(h("section", { class: "card" }, h("p", { class: "sub", text: "No " + cat[2].toLowerCase() + " spots found within " + fmtDist(X.radius) + ". Try a bigger distance or another kind of place." }),
      X.radius < 10000 ? h("button", { class: "btn small", style: "align-self:flex-start", text: "Search within " + fmtDist(RADII.find(r => r[0] > X.radius)[0]), onclick: () => { X.radius = RADII.find(r => r[0] > X.radius)[0]; ls.set("lb-place-radius", X.radius); loadPlaces(); } }) : null));
    return;
  }
  tab.append(h("div", { class: "row between" },
    h("span", { class: "small", text: plural(X.places.length, "place") + " · " + cat[1] + " " + cat[2] }),
    h("button", { class: "btn small accent", text: "🎲 Pick for us", onclick: () => {
      const pool = X.places.slice(0, 25), p = pool[Math.floor(Math.random() * pool.length)];
      X.pick = p.id; renderExplore(); document.getElementById("place-" + p.id).scrollIntoView({ behavior: "smooth", block: "center" });
    } })));
  const list = [...X.places];
  if (X.pick) list.sort((a, b) => (b.id === X.pick) - (a.id === X.pick));
  tab.append(h("div", { class: "places" }, list.map(placeCard)));
  tab.append(h("p", { class: "osm" },
    X.source === "geoapify" ? h("span", {}, h("a", { href: "https://www.geoapify.com/", target: "_blank", rel: "noopener", text: "Powered by Geoapify" }), " · ") : "Places from ",
    h("a", { href: "https://www.openstreetmap.org/copyright", target: "_blank", rel: "noopener", text: "© OpenStreetMap contributors" }), ". Check opening hours before you go."));
}

/* ---------------- Play tab: quiz ---------------- */
let quiz = null; // { i, scores, order }
function startQuiz() {
  const order = QUIZ.map((q, i) => i).sort(() => Math.random() - .5);
  quiz = { i: 0, order, scores: { words: 0, time: 0, gifts: 0, service: 0, touch: 0 } };
  renderQuiz();
}
function renderQuiz() {
  const card = $("quizCard"); card.replaceChildren();
  const saved = ls.get("lb-lang", null);
  if (quiz && quiz.i < QUIZ.length) {
    const q = QUIZ[quiz.order[quiz.i]], flip = quiz.order[quiz.i] % 2;
    const opts = [[q[0], q[1]], [q[2], q[3]]]; if (flip) opts.reverse();
    card.append(
      h("div", { class: "row between" }, h("span", { class: "eyebrow", id: "quizH", text: "How do you feel loved?" }), h("span", { class: "small", text: (quiz.i + 1) + " of " + QUIZ.length })),
      h("div", { class: "progress" }, h("i", { style: "width:" + (quiz.i / QUIZ.length * 100) + "%" })),
      h("p", { class: "quiz-q", text: "Which means more to you?" }),
      h("div", { class: "quiz-opts" }, opts.map(([lang, text]) => h("button", { text, onclick: () => { quiz.scores[lang]++; quiz.i++; renderQuiz(); } }))),
      h("button", { class: "linkbtn", style: "align-self:flex-start", text: "Stop quiz", onclick: () => { quiz = null; renderQuiz(); } }));
    return;
  }
  if (quiz && quiz.i >= QUIZ.length) {
    const scores = quiz.scores; quiz = null;
    const primary = Object.keys(scores).reduce((a, b) => scores[b] > scores[a] ? b : a);
    ls.set("lb-lang", { primary, scores });
    if (linked()) api("PUT", "/api/us/lang", { scores }).then(loadUs).catch(() => {});
    return renderQuiz();
  }
  card.append(h("h2", { id: "quizH", text: "How do you feel loved?" }));
  if (!saved) {
    card.append(h("p", { class: "sub", text: "Ten quick choices show which kind of love reaches you most. When you're linked, " + partnerName() + " gets daily tips for loving you your way, and you get tips for them." }),
      h("button", { class: "btn accent", style: "align-self:flex-start", text: "Start the quiz", onclick: startQuiz }));
    return;
  }
  const max = Math.max(...Object.values(saved.scores), 1);
  card.append(
    h("p", { class: "sub", text: "You feel most loved through" }),
    h("p", { class: "qtext", text: LANGS[saved.primary].name }),
    h("div", { class: "bars" }, Object.keys(LANGS).sort((a, b) => saved.scores[b] - saved.scores[a]).map(l => h("div", { class: "bar" },
      h("span", { text: LANGS[l].name }), h("div", {}, h("i", { style: "width:" + (saved.scores[l] / max * 100) + "%" })), h("span", { text: saved.scores[l] })))),
    h("p", { class: "small", text: linked() ? "Shared with " + partnerName() + "." : "Link with your partner to share this." }),
    h("button", { class: "linkbtn", style: "align-self:flex-start", text: "Take it again", onclick: startQuiz }));
}

/* ---------------- notifications ---------------- */
const pushSupported = () => "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const standalone = () => matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
let notifyMsg = "";
async function refreshPush() {
  if (!pushSupported() || !swReg) return;
  try { const sub = await swReg.pushManager.getSubscription(); S.pushOn = !!sub && Notification.permission === "granted"; } catch (e) {}
  if (S.pushKey === undefined) { try { S.pushKey = await api("GET", "/api/push/key"); } catch (e) { S.pushKey = null; } }
  if (S.tab === "me") renderMe();
}
const b64ToBytes = s => { const b = atob((s + "===".slice((s.length + 3) % 4)).replace(/-/g, "+").replace(/_/g, "/")); return Uint8Array.from(b, c => c.charCodeAt(0)); };
async function enablePush() {
  try {
    if (!S.pushKey || !S.pushKey.enabled) throw new Error("Notifications aren't set up on the server yet.");
    const perm = await Notification.requestPermission();
    if (perm !== "granted") throw new Error("Notifications are blocked. Allow them for this site in your browser settings.");
    const sub = await swReg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(S.pushKey.publicKey) });
    await api("POST", "/api/push/subscribe", { subscription: sub.toJSON() });
    await api("POST", "/api/push/test");
    S.pushOn = true; notifyMsg = "Notifications are on. A test one is on its way.";
  } catch (e) { notifyMsg = e.message; }
  renderMe();
}
async function disablePush() {
  try {
    const sub = await swReg.pushManager.getSubscription();
    if (sub) { await api("DELETE", "/api/push/subscribe", { endpoint: sub.endpoint }).catch(() => {}); await sub.unsubscribe(); }
    S.pushOn = false; notifyMsg = "Notifications are off.";
  } catch (e) { notifyMsg = e.message; }
  renderMe();
}
function renderNotifyCard() {
  const card = h("section", { class: "card", "aria-labelledby": "notifyH" }, h("h2", { id: "notifyH", text: "Notifications" }),
    h("p", { class: "sub", text: "A morning reminder, and a ping when " + partnerName() + " nudges you or answers the question for two." }));
  if (!pushSupported() || !swReg) {
    card.append(h("p", { class: "small", text: isIOS() && !standalone() ? "On iPhone, first add Love Better to your Home Screen (see below), then open it from there to turn on notifications." : "This browser doesn't support notifications." }));
  } else if (S.pushKey && !S.pushKey.enabled) {
    card.append(h("p", { class: "small", text: "Notifications aren't set up on the server yet." }));
  } else {
    card.append(h("div", { class: "row" }, S.pushOn
      ? h("button", { class: "btn", text: "Turn off notifications", onclick: disablePush })
      : h("button", { class: "btn accent", text: "Turn on notifications", onclick: enablePush, disabled: !S.pushKey })));
  }
  if (notifyMsg) card.append(h("p", { class: "msg", text: notifyMsg }));
  return card;
}

/* ---------------- install ---------------- */
window.addEventListener("beforeinstallprompt", e => { e.preventDefault(); S.installEvt = e; if (S.tab === "me") renderMe(); });
window.addEventListener("appinstalled", () => { S.installEvt = null; if (S.tab === "me") renderMe(); });
function renderInstallCard() {
  const card = h("section", { class: "card", "aria-labelledby": "installH" }, h("h2", { id: "installH", text: "Put it on your home screen" }));
  if (standalone()) card.append(h("p", { class: "sub", text: "You're using the installed app. ✓" }));
  else if (S.installEvt) card.append(h("p", { class: "sub", text: "Open Love Better like any other app, full screen." }),
    h("button", { class: "btn accent", style: "align-self:flex-start", text: "Install app", onclick: async () => { S.installEvt.prompt(); await S.installEvt.userChoice.catch(() => {}); S.installEvt = null; renderMe(); } }));
  else if (isIOS()) card.append(h("p", { class: "sub", text: "In Safari, tap the Share button, then “Add to Home Screen”." }));
  else card.append(h("p", { class: "sub", text: "Use your browser's menu and choose “Install app” or “Add to Home screen”." }));
  return card;
}

/* ---------------- service worker ---------------- */
let swReg = null;
if ("serviceWorker" in navigator && location.protocol !== "file:") {
  navigator.serviceWorker.register("sw.js").then(r => { swReg = r; refreshPush(); }).catch(() => {});
  navigator.serviceWorker.addEventListener("message", e => { if (e.data && e.data.type === "open" && e.data.tab) setTab(e.data.tab); });
}

/* ---------------- Heart Jump room ---------------- */
// A private live room for the linked couple, with the same shape as the
// claude.ai room. It checks in a few times a second (works on Vercel).
function coupleRoom() {
  const peerId = crypto.randomUUID ? crypto.randomUUID() : String(Math.random()).slice(2) + Date.now();
  let list = [], cbs = [], deads = [], misses = 0, timer = null, polling = false;
  let full = {}, sending = null, dirty = false;
  async function poll() {
    timer = null; polling = true;
    try {
      const data = await api("GET", "/api/room?peer=" + peerId);
      misses = 0;
      list = data.peers.map(p => ({ peer: p.peer, sameTab: p.peer === peerId, kind: "viewer", presence: p.peer === peerId ? Object.assign({}, full) : p.presence }));
      cbs.forEach(f => f());
    } catch (e) {
      if (++misses >= 5) { polling = false; deads.forEach(f => f()); return; }
    }
    polling = false;
    if (document.documentElement.classList.contains("playing")) timer = setTimeout(poll, document.hidden ? 3000 : 600);
  }
  function flush() {
    if (sending) { dirty = true; return sending; }
    dirty = false;
    sending = api("POST", "/api/room/presence", { peer: peerId, presence: full }).catch(() => {}).then(() => { sending = null; if (dirty) return flush(); });
    return sending;
  }
  return {
    presence(patch) { Object.assign(full, patch); const self = list.find(p => p.sameTab); if (self) self.presence = Object.assign({}, full); return flush(); },
    peers: () => list,
    onPeers(cb, dead) { cbs.push(cb); if (dead) deads.push(dead); this.resume(); },
    resume() { if (!timer && !polling) poll(); },
  };
}

/* ---------------- rendering & sync ---------------- */
function editing(el) {
  const a = document.activeElement;
  return a && el.contains(a) && /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName) && a.type !== "checkbox";
}
let pendingRender = false;
function renderAll() {
  const tabEl = $("tab-" + S.tab);
  if (tabEl && editing(tabEl)) { pendingRender = true; }
  else if (S.tab === "us") renderUs();
  else if (S.tab === "me") renderMe();
  else if (S.tab === "play") renderQuiz();
  else if (S.tab === "explore") renderExplore();
  if (S.tab === "today" && window.render) window.render();
  $("meDot").hidden = !(S.me && !linked() && !S.setup);
  $("usDot").hidden = !(linked() && S.us && S.us.question.partnerAnswered && !S.us.question.mine);
}
document.addEventListener("focusout", () => setTimeout(() => { if (pendingRender && !editing($("tab-" + S.tab))) { pendingRender = false; renderAll(); } }, 0));

let practiceTimer = null;
function syncPractice() {
  if (!linked()) return;
  clearTimeout(practiceTimer);
  practiceTimer = setTimeout(() => api("PUT", "/api/us/practice", { dates: ls.get("lbd-done", []) }).then(() => S.tab === "us" && loadUs()).catch(() => {}), 300);
}

// Keep things fresh: partner's mood, answers and nudges.
setInterval(() => {
  if (document.hidden || !S.online) return;
  if (linked()) loadUs();
  else if (S.me && S.me.link && S.me.link.invite) loadMe();   // waiting for partner to use our code
}, 15000);
document.addEventListener("visibilitychange", () => { if (!document.hidden && S.online) loadMe(); });

/* ---------------- hooks for the original page script ---------------- */
window.LB = {
  practiceChanged() { syncPractice(); },
  leafRendered(offset) {
    const body = $("leafBody"); if (!body) return;
    let el = $("forThem");
    const pl = S.us && S.us.partner.lang;
    if (offset !== 0 || !pl) { if (el) el.remove(); return; }
    if (!el) { el = h("div", { class: "forthem", id: "forThem" }); body.querySelector(".practice").after(el); }
    el.replaceChildren(h("span", { class: "label", text: "For " + partnerName() + " · " + LANGS[pl.primary].short }), h("p", { text: dailyPick(LANGS[pl.primary].tips, 3) }));
  },
  async room() { if (!S.me) await loadMe(); return linked() ? coupleRoom() : null; },
  gameBlockedMessage() {
    if (S.setup) return S.setup;
    if (S.online === false) return "Heart Jump needs the Love Better server. Open the app from its web address.";
    return "Link with your partner first: close this and go to the Me tab.";
  },
};

/* ---------------- start ---------------- */
setTab(S.tab, true);
tabFromHash();
loadMe();
})();
