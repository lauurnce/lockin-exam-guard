/*
 * pill.js
 * Classic content script for https://docs.google.com/forms/* (not a module,
 * so the few constants it needs are inlined below).
 * - Reads lockin_public from chrome.storage.local and follows onChanged.
 *   Renders nothing while mode is "off".
 * - Draws a status pill (top-right) inside a CLOSED Shadow DOM: green
 *   "Locked in · 12:04", red "3 violations", gray "Submitted ✓" + Done.
 *   Clicking expands a card with exam name, elapsed time, last violation,
 *   End exam / Clear warning behind the professor PIN.
 * - Red 3px inset overlay around the viewport while triggered.
 * - 4s toasts when lastViolation / lastWarning / notice timestamps change.
 * - Blocks paste and (optionally) right-click in the capture phase while
 *   armed/triggered and reports them as CONTENT_EVENTs.
 * - Strict submission detection on /formResponse pages (see detectSubmitted).
 * - Survives the extension being reloaded: every chrome.* call is guarded and
 *   the UI tears itself down when the runtime is gone.
 */
(function () {
  "use strict";

  if (window.__lockinPillLoaded) return;
  window.__lockinPillLoaded = true;

  /* ---------- inlined constants (mirror lib/constants.js) ---------- */
  var PUBLIC_KEY = "lockin_public";
  var C = {
    surface: "#FFFFFF", text: "#18181B", muted: "#71717A", border: "#E4E4E7",
    gray: "#A1A1AA", green: "#16A34A", greenSoft: "#DCFCE7", red: "#DC2626", redSoft: "#FEE2E2",
    bg: "#F4F4F5",
  };
  var TOAST_MS = 4000;
  var SETTLE_MS = 800;
  var NAV_BUTTON_RE = /^(next|submit|back|susunod|isumite|bumalik)$/i;

  var pub = null;            // latest lockin_public
  var seen = { v: null, w: null, n: null };
  var expanded = false;
  var pinAction = null;      // "end" | "clear" | null
  var pinLockedUntil = 0;
  var submittedSent = false;
  var dead = false;
  var tickTimer = null;

  /* ---------- runtime guards ---------- */

  function runtimeAlive() {
    try { return !!(chrome && chrome.runtime && chrome.runtime.id); } catch (e) { return false; }
  }

  function send(msg) {
    if (!runtimeAlive()) { teardown(); return Promise.resolve(null); }
    try {
      return chrome.runtime.sendMessage(msg).catch(function () { return null; });
    } catch (e) {
      teardown();
      return Promise.resolve(null);
    }
  }

  function isActive() {
    return !!pub && (pub.mode === "armed" || pub.mode === "triggered");
  }

  /* ---------- formatting ---------- */

  function elapsed(ms) {
    if (!isFinite(ms) || ms < 0) ms = 0;
    var s = Math.floor(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = String(s % 60).padStart(2, "0");
    return h > 0 ? h + ":" + String(m).padStart(2, "0") + ":" + sec : m + ":" + sec;
  }

  function clock(ts) {
    try { return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
    catch (e) { return ""; }
  }

  function plural(n, w) { return n + " " + w + (n === 1 ? "" : "s"); }

  /* ---------- DOM (closed shadow root) ---------- */

  var host = document.createElement("div");
  host.setAttribute("data-lockin", "");
  host.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:2147483647;";
  var root = host.attachShadow({ mode: "closed" });

  var FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
  var css = [
    ":host{all:initial}",
    "*{box-sizing:border-box}",
    "[hidden]{display:none!important}",
    ".wrap{position:fixed;top:12px;right:12px;display:flex;flex-direction:column;align-items:flex-end;gap:8px;",
    "  font:13px/1.4 " + FONT + ";color:" + C.text + ";z-index:2}",
    ".pill{display:inline-flex;align-items:center;gap:8px;height:32px;padding:0 14px 0 12px;border-radius:999px;",
    "  background:" + C.surface + ";border:1px solid " + C.border + ";color:" + C.text + ";font:inherit;font-weight:550;",
    "  cursor:pointer;box-shadow:0 1px 3px rgba(24,24,27,.08);white-space:nowrap;font-variant-numeric:tabular-nums}",
    ".pill:focus-visible,button:focus-visible,input:focus-visible{outline:2px solid var(--s);outline-offset:2px}",
    ".dot{width:8px;height:8px;border-radius:50%;background:var(--s);flex:none}",
    ".muted{color:" + C.muted + ";font-weight:400}",
    ".wrap[data-mode=armed]{--s:" + C.green + ";--soft:" + C.greenSoft + "}",
    ".wrap[data-mode=triggered]{--s:" + C.red + ";--soft:" + C.redSoft + "}",
    ".wrap[data-mode=submitted]{--s:" + C.gray + ";--soft:" + C.bg + "}",
    ".wrap[data-mode=triggered] .pill{border-color:" + C.red + ";color:" + C.red + "}",
    ".row{display:inline-flex;align-items:center;gap:8px}",
    ".done{height:32px;padding:0 14px;border-radius:999px;border:0;background:#3F3F46;color:#fff;font:inherit;font-weight:600;cursor:pointer}",
    ".card{width:280px;background:" + C.surface + ";border:1px solid " + C.border + ";border-radius:12px;padding:14px;",
    "  box-shadow:0 4px 16px rgba(24,24,27,.08)}",
    ".card dl{margin:0;display:grid;grid-template-columns:auto 1fr;gap:4px 12px}",
    ".card dt{color:" + C.muted + "}",
    ".card dd{margin:0;text-align:right;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-variant-numeric:tabular-nums}",
    ".last{margin:10px 0 0;padding:8px 10px;border-radius:10px;background:var(--soft)}",
    ".last time{color:" + C.muted + "}",
    ".links{display:flex;justify-content:flex-end;gap:14px;margin-top:12px}",
    ".link{background:none;border:0;padding:0;font:inherit;font-size:12px;color:" + C.muted + ";text-decoration:underline;",
    "  text-decoration-color:" + C.border + ";text-underline-offset:3px;cursor:pointer}",
    ".link:hover{color:" + C.text + "}",
    ".pin{margin-top:12px;padding-top:12px;border-top:1px solid " + C.border + ";display:flex;flex-direction:column;gap:8px}",
    ".pin label{color:" + C.muted + ";font-size:12px}",
    ".pin input{font:inherit;width:100%;padding:7px 10px;border:1px solid " + C.border + ";border-radius:10px;color:" + C.text + ";background:#fff;outline:none}",
    ".pin input:disabled{background:" + C.bg + "}",
    ".pin .btns{display:flex;gap:8px}",
    ".pin button{flex:1;font:inherit;border-radius:10px;padding:7px 10px;cursor:pointer}",
    ".pin .cancel{background:#fff;border:1px solid " + C.border + ";color:" + C.text + "}",
    ".pin .go{background:var(--s);border:0;color:#fff;font-weight:600}",
    ".pin .go:disabled{opacity:.5;cursor:default}",
    ".pinerr{margin:0;color:" + C.red + ";font-size:12px}",
    ".toasts{display:flex;flex-direction:column;align-items:flex-end;gap:6px}",
    ".toast{max-width:320px;padding:8px 12px;border-radius:10px;background:" + C.text + ";color:#fff;font-size:12.5px;",
    "  box-shadow:0 4px 16px rgba(24,24,27,.15);animation:in .18s ease-out}",
    ".toast.red{background:" + C.red + "}",
    "@keyframes in{from{opacity:0;transform:translateY(-4px)}to{opacity:1;transform:none}}",
    ".frame{position:fixed;inset:0;pointer-events:none;box-shadow:inset 0 0 0 3px " + C.red + ";z-index:1}",
    "@media (prefers-reduced-motion: reduce){*{animation:none!important;transition:none!important}}",
  ].join("\n");

  // Built with DOM APIs (no innerHTML): Google pages enforce Trusted Types.
  function h(tag, attrs, kids) {
    var el = document.createElement(tag);
    if (attrs) Object.keys(attrs).forEach(function (k) {
      if (k === "text") el.textContent = attrs[k];
      else if (k === "hidden") el.hidden = !!attrs[k];
      else el.setAttribute(k, attrs[k]);
    });
    (kids || []).forEach(function (c) { el.appendChild(c); });
    return el;
  }

  var styleEl = document.createElement("style");
  styleEl.textContent = css;
  root.appendChild(styleEl);
  root.appendChild(h("div", { "class": "frame", hidden: true }));
  root.appendChild(h("div", { "class": "wrap", "data-mode": "off", hidden: true }, [
    h("div", { "class": "row" }, [
      h("button", { "class": "pill", type: "button", "aria-expanded": "false" }, [
        h("span", { "class": "dot" }), h("span", { "class": "ptext" }),
      ]),
      h("button", { "class": "done", type: "button", text: "Done", hidden: true }),
    ]),
    h("div", { "class": "card", hidden: true }, [
      h("dl", null, [
        h("dt", { text: "Exam" }), h("dd", { "class": "c-exam" }),
        h("dt", { "class": "c-elapsed-l", text: "Elapsed" }), h("dd", { "class": "c-elapsed" }),
        h("dt", { text: "Violations" }), h("dd", { "class": "c-count" }),
      ]),
      h("p", { "class": "last", hidden: true }),
      h("div", { "class": "links" }, [
        h("button", { "class": "link clear", type: "button", text: "Clear warning (professor)", hidden: true }),
        h("button", { "class": "link end", type: "button", text: "End exam" }),
      ]),
      h("form", { "class": "pin", hidden: true, novalidate: "" }, [
        h("label", { "for": "lockin-pin", "class": "pinlabel", text: "Professor PIN" }),
        h("input", { id: "lockin-pin", type: "password", inputmode: "numeric", autocomplete: "off", placeholder: "PIN" }),
        h("p", { "class": "pinerr", hidden: true }),
        h("div", { "class": "btns" }, [
          h("button", { type: "button", "class": "cancel", text: "Cancel" }),
          h("button", { type: "submit", "class": "go", text: "End exam" }),
        ]),
      ]),
    ]),
    h("div", { "class": "toasts", "aria-live": "polite" }),
  ]));

  function q(sel) { return root.querySelector(sel); }
  var ui = {
    frame: q(".frame"), wrap: q(".wrap"), pill: q(".pill"), ptext: q(".ptext"), done: q(".done"),
    card: q(".card"), exam: q(".c-exam"), elapsedL: q(".c-elapsed-l"), elapsed: q(".c-elapsed"), count: q(".c-count"),
    last: q(".last"), clear: q(".clear"), end: q(".end"), pinForm: q(".pin"), pinLabel: q(".pinlabel"),
    pin: q("#lockin-pin"), pinErr: q(".pinerr"), cancel: q(".cancel"), go: q(".go"), toasts: q(".toasts"),
  };

  function mount() {
    if (!host.isConnected) (document.body || document.documentElement).appendChild(host);
  }

  function teardown() {
    if (dead) return;
    dead = true;
    clearInterval(tickTimer);
    if (observer) observer.disconnect();
    document.removeEventListener("paste", onPaste, true);
    document.removeEventListener("contextmenu", onContextMenu, true);
    if (host.isConnected) host.remove();
  }

  /* ---------- rendering ---------- */

  function render() {
    if (dead) return;
    var mode = pub && pub.mode;
    if (!mode || mode === "off") {
      ui.wrap.hidden = true;
      ui.frame.hidden = true;
      expanded = false;
      closePin();
      return;
    }
    mount();
    ui.wrap.hidden = false;
    ui.wrap.setAttribute("data-mode", mode);
    ui.frame.hidden = mode !== "triggered";

    var count = pub.violationCount || 0;
    var submitted = mode === "submitted";
    ui.done.hidden = !submitted;
    ui.exam.textContent = pub.examName || "Exam";
    ui.exam.title = pub.examName || "";
    ui.count.textContent = String(count);
    ui.end.hidden = submitted;
    ui.clear.hidden = mode !== "triggered";
    if (submitted || (mode !== "triggered" && pinAction === "clear")) closePin();
    ui.elapsedL.textContent = submitted ? "Time taken" : "Elapsed";

    var lv = pub.lastViolation;
    if (lv && lv.label) {
      ui.last.textContent = "";
      var t = document.createElement("time");
      t.textContent = clock(lv.ts) + "  ";
      ui.last.appendChild(t);
      ui.last.appendChild(document.createTextNode(lv.label));
      ui.last.hidden = false;
    } else {
      ui.last.hidden = true;
    }

    ui.card.hidden = !expanded;
    ui.pill.setAttribute("aria-expanded", String(expanded));
    tick();
  }

  function tick() {
    if (dead || !pub || !pub.mode || pub.mode === "off") return;
    var mode = pub.mode;
    var count = pub.violationCount || 0;
    var started = pub.startedAt || Date.now();
    var text;
    if (mode === "submitted") {
      var end = pub.submittedAt || Date.now();
      text = "LockIn · Submitted ✓";
      ui.elapsed.textContent = elapsed(end - started);
    } else {
      var e = elapsed(Date.now() - started);
      ui.elapsed.textContent = e;
      text = mode === "triggered" ? "LockIn · " + plural(count, "violation") : "LockIn · Locked in · " + e;
    }
    if (ui.ptext.textContent !== text) ui.ptext.textContent = text;
    if (pinAction) renderPinLock();
  }

  /* ---------- toasts ---------- */

  function toast(text, red) {
    if (dead) return;
    mount();
    var el = document.createElement("div");
    el.className = "toast" + (red ? " red" : "");
    el.textContent = text;
    ui.toasts.appendChild(el);
    while (ui.toasts.children.length > 3) ui.toasts.firstChild.remove();
    setTimeout(function () { el.remove(); }, TOAST_MS);
  }

  function checkToasts(initial) {
    if (!pub) return;
    var now = Date.now();
    var items = [
      ["v", pub.lastViolation, function (x) { return "Recorded: " + x.label + " · " + clock(x.ts); }, true],
      ["w", pub.lastWarning, function (x) { return "Logged: " + x.label + " · " + clock(x.ts); }, false],
      ["n", pub.notice, function (x) { return x.text; }, false],
    ];
    items.forEach(function (it) {
      var key = it[0], val = it[1];
      var ts = val && val.ts;
      if (!ts || ts === seen[key]) return;
      seen[key] = ts;
      // On first load, only toast events from the last few seconds
      // (e.g. the page just reloaded after a blocked navigation).
      if (initial && now - ts > 5000) return;
      if (pub.mode === "off") return;
      if (key !== "n" && !(val.label)) return;
      if (key === "n" && !val.text) return;
      toast(it[2](val), it[3]);
    });
  }

  /* ---------- PIN ---------- */

  function openPin(action) {
    pinAction = action;
    ui.pinForm.hidden = false;
    ui.pinErr.hidden = true;
    ui.pin.value = "";
    ui.pinLabel.textContent = action === "end" ? "Professor PIN to end the exam" : "Professor PIN to clear the warning";
    ui.go.textContent = action === "end" ? "End exam" : "Clear warning";
    renderPinLock();
    if (!ui.pin.disabled) ui.pin.focus();
  }

  function closePin() {
    pinAction = null;
    ui.pinForm.hidden = true;
    ui.pin.value = "";
  }

  function renderPinLock() {
    var left = pinLockedUntil - Date.now();
    var locked = left > 0;
    ui.pin.disabled = locked;
    ui.go.disabled = locked;
    if (locked) {
      ui.pinErr.textContent = "Too many wrong tries. Try again in " + Math.ceil(left / 1000) + "s.";
      ui.pinErr.hidden = false;
    } else if (/Too many wrong tries/.test(ui.pinErr.textContent)) {
      ui.pinErr.textContent = "";
      ui.pinErr.hidden = true;
    }
  }

  ui.pinForm.addEventListener("submit", function (ev) {
    ev.preventDefault();
    if (!pinAction) return;
    var pin = ui.pin.value.trim();
    if (!pin) {
      ui.pinErr.textContent = "Enter the professor PIN.";
      ui.pinErr.hidden = false;
      return;
    }
    var action = pinAction;
    ui.go.disabled = true;
    send({ type: action === "end" ? "END_EXAM" : "CLEAR_WARNING", pin: pin }).then(function (res) {
      ui.go.disabled = false;
      if (res && res.ok) {
        closePin();
        if (action === "end") expanded = false;
        render();
        return;
      }
      if (res && res.lockedUntil) pinLockedUntil = res.lockedUntil;
      ui.pin.value = "";
      ui.pinErr.textContent = (res && res.error) || "LockIn did not answer. Try again.";
      ui.pinErr.hidden = false;
      renderPinLock();
      if (!ui.pin.disabled) ui.pin.focus();
    });
  });

  ui.cancel.addEventListener("click", closePin);
  ui.end.addEventListener("click", function () { pinAction === "end" ? closePin() : openPin("end"); });
  ui.clear.addEventListener("click", function () { pinAction === "clear" ? closePin() : openPin("clear"); });
  ui.pill.addEventListener("click", function () {
    expanded = !expanded;
    if (!expanded) closePin();
    render();
  });
  ui.done.addEventListener("click", function () {
    ui.done.disabled = true;
    send({ type: "DONE" }).then(function () { ui.done.disabled = false; });
  });

  // Keep keystrokes typed into our PIN field from reaching Google Forms' shortcuts.
  ["keydown", "keyup", "keypress"].forEach(function (t) {
    root.addEventListener(t, function (e) { e.stopPropagation(); });
  });

  /* ---------- paste / context menu ---------- */

  function fromOurUi(e) {
    try { return e.composedPath().indexOf(host) !== -1; } catch (err) { return false; }
  }

  function onPaste(e) {
    if (dead || !isActive() || !pub.blockPaste || fromOurUi(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    var n = 0;
    try { n = (e.clipboardData && e.clipboardData.getData("text/plain") || "").length; } catch (err) { n = 0; }
    // Only the length is reported, never the pasted text.
    send({ type: "CONTENT_EVENT", kind: "PASTE", detail: n ? n + " characters" : "" });
  }

  function onContextMenu(e) {
    if (dead || !isActive() || !pub.blockContextMenu || fromOurUi(e)) return;
    e.preventDefault();
    e.stopImmediatePropagation();
    send({ type: "CONTENT_EVENT", kind: "CONTEXT_MENU", detail: "" });
  }

  document.addEventListener("paste", onPaste, true);
  document.addEventListener("contextmenu", onContextMenu, true);

  /* ---------- submission detection ---------- */

  var observer = null;
  var settleTimer = null;

  function isVisible(el) {
    if (host.contains(el)) return false;
    if (!el.getClientRects().length) return false;
    var cs = getComputedStyle(el);
    return cs.visibility !== "hidden" && cs.display !== "none" && Number(cs.opacity) !== 0;
  }

  // Strict: only a /formResponse page with NO visible inputs and NO
  // Next / Submit / Back buttons counts as submitted. When in doubt, it is not.
  function detectSubmitted() {
    if (location.href.indexOf("/formResponse") === -1) return false;
    if (!document.body) return false;
    var inputs = document.querySelectorAll(
      'input:not([type=hidden]), textarea, [role=radio], [role=checkbox], [role=listbox]'
    );
    for (var i = 0; i < inputs.length; i++) if (isVisible(inputs[i])) return false;
    var buttons = document.querySelectorAll("[role=button], button");
    for (var j = 0; j < buttons.length; j++) {
      var txt = (buttons[j].textContent || "").replace(/\s+/g, " ").trim();
      if (NAV_BUTTON_RE.test(txt) && isVisible(buttons[j])) return false;
    }
    return true;
  }

  var pendingSince = 0;
  function scheduleCheck() {
    clearTimeout(settleTimer);
    var now = Date.now();
    if (!pendingSince) pendingSince = now;
    // A page that never goes quiet still gets checked every few seconds.
    var wait = now - pendingSince > 4000 ? 0 : SETTLE_MS;
    settleTimer = setTimeout(function () { pendingSince = 0; runCheck(); }, wait);
  }

  function runCheck() {
    if (dead || submittedSent || !isActive()) return;
    if (detectSubmitted()) {
      submittedSent = true;
      if (observer) observer.disconnect();
      send({ type: "CONTENT_EVENT", kind: "FORM_SUBMITTED", detail: location.pathname }).then(function (res) {
        if (!res || !res.ok) submittedSent = false; // let a later settle retry
      });
    }
  }

  function startSubmissionWatch() {
    if (observer || location.href.indexOf("/formResponse") === -1) return;
    observer = new MutationObserver(function (mutations) {
      // Ignore our own shadow host being added/removed.
      for (var i = 0; i < mutations.length; i++) {
        if (mutations[i].target !== host && !host.contains(mutations[i].target)) { scheduleCheck(); return; }
      }
    });
    observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
    scheduleCheck(); // the DOM may already be quiet
  }

  /* ---------- storage ---------- */

  function onPublic(next, initial) {
    var prevMode = pub && pub.mode;
    pub = next || null;
    if (prevMode && pub && prevMode !== pub.mode && pub.mode === "submitted") expanded = false;
    checkToasts(initial);
    render();
    if (isActive()) startSubmissionWatch();
  }

  try {
    chrome.storage.local.get(PUBLIC_KEY).then(function (got) {
      onPublic(got && got[PUBLIC_KEY], true);
    }).catch(function () { /* runtime gone */ });

    chrome.storage.onChanged.addListener(function (changes, area) {
      if (dead) return;
      if (!runtimeAlive()) { teardown(); return; }
      if (area !== "local" || !changes[PUBLIC_KEY]) return;
      onPublic(changes[PUBLIC_KEY].newValue, false);
    });
  } catch (e) {
    teardown();
    return;
  }

  tickTimer = setInterval(function () {
    if (!runtimeAlive()) { teardown(); return; }
    tick();
  }, 1000);
})();
