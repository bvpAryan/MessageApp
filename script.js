/* ═══════════════════════════════════════════════════════════════
   MESSAGE — terminal-style real-time messenger
   Vanilla JS + Firebase Realtime Database (anonymous auth)

   ┌─ SETUP ────────────────────────────────────────────────────┐
   │ 1. Paste your Firebase web-app config into FIREBASE_CONFIG │
   │    below (Project settings → Your apps → Web app).         │
   │ 2. Enable Anonymous sign-in (Authentication → Sign-in).    │
   │ 3. Publish database.rules.json as your Realtime Database   │
   │    rules.                                                  │
   │ Full steps are in README.md.                               │
   └────────────────────────────────────────────────────────────┘

   The web apiKey below is NOT a secret (it only identifies your
   project). Access is enforced by the database rules. Never put
   service-account / admin credentials in this file.
   ═══════════════════════════════════════════════════════════════ */

// ▼▼▼  CONFIGURATION — EDIT THIS  ▼▼▼
const firebaseConfig = {
  apiKey: "AIzaSyCXf2I-jzYsmibkzRyLLA1oSGUf07SnLco",
  authDomain: "message-7413e.firebaseapp.com",
  databaseURL: "https://message-7413e-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "message-7413e",
  storageBucket: "message-7413e.firebasestorage.app",
  messagingSenderId: "1050074453255",
  appId: "1:1050074453255:web:e9dfac64e1b616f3dea1a2",
  measurementId: "G-DGGYG5F2YN"
};

// ▲▲▲  END CONFIGURATION  ▲▲▲

const SDK_VERSION = "10.14.1";
const MAX_LEN = 1000;      // max characters per message (also enforced by the rules)
const MAX_LINES = 400;     // terminal lines kept in the DOM
const STORAGE = {          // only identity + preferences. NEVER message contents.
  id: "message.id",
  contact: "message.contact",
  sound: "message.sound",
  time: "message.time"
};

/* ─────────────────────────── helpers ─────────────────────────── */

const $ = (id) => document.getElementById(id);

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
  del(k) { try { localStorage.removeItem(k); } catch { /* ignore */ } }
};

const el = {
  terminal: $("terminal"), output: $("output"), prompt: $("prompt"),
  typed: $("typed"), input: $("hiddenInput"),
  statusDot: $("statusDot"), statusText: $("statusText"),
  contactName: $("contactName"), peerState: $("peerState"),
  configBtn: $("configBtn"), soundBtn: $("soundBtn"), timeBtn: $("timeBtn"),
  welcome: $("welcomeOverlay"), welcomeCode: $("welcomeCode"), welcomeNotice: $("welcomeNotice"),
  welcomeCopy: $("welcomeCopy"), welcomeContinue: $("welcomeContinue"),
  config: $("configOverlay"), configForm: $("configForm"),
  cfgMyCode: $("cfgMyCode"), cfgCopy: $("cfgCopy"),
  nameInput: $("contactNameInput"), codeInput: $("contactCodeInput"),
  configMsg: $("configMsg"), connectBtn: $("connectBtn"),
  cancelBtn: $("cancelBtn"), disconnectBtn: $("disconnectBtn")
};

/** 16 random digits from the OS CSPRNG (rejection sampling → no modulo bias). */
function generateId() {
  let out = "";
  const buf = new Uint8Array(32);
  while (out.length < 16) {
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b < 250) {            // 250 is a multiple of 10 → uniform digits
        out += String(b % 10);
        if (out.length === 16) break;
      }
    }
  }
  return out;
}

const isValidId = (s) => typeof s === "string" && /^\d{16}$/.test(s);
const groupCode = (s) => String(s).replace(/(\d{4})(?=\d)/g, "$1 ");

/** Remove control chars and bidi-override characters that could spoof the display. */
function cleanText(s) {
  return String(s)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/[\u202A-\u202E\u2066-\u2069]/g, "")
    .replace(/\r\n?/g, "\n");
}

function slugify(name) {
  const s = name.trim().toLowerCase().replace(/\s+/g, "_").replace(/[^\p{L}\p{N}_\-.]/gu, "").slice(0, 16);
  return s || "peer";
}

const fmtTime = (ts) =>
  new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false });

function isConfigured() {
  return !/^YOUR_/.test(FIREBASE_CONFIG.apiKey) && !/YOUR_PROJECT_ID/.test(FIREBASE_CONFIG.databaseURL);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.cssText = "position:fixed;top:0;left:0;opacity:0;font-size:16px";
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

function flashButton(btn, text, ms = 1400) {
  const old = btn.dataset.label || btn.textContent;
  btn.dataset.label = old;
  btn.textContent = text;
  clearTimeout(btn._t);
  btn._t = setTimeout(() => { btn.textContent = old; }, ms);
}

/* ─────────────────────────── state ─────────────────────────── */

const state = {
  myId: null,
  freshId: false,          // identity generated during this page load
  uid: null,               // Firebase anonymous auth uid
  contact: null,           // { name, code }
  contactState: "none",    // none | pending | ok | missing | error
  ready: false,            // auth + identity registered + inbox listening
  fatal: false,            // unrecoverable setup problem
  dbOnline: false,
  peerOnline: false,
  peerKnown: false,
  status: "CONNECTING",
  sessionAnnounced: false,
  seen: new Set(),         // message keys already shown (dedupe)
  warnedUnknown: new Set(),
  soundOn: true,
  unread: 0
};

let fb = null;             // Firebase SDK functions
let db = null;
let peerUnsub = null;
let audioCtx = null;

/* ─────────────────────────── terminal output ─────────────────────────── */

const isNearBottom = () =>
  el.terminal.scrollHeight - el.terminal.scrollTop - el.terminal.clientHeight < 90;

function scrollBottom() {
  requestAnimationFrame(() => { el.terminal.scrollTop = el.terminal.scrollHeight; });
}

function mk(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text !== undefined) n.textContent = text;   // textContent only → no HTML injection
  return n;
}

function pushLine(node, force = false) {
  const stick = force || isNearBottom();
  el.output.appendChild(node);
  while (el.output.childElementCount > MAX_LINES) el.output.firstElementChild.remove();
  if (stick) scrollBottom();
}

function sys(text, kind = "") {
  const d = mk("div", `line sys ${kind}`.trim(), text);
  pushLine(d);
  return d;
}

function prefixFor(who) {
  return who === "me" ? "you@message~" : `${slugify(state.contact ? state.contact.name : "peer")}@message~`;
}

function chat(who, text, ts, force = false) {
  const d = mk("div", `line msg ${who}`);
  d.append(mk("span", "ts", fmtTime(ts)), mk("span", `pfx ${who === "me" ? "me" : "peer"}`, prefixFor(who)), mk("span", "body", text));
  pushLine(d, force);
  return d;
}

function clearOutput() { el.output.textContent = ""; }

/* ─────────────────────────── terminal-style typing ─────────────────────────── */

const promptActive = () => !el.prompt.hidden;

function renderTyped() {
  const v = el.input.value;
  const s = el.input.selectionStart ?? v.length;
  const e = el.input.selectionEnd ?? v.length;
  el.typed.textContent = "";

  const part = (txt, cls, base) => {
    if (!txt) return;
    const sp = mk("span", cls, txt);
    sp.dataset.base = String(base);
    el.typed.appendChild(sp);
  };

  part(v.slice(0, s), "", 0);
  if (s === e) el.typed.appendChild(mk("span", "cursor"));
  else part(v.slice(s, e), "sel", s);
  part(v.slice(e), "", e);

  if (!v) el.typed.appendChild(mk("span", "hint-inline", "type a message · enter to send"));
  if (document.activeElement === el.input) scrollBottom();
}

/** Map a click position inside the rendered text to a character index. */
function caretFromPoint(x, y) {
  let node = null, off = 0;
  if (document.caretPositionFromPoint) {
    const p = document.caretPositionFromPoint(x, y);
    if (p) { node = p.offsetNode; off = p.offset; }
  } else if (document.caretRangeFromPoint) {
    const r = document.caretRangeFromPoint(x, y);
    if (r) { node = r.startContainer; off = r.startOffset; }
  }
  if (!node) return null;
  const sp = node.nodeType === 3 ? node.parentElement : node;
  if (sp && sp.dataset && sp.dataset.base !== undefined && el.typed.contains(sp)) {
    return Math.min(Number(sp.dataset.base) + off, el.input.value.length);
  }
  return null;
}

function focusPrompt() {
  if (!promptActive()) return;
  el.input.focus({ preventScroll: true });
}

el.terminal.addEventListener("click", (e) => {
  if (!promptActive()) return;
  if (window.getSelection && String(window.getSelection()).length) return; // let people copy message text
  const idx = el.typed.contains(e.target) ? caretFromPoint(e.clientX, e.clientY) : null;
  focusPrompt();
  if (idx !== null) el.input.setSelectionRange(idx, idx);
  renderTyped();
});

let shiftHeld = false;

el.input.addEventListener("keydown", (e) => {
  shiftHeld = e.shiftKey;
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    submitLine();
    return;
  }
  requestAnimationFrame(renderTyped);
});
el.input.addEventListener("keyup", (e) => { shiftHeld = e.shiftKey; renderTyped(); });

// Some mobile keyboards don't emit a usable keydown for Enter.
el.input.addEventListener("beforeinput", (e) => {
  if (e.inputType === "insertLineBreak" && !shiftHeld) {
    e.preventDefault();
    submitLine();
  }
});

["input", "select", "click", "mouseup", "touchend"].forEach((ev) =>
  el.input.addEventListener(ev, () => requestAnimationFrame(renderTyped)));

document.addEventListener("selectionchange", () => {
  if (document.activeElement === el.input) renderTyped();
});

el.input.addEventListener("focus", () => { el.prompt.classList.add("focused"); renderTyped(); scrollBottom(); });
el.input.addEventListener("blur", () => { el.prompt.classList.remove("focused"); renderTyped(); });

// Start typing anywhere on the page → the prompt receives it.
document.addEventListener("keydown", (e) => {
  if (!promptActive() || modalOpen) return;
  if (document.activeElement === el.input) return;
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA") return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key.length === 1) focusPrompt();
});

function submitLine() {
  const text = cleanText(el.input.value).trim();
  if (!text) return;

  if (text.startsWith("/")) {
    runCommand(text);
    el.input.value = "";
    renderTyped();
    return;
  }

  if (state.status !== "CONNECTED") {
    sys("> TRANSMISSION FAILED: NOT CONNECTED", "err");
    return;                                   // keep what the user typed
  }
  if (!state.peerOnline) {
    sys("> PEER IS OFFLINE. MESSAGE NOT SENT (NOTHING IS QUEUED OR STORED).", "err");
    return;
  }

  const clipped = text.slice(0, MAX_LEN);
  const line = chat("me", clipped, Date.now(), true);
  el.input.value = "";
  renderTyped();

  sendMessage(clipped).catch((err) => {
    line.classList.add("failed");
    sys(`> MESSAGE NOT DELIVERED: ${friendlyError(err)}`, "err");
  });
}

function runCommand(cmd) {
  const c = cmd.split(/\s+/)[0].toLowerCase();
  if (c === "/clear") { clearOutput(); return; }
  if (c === "/code") { sys(`> YOUR CODE: ${groupCode(state.myId)}`); return; }
  if (c === "/help") {
    sys("> COMMANDS: /clear  clear screen   /code  show your code   /help  this list");
    sys("> SHIFT+ENTER = NEW LINE · ENTER = SEND");
    return;
  }
  sys(`> UNKNOWN COMMAND: ${cmd.slice(0, 30)}  (TRY /help)`, "err");
}

/* ─────────────────────────── sound + unread title ─────────────────────────── */

function unlockAudio() {
  try {
    audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === "suspended") audioCtx.resume();
  } catch { /* no audio */ }
}
["pointerdown", "keydown", "touchend"].forEach((ev) =>
  document.addEventListener(ev, unlockAudio, { passive: true }));

function beep() {
  if (!state.soundOn || !audioCtx) return;
  try {
    const t = audioCtx.currentTime;
    [880, 1320].forEach((freq, i) => {
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      const st = t + i * 0.08;
      o.type = "square";
      o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, st);
      g.gain.exponentialRampToValueAtTime(0.035, st + 0.01);
      g.gain.exponentialRampToValueAtTime(0.0001, st + 0.08);
      o.connect(g).connect(audioCtx.destination);
      o.start(st);
      o.stop(st + 0.09);
    });
  } catch { /* ignore */ }
}

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) { state.unread = 0; document.title = "MESSAGE"; }
});

/* ─────────────────────────── status + UI ─────────────────────────── */

function computeStatus() {
  if (state.fatal) return "DISCONNECTED";
  if (!navigator.onLine) return "DISCONNECTED";
  if (!state.ready || !state.dbOnline) return "CONNECTING";
  if (!state.contact) return "DISCONNECTED";
  if (state.contactState === "ok") return "CONNECTED";
  if (state.contactState === "missing") return "DISCONNECTED";
  return "CONNECTING";
}

function updateUI() {
  const prev = state.status;
  const s = computeStatus();
  state.status = s;

  el.statusText.textContent = s;
  el.statusDot.className = `dot ${s.toLowerCase()}`;
  el.contactName.textContent = state.contact ? state.contact.name : "—";
  el.peerState.textContent = state.contact && s === "CONNECTED"
    ? (state.peerOnline ? "PEER ONLINE" : "PEER OFFLINE")
    : "PEER —";

  const show = Boolean(state.contact) && s === "CONNECTED";
  const wasHidden = el.prompt.hidden;
  el.prompt.hidden = !show;
  if (show && wasHidden) { renderTyped(); scrollBottom(); }
  if (!show && document.activeElement === el.input) el.input.blur();

  if (s !== prev) onStatusChange(prev, s);
}

function onStatusChange(prev, s) {
  if (s === "CONNECTED") {
    if (!state.sessionAnnounced) {
      state.sessionAnnounced = true;
      sys("> SECURE SESSION ESTABLISHED");
      sys("> TRANSPORT: TLS · NOT END-TO-END ENCRYPTED · SERVER COPY DELETED ON DELIVERY");
    } else {
      sys("> CONNECTION RESTORED");
    }
    if (!modalOpen && matchMedia("(pointer: fine)").matches) focusPrompt();
  } else if (prev === "CONNECTED" && state.contact) {
    sys(navigator.onLine ? "> CONNECTION LOST. RECONNECTING..." : "> NETWORK OFFLINE. WAITING FOR CONNECTION...");
  }
}

window.addEventListener("online", () => { updateUI(); });
window.addEventListener("offline", () => { updateUI(); });

function withTimeout(promise, ms, label) {
  let t;
  const timeout = new Promise((_, rej) => {
    t = setTimeout(() => rej(Object.assign(new Error(label || "timeout"), { code: "timeout" })), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(t));
}

function friendlyError(e) {
  const m = `${(e && e.code) || ""} ${(e && e.message) || e || ""}`;
  if (/timeout/i.test(m)) return "SERVER DID NOT RESPOND (CHECK databaseURL IN FIREBASE_CONFIG)";
  if (/permission_denied/i.test(m)) return "ACCESS DENIED BY SERVER RULES";
  if (/offline|network|disconnect|unavailable/i.test(m)) return "NETWORK ERROR";
  return "UNEXPECTED ERROR";
}

/* ─────────────────────────── dialogs ─────────────────────────── */

let modalOpen = null;
let lastFocus = null;

function openDialog(overlay, focusEl) {
  lastFocus = document.activeElement;
  overlay.classList.add("open");
  overlay.setAttribute("aria-hidden", "false");
  modalOpen = overlay;
  if (document.activeElement === el.input) el.input.blur();
  setTimeout(() => focusEl && focusEl.focus({ preventScroll: true }), 60);
}

function closeDialog(overlay) {
  overlay.classList.remove("open");
  overlay.setAttribute("aria-hidden", "true");
  modalOpen = null;
  if (matchMedia("(pointer: fine)").matches && promptActive()) focusPrompt();
  else if (lastFocus && lastFocus.focus && lastFocus !== el.input) lastFocus.focus({ preventScroll: true });
}

// Esc closes the configure dialog; Tab stays inside the open dialog.
document.addEventListener("keydown", (e) => {
  if (!modalOpen) return;
  if (e.key === "Escape" && modalOpen === el.config) { e.preventDefault(); closeDialog(el.config); return; }
  if (e.key === "Tab") {
    const items = [...modalOpen.querySelectorAll("button, input")].filter((n) => !n.hidden && !n.disabled && n.offsetParent !== null);
    if (!items.length) return;
    const first = items[0], last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
  }
});

el.config.addEventListener("pointerdown", (e) => { if (e.target === el.config) closeDialog(el.config); });

function showWelcome(notice = "") {
  el.welcomeCode.textContent = groupCode(state.myId);
  el.welcomeNotice.textContent = notice;
  openDialog(el.welcome, el.welcomeContinue);
}

el.welcomeCopy.addEventListener("click", async () => {
  const ok = await copyText(state.myId);
  flashButton(el.welcomeCopy, ok ? "COPIED ✓" : "PRESS CTRL+C");
});

el.welcomeContinue.addEventListener("click", () => {
  closeDialog(el.welcome);
  if (!state.contact) sys("> NO CONTACT YET. PRESS [CONFIGURE] AND ENTER THEIR 16-DIGIT CODE.");
});

function setMsg(kind, text) {
  el.configMsg.className = `form-msg ${kind || ""}`.trim();
  el.configMsg.textContent = text || "";
}

function openConfig() {
  el.cfgMyCode.textContent = groupCode(state.myId);
  el.nameInput.value = state.contact ? state.contact.name : "";
  el.codeInput.value = state.contact ? groupCode(state.contact.code) : "";
  el.disconnectBtn.hidden = !state.contact;
  if (state.fatal) {
    setMsg("err", state.fatalReason || "> ERROR: BACKEND SETUP FAILED. SEE TERMINAL.");
  } else {
    setMsg("", "");
  }
  el.connectBtn.disabled = false;
  openDialog(el.config, state.contact ? el.nameInput : el.nameInput);
}

el.configBtn.addEventListener("click", openConfig);
el.cancelBtn.addEventListener("click", () => closeDialog(el.config));

el.cfgCopy.addEventListener("click", async () => {
  const ok = await copyText(state.myId);
  flashButton(el.cfgCopy, ok ? "COPIED ✓" : "CTRL+C");
});

// Format the code as "0000 0000 0000 0000" while typing, keeping the caret sensible.
el.codeInput.addEventListener("input", () => {
  const pos = el.codeInput.selectionStart ?? el.codeInput.value.length;
  const digitsBefore = el.codeInput.value.slice(0, pos).replace(/\D/g, "").length;
  const digits = el.codeInput.value.replace(/\D/g, "").slice(0, 16);
  const formatted = groupCode(digits);
  el.codeInput.value = formatted;
  let p = 0, c = 0;
  while (p < formatted.length && c < digitsBefore) { if (/\d/.test(formatted[p])) c++; p++; }
  el.codeInput.setSelectionRange(p, p);
  setMsg("", "");
});

// Enter in the name field moves to the code field instead of submitting early.
el.nameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.isComposing) {
    e.preventDefault();
    if (!el.codeInput.value.trim()) el.codeInput.focus();
    else connectContact();
  }
});

el.connectBtn.addEventListener("click", (e) => {
  e.preventDefault();
  connectContact();
});

el.configForm.addEventListener("submit", (e) => { e.preventDefault(); connectContact(); });

el.disconnectBtn.addEventListener("click", () => {
  if (!state.contact) return;
  forgetContact();
  closeDialog(el.config);
});

/* ─────────────────────────── contact handling ─────────────────────────── */

function loadContact() {
  try {
    const raw = JSON.parse(store.get(STORAGE.contact) || "null");
    if (raw && typeof raw.name === "string" && isValidId(raw.code)) {
      state.contact = { name: raw.name.slice(0, 16), code: raw.code };
    }
  } catch { /* ignore corrupt value */ }
}

function stopWatchingPeer() {
  if (peerUnsub) { try { peerUnsub(); } catch { /* ignore */ } peerUnsub = null; }
  state.peerOnline = false;
  state.peerKnown = false;
}

function watchPeer(code) {
  stopWatchingPeer();
  peerUnsub = fb.onValue(fb.ref(db, `presence/${code}`), (snap) => {
    const on = snap.exists();
    const changed = state.peerOnline !== on;
    state.peerOnline = on;
    if (changed && state.peerKnown && state.contact && state.contact.code === code) {
      sys(on ? "> PEER ONLINE" : "> PEER OFFLINE");
    }
    state.peerKnown = true;
    updateUI();
  }, () => { /* listener cancelled */ });
}

let verifyTimer = null;

async function verifyContact() {
  if (!state.contact || !state.ready) return;
  const code = state.contact.code;
  state.contactState = "pending";
  updateUI();
  try {
    const snap = await fb.get(fb.ref(db, `users/${code}/registered`));
    if (!state.contact || state.contact.code !== code) return;   // contact changed meanwhile
    if (snap.exists()) {
      state.contactState = "ok";
      watchPeer(code);
    } else {
      state.contactState = "missing";
      sys("> ERROR: CONTACT CODE NOT FOUND ON SERVER. CHECK THE CODE IN [CONFIGURE].", "err");
    }
  } catch {
    if (!state.contact || state.contact.code !== code) return;
    state.contactState = "error";
    clearTimeout(verifyTimer);
    verifyTimer = setTimeout(() => { if (state.contactState === "error" && state.dbOnline) verifyContact(); }, 4000);
  }
  updateUI();
}

function forgetContact() {
  state.contact = null;
  state.contactState = "none";
  state.sessionAnnounced = false;
  store.del(STORAGE.contact);
  stopWatchingPeer();
  clearOutput();
  sys("> CONTACT REMOVED. SESSION CLEARED.");
  sys("> PRESS [CONFIGURE] TO CONNECT TO SOMEONE.");
  updateUI();
}

async function connectContact() {
  setMsg("", "");
  const name = cleanText(el.nameInput.value).replace(/\n/g, " ").trim();
  const code = el.codeInput.value.replace(/\D/g, "");

  if (!isConfigured()) { setMsg("err", "> ERROR: FIREBASE IS NOT CONFIGURED. SEE script.js / README.md"); return; }
  if (!state.ready) { setMsg("err", state.fatal ? (state.fatalReason || "> ERROR: BACKEND SETUP FAILED. SEE TERMINAL.") : "> ERROR: STILL CONNECTING TO SERVER. TRY AGAIN IN A MOMENT."); return; }
  if (name.length < 1 || name.length > 16) { setMsg("err", "> ERROR: CONTACT NAME REQUIRED (1–16 CHARACTERS)"); el.nameInput.focus(); return; }
  if (code.length !== 16) { setMsg("err", "> ERROR: CODE MUST BE EXACTLY 16 DIGITS"); el.codeInput.focus(); return; }
  if (code === state.myId) { setMsg("err", "> ERROR: THAT IS YOUR OWN CODE. ENTER THE OTHER PERSON'S CODE."); el.codeInput.focus(); return; }

  el.connectBtn.disabled = true;
  setMsg("", "> CONNECTING...");

  try {
    const snap = await withTimeout(fb.get(fb.ref(db, `users/${code}/registered`)), 10000, "lookup timeout");
    if (!snap.exists()) {
      setMsg("err", "> ERROR: CODE NOT FOUND. THE OTHER PERSON MUST OPEN MESSAGE AT LEAST ONCE FIRST.");
      return;
    }

    const codeChanged = !state.contact || state.contact.code !== code;
    const wasNamed = state.contact ? state.contact.name : null;

    state.contact = { name, code };
    store.set(STORAGE.contact, JSON.stringify(state.contact));
    state.contactState = "ok";

    if (codeChanged) {
      clearOutput();
      state.sessionAnnounced = false;
      state.warnedUnknown.clear();
      sys("> NEW SESSION");
      sys(`> CONTACT SET: ${name.toUpperCase()}`);
      sys("> FOR MESSAGES TO FLOW, THEY MUST ALSO ENTER YOUR CODE: " + groupCode(state.myId));
      watchPeer(code);
    } else if (wasNamed !== name) {
      sys(`> CONTACT RENAMED: ${wasNamed} → ${name}`);
    }

    updateUI();
    setMsg("ok", `> CONNECTED: ${name.toUpperCase()}`);
    setTimeout(() => { if (modalOpen === el.config) closeDialog(el.config); }, 800);
  } catch (err) {
    setMsg("err", `> ERROR: ${friendlyError(err)}. COULD NOT VERIFY CODE.`);
  } finally {
    el.connectBtn.disabled = false;
  }
}

/* ─────────────────────────── messaging (Firebase) ─────────────────────────── */

async function sendMessage(text) {
  const code = state.contact.code;
  const r = fb.push(fb.ref(db, `inbox/${code}`));
  await fb.set(r, { from: state.myId, text, ts: fb.serverTimestamp() });
  // If I vanish before the recipient picks it up, the server removes it.
  fb.onDisconnect(r).remove().catch(() => { /* message already collected */ });
}

function handleIncoming(snap) {
  const key = snap.key;
  const v = snap.val();

  // Delete from the server immediately: delivered (or rejected) = gone.
  fb.remove(snap.ref).catch(() => { /* ignore */ });

  if (state.seen.has(key)) return;               // never show the same message twice
  state.seen.add(key);
  if (state.seen.size > 3000) state.seen = new Set([...state.seen].slice(-1000));

  if (!v || typeof v.text !== "string" || !isValidId(v.from)) return;

  if (!state.contact || v.from !== state.contact.code) {
    if (!state.warnedUnknown.has(v.from)) {
      state.warnedUnknown.add(v.from);
      sys(`> IGNORED MESSAGE FROM UNKNOWN CODE ${groupCode(v.from)}`);
    }
    return;
  }

  const text = cleanText(v.text).slice(0, MAX_LEN);
  if (!text.trim()) return;
  const ts = typeof v.ts === "number" ? v.ts : Date.now();

  chat("peer", text, ts);
  beep();
  if (document.hidden) { state.unread += 1; document.title = `(${state.unread}) MESSAGE`; }
}

async function announcePresence() {
  if (!state.ready) return;
  try {
    const pr = fb.ref(db, `presence/${state.myId}`);
    await fb.onDisconnect(pr).remove();
    await fb.set(pr, true);
  } catch { /* retried on next reconnect */ }
}

async function onDbConnected() {
  if (!state.ready) return;
  await announcePresence();
  if (state.contact && state.contactState !== "ok") verifyContact();
}

/* ─────────────────────────── backend bootstrap ─────────────────────────── */

function fatal(lines) {
  state.fatal = true;
  state.fatalReason = lines[0];
  lines.forEach((l) => sys(l, "err"));
  updateUI();
}

async function initFirebase() {
  const base = `https://www.gstatic.com/firebasejs/${SDK_VERSION}`;
  const [appMod, authMod, dbMod] = await Promise.all([
    import(`${base}/firebase-app.js`),
    import(`${base}/firebase-auth.js`),
    import(`${base}/firebase-database.js`)
  ]);
  fb = dbMod;

  const app = appMod.initializeApp(FIREBASE_CONFIG);
  const auth = authMod.getAuth(app);
  db = dbMod.getDatabase(app);

  // Connection indicator (works before sign-in).
  fb.onValue(fb.ref(db, ".info/connected"), (snap) => {
    state.dbOnline = snap.val() === true;
    if (state.dbOnline) onDbConnected();
    updateUI();
  });

  // Anonymous identity (persisted by Firebase Auth, so my uid is stable per browser).
  await auth.authStateReady();
  if (!auth.currentUser) await withTimeout(authMod.signInAnonymously(auth), 15000, "auth timeout");
  state.uid = auth.currentUser.uid;

  // Bind my 16-digit ID to my uid. Only the owner may later write to it.
  let claimed = false;
  for (let attempt = 0; attempt < 2 && !claimed; attempt++) {
    try {
      await withTimeout(fb.set(fb.ref(db, `users/${state.myId}`), { uid: state.uid, registered: true }), 12000, "database timeout");
      claimed = true;
    } catch (e) {
      const denied = /permission_denied/i.test(`${e.code} ${e.message}`);
      if (!denied) throw e;
      if (state.freshId || attempt > 0) throw e;      // brand-new ID denied → rules problem, not a collision
      // Stored ID belongs to a different account (site data partly cleared) → new identity.
      state.myId = generateId();
      store.set(STORAGE.id, state.myId);
      state.freshId = true;
      showWelcome("YOUR PREVIOUS CODE COULD NOT BE VERIFIED, SO A NEW ONE WAS ISSUED. SHARE IT AGAIN.");
    }
  }
  sys("> USER IDENTIFIED");

  // Drop anything left over from an earlier session: nothing is ever replayed.
  const inbox = fb.ref(db, `inbox/${state.myId}`);
  try {
    const stale = await fb.get(inbox);
    stale.forEach((child) => { fb.remove(child.ref).catch(() => {}); });
  } catch { /* nothing to purge */ }

  fb.onChildAdded(inbox, handleIncoming, (err) => {
    sys(`> INBOX ERROR: ${friendlyError(err)}`, "err");
  });

  state.ready = true;
  if (state.dbOnline) onDbConnected();
  if (state.contact) verifyContact();
  else sys("> NO CONTACT CONFIGURED. PRESS [CONFIGURE] TO BEGIN.");
  updateUI();
}

/* ─────────────────────────── preferences ─────────────────────────── */

function applyPrefs() {
  state.soundOn = store.get(STORAGE.sound) !== "off";
  el.soundBtn.textContent = `SOUND: ${state.soundOn ? "ON" : "OFF"}`;
  el.soundBtn.setAttribute("aria-pressed", String(state.soundOn));

  const timeOn = store.get(STORAGE.time) !== "off";
  document.body.classList.toggle("no-time", !timeOn);
  el.timeBtn.textContent = `TIME: ${timeOn ? "ON" : "OFF"}`;
  el.timeBtn.setAttribute("aria-pressed", String(timeOn));
}

el.soundBtn.addEventListener("click", () => {
  store.set(STORAGE.sound, state.soundOn ? "off" : "on");
  applyPrefs();
  if (state.soundOn) { unlockAudio(); beep(); }
});

el.timeBtn.addEventListener("click", () => {
  const on = !document.body.classList.contains("no-time");
  store.set(STORAGE.time, on ? "off" : "on");
  applyPrefs();
});

/* ─────────────────────────── viewport (mobile keyboard) ─────────────────────────── */

function fit() {
  const vv = window.visualViewport;
  const root = document.documentElement.style;
  root.setProperty("--app-h", `${Math.round(vv ? vv.height : window.innerHeight)}px`);
  root.setProperty("--app-top", `${Math.round(vv ? vv.offsetTop : 0)}px`);
  if (document.activeElement === el.input) scrollBottom();
}

if (window.visualViewport) {
  window.visualViewport.addEventListener("resize", fit);
  window.visualViewport.addEventListener("scroll", fit);
}
window.addEventListener("resize", fit);
window.addEventListener("orientationchange", () => setTimeout(fit, 250));

/* ─────────────────────────── boot ─────────────────────────── */

async function boot() {
  fit();
  applyPrefs();
  sys("> INITIALIZING CONNECTION...");

  // Identity: created once, kept in localStorage, never changes unless storage is cleared.
  const saved = store.get(STORAGE.id);
  if (isValidId(saved)) {
    state.myId = saved;
  } else {
    state.myId = generateId();
    store.set(STORAGE.id, state.myId);
    state.freshId = true;
    showWelcome();
  }

  loadContact();
  updateUI();

  if (!isConfigured()) {
    fatal([
      "> SETUP REQUIRED: FIREBASE IS NOT CONFIGURED.",
      "> OPEN script.js, PASTE YOUR FIREBASE CONFIG INTO FIREBASE_CONFIG, THEN RELOAD.",
      "> SEE README.md FOR THE 3 SETUP STEPS."
    ]);
    return;
  }

  setTimeout(() => {
    if (!state.ready && !state.fatal) sys("> STILL CONNECTING... CHECK YOUR NETWORK AND FIREBASE CONFIG.");
  }, 15000);

  try {
    await initFirebase();
  } catch (e) {
    const m = `${e && e.code} ${e && e.message}`;
    if (/timeout/i.test(m)) {
      fatal(["> ERROR: COULD NOT REACH THE DATABASE (TIMED OUT).",
             "> CHECK databaseURL IN FIREBASE_CONFIG (FIREBASE CONSOLE → REALTIME DATABASE → DATA TAB, URL AT THE TOP) AND THAT THE DATABASE WAS CREATED."]);
    } else if (/permission_denied/i.test(m)) {
      fatal(["> ERROR: ACCESS DENIED BY DATABASE RULES.", "> PUBLISH database.rules.json IN FIREBASE CONSOLE → REALTIME DATABASE → RULES."]);
    } else if (/operation-not-allowed|admin-restricted|configuration-not-found/i.test(m)) {
      fatal(["> ERROR: ANONYMOUS SIGN-IN IS DISABLED OR NOT INITIALIZED.", "> IN FIREBASE CONSOLE: BUILD → AUTHENTICATION → GET STARTED → SIGN-IN METHOD → ENABLE ANONYMOUS."]);
    } else if (/unauthorized-domain/i.test(m)) {
      fatal(["> ERROR: THIS DOMAIN IS NOT AUTHORIZED.", "> ADD IT: FIREBASE CONSOLE → AUTHENTICATION → SETTINGS → AUTHORIZED DOMAINS."]);
    } else if (/import|fetch|module|load/i.test(m) && !state.ready) {
      fatal(["> ERROR: COULD NOT LOAD THE FIREBASE SDK. CHECK YOUR INTERNET CONNECTION."]);
    } else {
      fatal([`> ERROR: BACKEND SETUP FAILED (${String((e && (e.code || e.message)) || e).slice(0, 80)})`]);
    }
    console.error(e);
  }
}

boot();
