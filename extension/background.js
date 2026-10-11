/*
 * background.js
 * LockIn service worker (Manifest V3, ES module).
 *
 * Every listener is registered synchronously at the top level. Handlers run
 * one at a time through a promise queue (withLock) so concurrent events never
 * clobber `lockin_state`; each handler loads state from chrome.storage.local
 * first and does nothing while LockIn is off.
 *
 * What lives here:
 * - runtime messages from the popup, pill and blocked page (CONTRACTS.md)
 * - the 15 detection rules of SPEC 6.5 (tabs, windows, navigation, focus,
 *   companion events, restart, own options page)
 * - the violation pipeline (SPEC 6.6) and exam ending (SPEC 6.7)
 * - forms.gle form ID learning, helper tabs opened by the exam, the
 *   LEFT_BROWSER grace timer (persisted so a sleeping worker re-checks it)
 * Pure logic lives in lib/state.js, lib/rules.js and lib/examcode.js.
 */

import {
  MODES,
  MSG,
  POPUP_PORT,
  HEARTBEAT_ALARM,
  COMPANION_STATUS,
  CATEGORIES,
  DEFAULT_OPTIONS,
  WARNING_TYPES,
  formatLabel,
} from "./lib/constants.js";
import {
  defaultState,
  loadState,
  saveState,
  isActive,
  getOptions,
  sanitizeState,
  applyViolation,
  makeId,
  newSession,
  buildLastSession,
  saveLastSession,
  loadLastSession,
  saveStudentPrefs,
  checkPin,
  pinLockedUntil,
} from "./lib/state.js";
import { classifyUrl, isEnforced } from "./lib/rules.js";
import { decodeExamCode, extractFormId } from "./lib/examcode.js";
import * as companion from "./lib/companion.js";
import * as reporter from "./lib/reporter.js";
import { updateAction } from "./lib/icons.js";

/* ------------------------------------------------------------------ */
/* In-memory helpers (lost when the worker sleeps; nothing critical)   */
/* ------------------------------------------------------------------ */

const RETRY_TRIES = 5;
const RETRY_DELAY_MS = 120;
const NEWTAB_RE = /^(chrome|edge|brave|vivaldi|opera):\/\/(newtab|new-tab-page)|^chrome-search:\/\/local-ntp|^about:newtab/i;
const IDLE_DISCONNECT_MS = 120000;

let popupPorts = 0;
let suppressFocusUntil = 0; // our own window operations cause focus churn
let suppressNewUntil = 0; // after browser restart, restored windows/tabs are not "new"
let graceTimer = null;
let idleDisconnectTimer = null;
const newWindowIds = new Set(); // windows.onCreated seen, still being decided
const createdTabIds = new Set(); // tabs.onCreated seen recently (onActivated skips them)
const closedTabIds = new Set(); // tabs we closed ourselves
const closedInWindowAt = new Map(); // windowId -> ts we closed a tab there
let lastBlockedNav = { tabId: null, url: "", ts: 0 };

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function rememberFor(set, value, ms) {
  set.add(value);
  setTimeout(() => set.delete(value), ms);
}

function extensionOrigin() {
  try {
    return chrome.runtime.getURL("").replace(/\/$/, "");
  } catch (e) {
    return "";
  }
}

function blockedPageUrl(url, category, site) {
  return (
    chrome.runtime.getURL("blocked/blocked.html") +
    "?u=" + encodeURIComponent(url) +
    "&c=" + encodeURIComponent(category) +
    "&s=" + encodeURIComponent(site || "") +
    "&t=" + Date.now()
  );
}

function isBlockedPage(url) {
  try {
    return !!url && url.startsWith(chrome.runtime.getURL("blocked/"));
  } catch (e) {
    return false;
  }
}

function hostOf(url) {
  try {
    return new URL(url).hostname || url;
  } catch (e) {
    return String(url || "").slice(0, 80);
  }
}

function tabUrl(tab) {
  return (tab && (tab.pendingUrl || tab.url)) || "";
}

/* Retry helper for tab/window calls ("Tabs cannot be edited right now"). */
async function retry(fn) {
  for (let i = 0; i < RETRY_TRIES; i++) {
    try {
      return await fn();
    } catch (e) {
      const msg = String((e && e.message) || e);
      if (/No (tab|window) with id|Invalid (tab|window)|cannot be found/i.test(msg)) return null;
      if (i === RETRY_TRIES - 1) {
        console.warn("[LockIn] chrome call failed", msg);
        return null;
      }
      await sleep(RETRY_DELAY_MS);
    }
  }
  return null;
}

async function safe(fn) {
  try {
    return await fn();
  } catch (e) {
    return null;
  }
}

/* Serialize every state-mutating handler. */
let lockChain = Promise.resolve();
function withLock(fn) {
  const run = lockChain.then(fn);
  lockChain = run.catch((e) => console.warn("[LockIn] handler failed", e));
  return run;
}

/* Fire-and-forget variant for event listeners: never rejects. */
function fire(fn) {
  return withLock(fn).catch(() => undefined);
}

/* Run fn(state) only while armed/triggered. Also re-checks a pending focus loss. Never rejects. */
function withActive(fn, opts = {}) {
  return fire(async () => {
    const state = await loadState();
    if (!isActive(state)) return undefined;
    if (!opts.skipFocusCheck) await finalizeFocusLoss(state);
    return fn(state);
  });
}

function detectBrowserFamily() {
  try {
    const brands = ((navigator.userAgentData && navigator.userAgentData.brands) || []).map((b) => b.brand);
    if (brands.includes("Microsoft Edge")) return "Microsoft Edge";
    if (brands.includes("Brave") || navigator.brave) return "Brave";
    if (brands.includes("Google Chrome")) return "Google Chrome";
  } catch (e) {
    /* ignore */
  }
  return "Chromium";
}

async function getPlatform() {
  try {
    const info = await chrome.runtime.getPlatformInfo();
    if (info.os === "mac") return "mac";
    if (info.os === "win") return "win";
    return "linux";
  } catch (e) {
    return "linux";
  }
}

function categoriesOf(state) {
  return getOptions(state).categories || DEFAULT_OPTIONS.categories;
}

/* Allowed by rules.js, or a known category the professor did not enforce. */
function verdict(state, url) {
  const cfg = state.config || {};
  const cls = classifyUrl(url, {
    formId: cfg.formId || null,
    allow: cfg.allow || [],
    extensionOrigin: extensionOrigin(),
  });
  const allowed = cls.allowed || !isEnforced(cls.category, categoriesOf(state));
  return { allowed, category: cls.category, site: cls.site || hostOf(url), cls };
}

/* App categories: WORD counts as DOCS; IGNORE never counts. */
function appEnforced(category, categories) {
  if (!category || category === "IGNORE") return false;
  if (category === "WORD") return categories.includes("DOCS");
  if (CATEGORIES.includes(category)) return categories.includes(category);
  return true;
}

function helperTab(state, tabId) {
  return state.helperTabs.includes(tabId);
}

function addHelperTab(state, tabId) {
  if (!state.helperTabs.includes(tabId)) state.helperTabs.push(tabId);
}

function isPending(state, tabId) {
  return Object.prototype.hasOwnProperty.call(state.pendingTabs, String(tabId));
}

async function closeTab(tabId) {
  rememberFor(closedTabIds, tabId, 5000);
  const tab = await safe(() => chrome.tabs.get(tabId));
  if (tab) closedInWindowAt.set(tab.windowId, Date.now());
  await retry(() => chrome.tabs.remove(tabId));
}

async function windowExists(id) {
  if (id == null) return false;
  return !!(await safe(() => chrome.windows.get(id)));
}

async function examWindowFocused(state) {
  const w = await safe(() => chrome.windows.get(state.examWindowId));
  return !!(w && w.focused);
}

async function focusExam(state) {
  suppressFocusUntil = Date.now() + 800;
  if (state.examWindowId != null) await retry(() => chrome.windows.update(state.examWindowId, { focused: true }));
  if (state.examTabId != null) await retry(() => chrome.tabs.update(state.examTabId, { active: true }));
}

function notify(message) {
  try {
    chrome.notifications.create(
      "lockin-" + Date.now(),
      { type: "basic", iconUrl: "icons/icon-128.png", title: "LockIn", message, priority: 2 },
      () => void chrome.runtime.lastError
    );
  } catch (e) {
    console.warn("[LockIn] notification failed", e);
  }
}

async function ensureAlarm() {
  try {
    const a = await chrome.alarms.get(HEARTBEAT_ALARM);
    if (!a) await chrome.alarms.create(HEARTBEAT_ALARM, { periodInMinutes: 1 });
  } catch (e) {
    console.warn("[LockIn] alarm create failed", e);
  }
}

async function clearAlarmIfIdle() {
  try {
    if ((await reporter.outboxSize()) === 0) await chrome.alarms.clear(HEARTBEAT_ALARM);
  } catch (e) {
    /* ignore */
  }
}

/* ------------------------------------------------------------------ */
/* Violation pipeline (SPEC 6.6)                                       */
/* ------------------------------------------------------------------ */

/*
 * info: { category, label, detail, url, app, durationMs, ts, notify: "force"|false|undefined, message }
 * Must be called inside withLock with the loaded state; saves state.
 */
async function recordViolation(state, type, info = {}) {
  const now = info.ts || Date.now();
  const rec = {
    id: makeId(),
    ts: now,
    type,
    category: info.category || null,
    label: info.label || formatLabel(type),
    detail: info.detail || "",
    durationMs: info.durationMs == null ? null : info.durationMs,
    count: 1,
  };
  if (info.url) rec.url = info.url;
  if (info.app) rec.app = info.app;
  const { record, deduped } = applyViolation(state, rec, Date.now());
  await saveState(state);
  await updateAction(state);
  if (deduped) return record;
  const warning = WARNING_TYPES.includes(type);
  await reporter
    .queueEvent(state, warning ? "WARNING" : "VIOLATION", {
      type,
      category: record.category,
      label: record.label,
      detail: record.detail,
      durationMs: record.durationMs,
      violationId: record.id,
      ts: record.ts,
    })
    .catch(() => null);
  if (!warning && info.notify !== false) {
    if (info.notify === "force" || !(await examWindowFocused(state))) {
      notify(info.message || "Recorded: " + record.label);
    }
  }
  return record;
}

function violationForUrl(url, v) {
  if (NEWTAB_RE.test(url) || v.category === "OTHER") {
    return { type: "NEW_TAB", info: { category: v.category, detail: hostOf(url), url } };
  }
  return {
    type: "BLOCKED_SITE",
    info: { category: v.category, label: formatLabel("BLOCKED_SITE", { site: v.site }), detail: v.site, url },
  };
}

async function setNotice(state, text) {
  state.notice = { text, ts: Date.now() };
  await saveState(state);
}

/* ------------------------------------------------------------------ */
/* Rule 1 / 9 / 15: new tabs                                           */
/* ------------------------------------------------------------------ */

async function handleTabCreated(state, tab) {
  if (!tab || tab.id == null || tab.id === state.examTabId) return;
  if (helperTab(state, tab.id) || isPending(state, tab.id)) return;
  if (Date.now() < suppressNewUntil) return;
  if (newWindowIds.has(tab.windowId) && tab.windowId !== state.examWindowId) return; // window rule decides
  if (!(await windowExists(state.examWindowId))) return; // restart/close in progress
  const url = tabUrl(tab);
  if (!url || verdict(state, url).category === "TRANSITIONAL") {
    state.pendingTabs[String(tab.id)] = { opener: tab.openerTabId == null ? null : tab.openerTabId, ts: Date.now() };
    await saveState(state);
    return;
  }
  await resolveNewTab(state, tab.id, url);
}

async function resolveNewTab(state, tabId, url) {
  delete state.pendingTabs[String(tabId)];
  const v = verdict(state, url);
  if (v.category === "OWN_OPTIONS") {
    await closeTab(tabId);
    await setNotice(state, "Not available during the exam");
    await focusExam(state);
    return;
  }
  if (v.allowed) {
    addHelperTab(state, tabId); // e.g. Google sign-in opened by the exam tab
    await saveState(state);
    return;
  }
  await closeTab(tabId);
  const { type, info } = violationForUrl(url, v);
  await recordViolation(state, type, info);
  await focusExam(state);
}

/* ------------------------------------------------------------------ */
/* Rule 3: navigation inside the exam tab (and helper tabs)            */
/* ------------------------------------------------------------------ */

async function handleExamNavigation(state, tabId, url) {
  if (!url) return;
  const v = verdict(state, url);
  if (v.category === "BLOCKED_PAGE" || v.category === "TRANSITIONAL") return;
  if (v.allowed) {
    if (v.category === "EXAM") {
      let changed = state.lastAllowedExamUrl !== url;
      state.lastAllowedExamUrl = url;
      // forms.gle learning (SPEC 6.4.5): save the real form ID once.
      if (!state.config.formId) {
        const id = safeExtract(url);
        if (id) {
          state.config.formId = id;
          changed = true;
        }
      }
      if (changed) await saveState(state);
    }
    return;
  }
  if (lastBlockedNav.tabId === tabId && lastBlockedNav.url === url && Date.now() - lastBlockedNav.ts < 3000) return;
  lastBlockedNav = { tabId, url, ts: Date.now() };
  if (v.category === "OWN_OPTIONS") {
    await retry(() => chrome.tabs.update(tabId, { url: state.lastAllowedExamUrl || state.config.formUrl }));
    await setNotice(state, "Not available during the exam");
    return;
  }
  await retry(() => chrome.tabs.update(tabId, { url: blockedPageUrl(url, v.category, v.site) }));
  await recordViolation(state, "BLOCKED_SITE", {
    category: v.category,
    label: formatLabel("BLOCKED_SITE", { site: v.site }),
    detail: v.site,
    url,
  });
}

function safeExtract(url) {
  try {
    return extractFormId(url);
  } catch (e) {
    return null;
  }
}

async function handleHelperNavigation(state, tabId, url) {
  const v = verdict(state, url);
  if (v.allowed) return;
  if (lastBlockedNav.tabId === tabId && lastBlockedNav.url === url && Date.now() - lastBlockedNav.ts < 3000) return;
  lastBlockedNav = { tabId, url, ts: Date.now() };
  if (v.category === "OWN_OPTIONS") {
    await closeTab(tabId);
    await setNotice(state, "Not available during the exam");
    return;
  }
  await retry(() => chrome.tabs.update(tabId, { url: blockedPageUrl(url, v.category, v.site) }));
  await recordViolation(state, "BLOCKED_SITE", {
    category: v.category,
    label: formatLabel("BLOCKED_SITE", { site: v.site }),
    detail: v.site,
    url,
  });
}

async function handleNavigation(state, tabId, url) {
  if (!url) return;
  if (tabId === state.examTabId) return handleExamNavigation(state, tabId, url);
  if (isPending(state, tabId)) {
    if (verdict(state, url).category === "TRANSITIONAL") return;
    return resolveNewTab(state, tabId, url);
  }
  if (helperTab(state, tabId)) return handleHelperNavigation(state, tabId, url);
  // Pre-existing background tabs are left alone (switching to them is rule 2).
}

/* ------------------------------------------------------------------ */
/* Rule 2: switching tabs                                              */
/* ------------------------------------------------------------------ */

async function handleTabActivated(state, info) {
  const { tabId, windowId } = info;
  if (tabId === state.examTabId) return;
  if (helperTab(state, tabId) || isPending(state, tabId)) return;
  if (createdTabIds.has(tabId) || closedTabIds.has(tabId)) return;
  if (newWindowIds.has(windowId)) return;
  if (state.helperWindows.includes(windowId)) return;
  const closedAt = closedInWindowAt.get(windowId);
  if (closedAt && Date.now() - closedAt < 1500) return; // Chrome activated a neighbor after our close
  if (Date.now() < suppressNewUntil) return;
  const tab = await safe(() => chrome.tabs.get(tabId));
  if (!tab) return;
  await recordViolation(state, "TAB_SWITCH", { detail: hostOf(tabUrl(tab)) });
  await focusExam(state);
}

/* ------------------------------------------------------------------ */
/* Rule 4: new windows                                                 */
/* ------------------------------------------------------------------ */

async function handleWindowCreated(state, win) {
  try {
    if (!win || win.id === state.examWindowId || state.helperWindows.includes(win.id)) return;
    if (Date.now() < suppressNewUntil) return;
    if (!(await windowExists(state.examWindowId))) return;
    let full = await retry(() => chrome.windows.get(win.id, { populate: true }));
    if (!full) return; // already gone
    if (!full.tabs || full.tabs.length === 0) {
      await sleep(300);
      full = (await retry(() => chrome.windows.get(win.id, { populate: true }))) || full;
    }
    const tabs = full.tabs || [];
    // Exam tab dragged into its own window: just follow it.
    const examTab = await safe(() => chrome.tabs.get(state.examTabId));
    if (tabs.some((t) => t.id === state.examTabId) || (examTab && examTab.windowId === win.id)) {
      state.examWindowId = win.id;
      await saveState(state);
      return;
    }
    if (tabs.length === 1) {
      const t = tabs[0];
      const url = tabUrl(t);
      const fromExam = t.openerTabId != null && (t.openerTabId === state.examTabId || helperTab(state, t.openerTabId));
      if (fromExam) {
        const v = url ? verdict(state, url) : null;
        if (!v || v.category === "TRANSITIONAL") {
          state.pendingTabs[String(t.id)] = { opener: t.openerTabId, ts: Date.now() };
          state.helperWindows.push(win.id);
          await saveState(state);
          return;
        }
        if (v.allowed) {
          addHelperTab(state, t.id);
          state.helperWindows.push(win.id);
          await saveState(state);
          return;
        }
      }
    }
    const firstUrl = tabs.length ? tabUrl(tabs[0]) : "";
    for (const t of tabs) rememberFor(closedTabIds, t.id, 5000);
    suppressFocusUntil = Date.now() + 1000;
    await retry(() => chrome.windows.remove(win.id));
    await recordViolation(state, "NEW_WINDOW", { detail: firstUrl ? hostOf(firstUrl) : "", url: firstUrl || undefined });
    await focusExam(state);
  } finally {
    setTimeout(() => newWindowIds.delete(win && win.id), 2000);
  }
}

/* ------------------------------------------------------------------ */
/* Rules 5 + 6: window focus                                           */
/* ------------------------------------------------------------------ */

function graceOf(state) {
  const g = Number(getOptions(state).graceMs);
  return Number.isFinite(g) && g >= 0 ? g : DEFAULT_OPTIONS.graceMs;
}

function scheduleGraceCheck(ms) {
  if (graceTimer) clearTimeout(graceTimer);
  graceTimer = setTimeout(() => {
    graceTimer = null;
    withActive(() => undefined); // withActive runs finalizeFocusLoss
  }, ms + 50);
}

async function startFocusLoss(state) {
  if (state.focusLostAt) return;
  state.focusLostAt = Date.now();
  state.focusLostViolationId = null;
  await saveState(state);
  scheduleGraceCheck(graceOf(state));
}

function describeAway(state) {
  const app = state.lastFrontmostApp;
  const fresh = app && state.focusLostAt && app.ts >= state.focusLostAt - 60000;
  if (!app || !fresh || !app.name) return { label: formatLabel("LEFT_BROWSER"), category: "OTHER", app: null };
  if (app.isSameBrowser) {
    return {
      label: formatLabel("LEFT_BROWSER_APP", { app: "another browser window or profile" }),
      category: "BROWSER",
      app: app.name,
    };
  }
  return {
    label: formatLabel("LEFT_BROWSER_APP", { app: app.name }),
    category: app.category || "OTHER",
    app: app.name,
  };
}

/*
 * Called on every active event and by the grace timer: if focus has been away
 * longer than graceMs (and the popup is closed), record ONE LEFT_BROWSER.
 */
async function finalizeFocusLoss(state) {
  if (!state.focusLostAt || state.focusLostViolationId) return;
  if (Date.now() - state.focusLostAt < graceOf(state)) return;
  if (popupPorts > 0) return;
  const last = await safe(() => chrome.windows.getLastFocused({}));
  if (last && last.focused) {
    // Focus came back but we missed the event (worker slept).
    if (last.id === state.examWindowId || state.helperWindows.includes(last.id)) {
      await focusReturned(state);
    } else {
      state.focusLostAt = null; // another Chrome window: rule 5 handles that
      await saveState(state);
    }
    return;
  }
  const d = describeAway(state);
  const rec = await recordViolation(state, "LEFT_BROWSER", {
    category: d.category,
    label: d.label,
    detail: d.app || "",
    app: d.app || undefined,
    notify: "force",
    message: "Return to your exam. This was recorded.",
  });
  state.focusLostViolationId = rec.id;
  await saveState(state);
  suppressFocusUntil = Date.now() + 800;
  await retry(() => chrome.windows.update(state.examWindowId, { focused: true })); // try once (retry only on drag errors)
}

/* Focus is back on the exam (or a helper) window. Fill in durationMs. */
async function focusReturned(state) {
  if (!state.focusLostAt) return;
  const away = Date.now() - state.focusLostAt;
  if (state.focusLostViolationId) {
    const v = state.violations.find((x) => x.id === state.focusLostViolationId);
    if (v) {
      v.durationMs = away;
      const patched = await reporter.patchQueuedDuration(v.id, away).catch(() => false);
      if (!patched) {
        await reporter
          .queueEvent(state, "FOCUS_RETURNED", {
            type: v.type,
            category: v.category,
            label: v.label,
            detail: v.detail,
            durationMs: away,
          })
          .catch(() => null);
      }
    }
  } else if (away >= graceOf(state) && popupPorts === 0) {
    // The worker slept through the grace timer: record it now, with the away time.
    const d = describeAway(state);
    await recordViolation(state, "LEFT_BROWSER", {
      ts: state.focusLostAt,
      category: d.category,
      label: d.label,
      detail: d.app || "",
      app: d.app || undefined,
      durationMs: away,
      notify: false,
    });
  }
  state.focusLostAt = null;
  state.focusLostViolationId = null;
  await saveState(state);
}

async function handleFocusChanged(state, windowId) {
  const NONE = chrome.windows.WINDOW_ID_NONE;
  if (windowId === NONE) {
    if (popupPorts > 0) return; // the LockIn popup took focus
    await startFocusLoss(state);
    return;
  }
  if (windowId === state.examWindowId || state.helperWindows.includes(windowId)) {
    await focusReturned(state);
    return;
  }
  // Another Chrome window.
  await focusReturned(state);
  if (newWindowIds.has(windowId)) return; // window rule is handling it
  if (Date.now() < suppressFocusUntil || Date.now() < suppressNewUntil) {
    if (Date.now() >= suppressNewUntil) await focusExam(state);
    return;
  }
  if (!(await windowExists(state.examWindowId))) return;
  await recordViolation(state, "OTHER_WINDOW", { detail: "" });
  await focusExam(state);
}

/* Popup closed: if no browser window has focus now, start a focus loss. */
async function afterPopupClosed(state) {
  if (popupPorts > 0 || state.focusLostAt) return;
  const last = await safe(() => chrome.windows.getLastFocused({}));
  if (!last || !last.focused) await startFocusLoss(state);
}

/* ------------------------------------------------------------------ */
/* Rule 8: exam window/tab closed; reopening the exam                  */
/* ------------------------------------------------------------------ */

async function openExamWindow(state) {
  const opts = getOptions(state);
  const url = state.lastAllowedExamUrl || state.config.formUrl;
  suppressFocusUntil = Date.now() + 1500;
  const win = await retry(() =>
    chrome.windows.create({ url, type: "normal", state: opts.fullscreen ? "fullscreen" : "maximized", focused: true })
  );
  if (!win) return false;
  state.examWindowId = win.id;
  state.examTabId = win.tabs && win.tabs[0] ? win.tabs[0].id : null;
  state.examFullscreen = win.state === "fullscreen" ? true : null;
  await saveState(state);
  return true;
}

async function handleWindowRemoved(state, windowId) {
  const hi = state.helperWindows.indexOf(windowId);
  if (hi >= 0) {
    state.helperWindows.splice(hi, 1);
    await saveState(state);
  }
  if (windowId !== state.examWindowId) return;
  const examTab = await safe(() => chrome.tabs.get(state.examTabId));
  if (examTab && examTab.windowId !== windowId) {
    state.examWindowId = examTab.windowId; // tab was dragged elsewhere
    await saveState(state);
    return;
  }
  await recordViolation(state, "EXAM_WINDOW_CLOSED", { detail: "window" });
  await openExamWindow(state);
}

async function handleTabRemoved(state, tabId, info) {
  let changed = false;
  const hi = state.helperTabs.indexOf(tabId);
  if (hi >= 0) {
    state.helperTabs.splice(hi, 1);
    changed = true;
  }
  if (isPending(state, tabId)) {
    delete state.pendingTabs[String(tabId)];
    changed = true;
  }
  if (tabId !== state.examTabId) {
    if (changed) await saveState(state);
    return;
  }
  if (info && info.isWindowClosing) {
    if (changed) await saveState(state);
    return; // windows.onRemoved handles it
  }
  await recordViolation(state, "EXAM_WINDOW_CLOSED", { detail: "window" });
  if (await windowExists(state.examWindowId)) {
    const tab = await retry(() =>
      chrome.tabs.create({ windowId: state.examWindowId, url: state.lastAllowedExamUrl || state.config.formUrl, active: true })
    );
    if (tab) {
      state.examTabId = tab.id;
      await saveState(state);
      await focusExam(state);
      return;
    }
  }
  await openExamWindow(state);
}

/* ------------------------------------------------------------------ */
/* Rule 12: fullscreen                                                 */
/* ------------------------------------------------------------------ */

async function handleBoundsChanged(state, win) {
  if (!win || win.id !== state.examWindowId || !getOptions(state).fullscreen) return;
  const w = await safe(() => chrome.windows.get(win.id));
  if (!w) return;
  if (w.state === "fullscreen") {
    if (state.examFullscreen !== true) {
      state.examFullscreen = true;
      await saveState(state);
    }
    return;
  }
  if (state.examFullscreen === true) {
    state.examFullscreen = false;
    await recordViolation(state, "EXITED_FULLSCREEN", { detail: w.state || "" });
  }
}

/* ------------------------------------------------------------------ */
/* Companion (rules 6, 7, 13)                                          */
/* ------------------------------------------------------------------ */

function companionStatusFor(state) {
  const s = companion.getStatus();
  if (s === COMPANION_STATUS.READY) return s;
  if (state && state.config && state.mode !== MODES.OFF && !getOptions(state).requireCompanion) {
    return COMPANION_STATUS.NOT_REQUIRED;
  }
  return s;
}

async function connectAndArm(state) {
  const family = state.browserFamily || detectBrowserFamily();
  const status = await companion.connect(family);
  if (status === COMPANION_STATUS.READY) {
    companion.arm(categoriesOf(state), family);
    if (state.companionDown) {
      state.companionDown = false;
      await saveState(state);
    }
  }
  return status;
}

/* Called on wake / heartbeat while active: reconnect if the port is gone. */
async function ensureCompanion(state) {
  if (companion.isConnected() || companion.isBusy()) return;
  const status = await connectAndArm(state);
  if (status !== COMPANION_STATUS.READY) await companionWentDown(state, status);
}

async function companionWentDown(state, status) {
  if (getOptions(state).requireCompanion && !state.companionDown) {
    state.companionDown = true;
    await recordViolation(state, "COMPANION_DISCONNECTED", { detail: status || "" });
  }
  companion.scheduleReconnect(() => withActive((s) => ensureCompanion(s)));
}

companion.setHandlers({
  onFrontmost(msg) {
    withActive(
      async (state) => {
        state.lastFrontmostApp = {
          name: msg.name || "",
          category: msg.category || null,
          isSameBrowser: !!msg.isSameBrowser,
          title: msg.title || "",
          ts: Date.now(),
        };
        await saveState(state);
      },
      { skipFocusCheck: true }
    );
  },
  onAppLaunched(msg) {
    withActive(async (state) => {
      if (!appEnforced(msg.category, categoriesOf(state))) return;
      await recordViolation(state, "APP_LAUNCHED", {
        category: msg.category,
        label: formatLabel("APP_LAUNCHED", { app: msg.name || "an app" }),
        detail: msg.name || "",
        app: msg.name || "",
        notify: "force",
      });
    });
  },
  onDisconnect(status) {
    withActive((state) => companionWentDown(state, status));
  },
});

function scheduleIdleDisconnect() {
  if (idleDisconnectTimer) clearTimeout(idleDisconnectTimer);
  idleDisconnectTimer = setTimeout(() => {
    idleDisconnectTimer = null;
    fire(async () => {
      const s = await loadState();
      if (!isActive(s)) companion.disconnect();
    });
  }, IDLE_DISCONNECT_MS);
}

/* ------------------------------------------------------------------ */
/* Messages                                                            */
/* ------------------------------------------------------------------ */

function companionProblem(status) {
  if (status === COMPANION_STATUS.NOT_INSTALLED) return "Desktop companion not installed";
  if (status === COMPANION_STATUS.WRONG_ID) return "Desktop companion is installed for a different extension ID. Reinstall it.";
  return "Desktop companion is not responding. Try again.";
}

function validateStudent(student) {
  const s = student || {};
  const out = {
    name: String(s.name || "").trim(),
    studentNo: String(s.studentNo || "").trim(),
    section: String(s.section || "").trim(),
  };
  const errors = [];
  if (!out.name) errors.push("Enter your full name.");
  if (!out.studentNo) errors.push("Enter your student number.");
  if (!out.section) errors.push("Enter your section.");
  return { student: out, errors };
}

async function onGetState() {
  const state = await loadState();
  return {
    ok: true,
    state: sanitizeState(state),
    companionStatus: companionStatusFor(state),
    lastSession: await loadLastSession(),
    pinLockedUntil: await pinLockedUntil(),
  };
}

async function onPrecheck(msg) {
  const errors = [];
  const platform = await getPlatform();
  let examName = "";
  let requireCompanion = DEFAULT_OPTIONS.requireCompanion;
  let companionStatus = companion.getStatus();
  let runningBlocked = [];
  let warning = null;

  const current = await loadState();
  if (isActive(current)) errors.push("LockIn is already running.");

  const dec = await decodeExamCode(String(msg.code || ""));
  if (!dec.ok) errors.push(dec.error || "This exam code is not valid.");
  errors.push(...validateStudent(msg.student).errors);

  if (dec.ok) {
    const cfg = dec.config;
    const opts = Object.assign({}, DEFAULT_OPTIONS, cfg.options || {});
    examName = cfg.examName || "";
    requireCompanion = !!opts.requireCompanion;
    const family = detectBrowserFamily();
    companionStatus = await companion.connect(family);
    if (companionStatus === COMPANION_STATUS.READY) {
      const res = await companion.precheck(opts.categories, family);
      if (res.ok) {
        warning = res.warning || null;
        runningBlocked = res.running
          .filter((a) => appEnforced(a.category, opts.categories))
          .map((a) => ({ name: a.name, category: a.category }));
      } else if (requireCompanion) {
        errors.push("Desktop companion did not answer. Try again.");
      }
    } else if (requireCompanion) {
      errors.push(companionProblem(companionStatus));
    }
    if (!requireCompanion && companionStatus !== COMPANION_STATUS.READY) {
      companionStatus = COMPANION_STATUS.NOT_REQUIRED;
    }
    if (runningBlocked.length) {
      errors.push("Close these first: " + runningBlocked.map((a) => a.name).join(", "));
    }
    if (!isActive(current)) scheduleIdleDisconnect();
  }

  const out = { ok: errors.length === 0, errors, companionStatus, runningBlocked, examName, requireCompanion, platform };
  if (warning) out.warning = warning;
  return out;
}

async function onArm(msg) {
  let state = await loadState();
  if (isActive(state)) return { ok: false, error: "LockIn is already running." };
  const dec = await decodeExamCode(String(msg.code || ""));
  if (!dec.ok) return { ok: false, error: dec.error || "This exam code is not valid." };
  const { student, errors } = validateStudent(msg.student);
  if (errors.length) return { ok: false, error: errors[0] };

  const config = dec.config;
  config.options = Object.assign({}, DEFAULT_OPTIONS, config.options || {});
  const opts = config.options;
  const family = detectBrowserFamily();

  const status = await companion.connect(family);
  if (opts.requireCompanion && status !== COMPANION_STATUS.READY) {
    return { ok: false, error: companionProblem(status) };
  }
  if (idleDisconnectTimer) clearTimeout(idleDisconnectTimer);
  idleDisconnectTimer = null;

  await saveStudentPrefs({ name: student.name, studentNo: student.studentNo, section: student.section, code: String(msg.code || "").trim() });

  suppressFocusUntil = Date.now() + 1500;
  const win = await retry(() =>
    chrome.windows.create({
      url: config.formUrl,
      type: "normal",
      state: opts.fullscreen ? "fullscreen" : "maximized",
      focused: true,
    })
  );
  if (!win) return { ok: false, error: "Could not open the exam window. Try again." };

  state = newSession({
    config,
    student,
    browserFamily: family,
    examWindowId: win.id,
    examTabId: win.tabs && win.tabs[0] ? win.tabs[0].id : null,
    examFullscreen: win.state === "fullscreen" ? true : null,
  });
  await saveState(state);

  if (status === COMPANION_STATUS.READY) companion.arm(opts.categories, family);
  await ensureAlarm();
  await reporter.setUninstallUrl(state);
  await reporter.queueEvent(state, "SESSION_START", {}).catch(() => null);
  await updateAction(state);
  return { ok: true };
}

/* Shared teardown for professor end and DONE. */
async function goOff() {
  companion.disconnect();
  await reporter.clearUninstallUrl();
  const off = defaultState();
  await saveState(off);
  await updateAction(off);
  await clearAlarmIfIdle();
}

async function onEndExam(msg) {
  const state = await loadState();
  if (state.mode === MODES.OFF) return { ok: false, error: "LockIn is not running." };
  const r = await checkPin(msg.pin, state.config);
  if (!r.ok) return r;
  if (isActive(state)) {
    await saveLastSession(buildLastSession(state, "professor", Date.now()));
    await reporter.queueEvent(state, "SESSION_END", { reason: "professor", detail: "professor" }).catch(() => null);
    companion.disarm();
  }
  await goOff(); // does not close the exam window
  return { ok: true };
}

async function onClearWarning(msg) {
  const state = await loadState();
  if (!isActive(state)) return { ok: false, error: "LockIn is not running." };
  const r = await checkPin(msg.pin, state.config);
  if (!r.ok) return r;
  if (state.mode === MODES.TRIGGERED) {
    state.mode = MODES.ARMED; // history and count are kept
    await saveState(state);
    await updateAction(state);
    await reporter.queueEvent(state, "WARNING_CLEARED", { detail: "professor" }).catch(() => null);
  }
  return { ok: true };
}

async function onFocusExam(sender) {
  const state = await loadState();
  if (state.mode === MODES.OFF || state.examTabId == null) return { ok: true };
  const senderTab = sender && sender.tab;
  if (senderTab && senderTab.id !== state.examTabId && isBlockedPage(senderTab.url)) {
    await closeTab(senderTab.id); // a helper tab showing the blocked page
  }
  const examTab = await safe(() => chrome.tabs.get(state.examTabId));
  if (examTab && isBlockedPage(examTab.url || examTab.pendingUrl)) {
    await retry(() => chrome.tabs.update(state.examTabId, { url: state.lastAllowedExamUrl || state.config.formUrl }));
  }
  await focusExam(state);
  return { ok: true };
}

async function onDone() {
  const state = await loadState();
  if (state.mode === MODES.SUBMITTED || state.mode === MODES.OFF) {
    if (state.mode === MODES.SUBMITTED) await goOff();
    return { ok: true };
  }
  return { ok: false, error: "The exam is still running." };
}

async function onContentEvent(msg, sender) {
  const state = await loadState();
  if (!isActive(state)) return { ok: true };
  await finalizeFocusLoss(state);
  const kind = msg.kind;
  if (kind === "PASTE") {
    await recordViolation(state, "PASTE", { detail: String(msg.detail || "") });
  } else if (kind === "CONTEXT_MENU") {
    await recordViolation(state, "CONTEXT_MENU", { detail: String(msg.detail || "") });
  } else if (kind === "FORM_SUBMITTED") {
    const tabId = sender && sender.tab && sender.tab.id;
    if (tabId != null && tabId !== state.examTabId && !helperTab(state, tabId)) return { ok: true };
    const now = Date.now();
    state.mode = MODES.SUBMITTED;
    state.submittedAt = now;
    state.focusLostAt = null;
    state.pendingTabs = {};
    await saveState(state);
    await saveLastSession(buildLastSession(state, "submitted", now));
    await reporter.queueEvent(state, "SESSION_END", { reason: "submitted", detail: String(msg.detail || "") }).catch(() => null);
    companion.disarm();
    companion.disconnect();
    await reporter.clearUninstallUrl();
    await updateAction(state);
    await clearAlarmIfIdle();
  }
  return { ok: true };
}

async function onBlockedPageOpened(msg) {
  const state = await loadState();
  if (!isActive(state)) return { ok: true };
  const url = String(msg.url || "");
  const now = Date.now();
  const seen = state.violations.some((v) => v.url === url && now - (v.lastTs || v.ts) < 10000);
  if (seen || !url) return { ok: true };
  const v = verdict(state, url);
  const category = msg.category || v.category;
  await recordViolation(state, "BLOCKED_SITE", {
    category,
    label: formatLabel("BLOCKED_SITE", { site: v.site }),
    detail: v.site,
    url,
  });
  return { ok: true };
}

function handleMessage(msg, sender) {
  const type = msg && msg.type;
  switch (type) {
    case MSG.GET_STATE:
      return onGetState();
    case MSG.PRECHECK:
      return onPrecheck(msg); // reads only; not serialized (waits on the companion)
    case MSG.ARM:
      return withLock(() => onArm(msg));
    case MSG.END_EXAM:
      return withLock(() => onEndExam(msg));
    case MSG.CLEAR_WARNING:
      return withLock(() => onClearWarning(msg));
    case MSG.FOCUS_EXAM:
      return withLock(() => onFocusExam(sender));
    case MSG.DONE:
      return withLock(() => onDone());
    case MSG.CONTENT_EVENT:
      return withLock(() => onContentEvent(msg, sender));
    case MSG.BLOCKED_PAGE_OPENED:
      return withLock(() => onBlockedPageOpened(msg));
    default:
      return Promise.resolve({ ok: false, error: "Unknown message" });
  }
}

/* ------------------------------------------------------------------ */
/* Startup / resume                                                    */
/* ------------------------------------------------------------------ */

async function boot() {
  const state = await loadState();
  await updateAction(state);
  if (isActive(state)) {
    await ensureAlarm();
    await ensureCompanion(state);
    await finalizeFocusLoss(state);
  } else if ((await reporter.outboxSize()) > 0) {
    await ensureAlarm();
  }
  reporter.flush().catch(() => {});
}

async function onBrowserStartup() {
  const state = await loadState();
  await updateAction(state);
  if (!isActive(state)) return;
  suppressNewUntil = Date.now() + 10000; // restored windows/tabs are not "new"
  state.focusLostAt = null;
  state.helperTabs = [];
  state.helperWindows = [];
  state.pendingTabs = {};
  await recordViolation(state, "BROWSER_RESTARTED", { detail: "", notify: false });
  await openExamWindow(state);
  await ensureAlarm();
  await ensureCompanion(state);
}

/* ------------------------------------------------------------------ */
/* Listener registration (synchronous, top level)                      */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!sender || sender.id !== chrome.runtime.id) return false;
  Promise.resolve()
    .then(() => handleMessage(msg, sender))
    .then((res) => sendResponse(res || { ok: true }))
    .catch((e) => {
      console.warn("[LockIn] message failed", e);
      try {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      } catch (err) {
        /* popup closed */
      }
    });
  return true;
});

chrome.runtime.onConnect.addListener((port) => {
  if (!port || port.name !== POPUP_PORT) return;
  popupPorts++;
  // The popup opening can blur the window just before this port connects:
  // drop that not-yet-recorded focus loss (afterPopupClosed re-checks later).
  withActive(
    async (state) => {
      if (state.focusLostAt && !state.focusLostViolationId) {
        state.focusLostAt = null;
        await saveState(state);
      }
    },
    { skipFocusCheck: true }
  );
  port.onDisconnect.addListener(() => {
    void chrome.runtime.lastError;
    popupPorts = Math.max(0, popupPorts - 1);
    if (popupPorts === 0) setTimeout(() => withActive(afterPopupClosed, { skipFocusCheck: true }), 400);
  });
});

chrome.runtime.onStartup.addListener(() => {
  fire(onBrowserStartup);
});

chrome.runtime.onInstalled.addListener(() => {
  fire(async () => {
    await updateAction(await loadState());
  });
});

chrome.tabs.onCreated.addListener((tab) => {
  if (tab && tab.id != null) rememberFor(createdTabIds, tab.id, 5000);
  withActive((state) => handleTabCreated(state, tab));
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo || !changeInfo.url) return;
  withActive((state) => handleNavigation(state, tabId, changeInfo.url));
});

chrome.tabs.onActivated.addListener((info) => {
  // Small delay so a matching tabs.onCreated is always handled first.
  setTimeout(() => withActive((state) => handleTabActivated(state, info)), 100);
});

chrome.tabs.onRemoved.addListener((tabId, info) => {
  withActive((state) => handleTabRemoved(state, tabId, info), { skipFocusCheck: true });
});

chrome.tabs.onReplaced.addListener((addedTabId, removedTabId) => {
  withActive(async (state) => {
    if (removedTabId === state.examTabId) {
      state.examTabId = addedTabId;
      await saveState(state);
    } else if (helperTab(state, removedTabId)) {
      state.helperTabs = state.helperTabs.filter((t) => t !== removedTabId).concat(addedTabId);
      await saveState(state);
    }
  });
});

chrome.tabs.onAttached.addListener((tabId, info) => {
  withActive(async (state) => {
    if (tabId === state.examTabId && info.newWindowId !== state.examWindowId) {
      state.examWindowId = info.newWindowId;
      await saveState(state);
    }
  });
});

chrome.windows.onCreated.addListener((win) => {
  if (win && win.id != null) newWindowIds.add(win.id);
  withActive((state) => handleWindowCreated(state, win));
  setTimeout(() => newWindowIds.delete(win && win.id), 5000);
});

chrome.windows.onFocusChanged.addListener((windowId) => {
  withActive((state) => handleFocusChanged(state, windowId), { skipFocusCheck: true });
});

chrome.windows.onRemoved.addListener((windowId) => {
  withActive((state) => handleWindowRemoved(state, windowId), { skipFocusCheck: true });
});

chrome.windows.onBoundsChanged.addListener((win) => {
  withActive((state) => handleBoundsChanged(state, win));
});

chrome.webNavigation.onBeforeNavigate.addListener((details) => {
  if (!details || details.frameId !== 0) return;
  withActive((state) => handleNavigation(state, details.tabId, details.url));
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (!alarm || alarm.name !== HEARTBEAT_ALARM) return;
  fire(async () => {
    const state = await loadState();
    if (isActive(state)) {
      await finalizeFocusLoss(state);
      await reporter.queueEvent(state, "HEARTBEAT", {}).catch(() => null);
      await ensureCompanion(state);
      await updateAction(state);
    } else {
      await reporter.flush().catch(() => {});
      await clearAlarmIfIdle();
    }
  });
});

chrome.notifications.onClicked.addListener((id) => {
  try {
    chrome.notifications.clear(id, () => void chrome.runtime.lastError);
  } catch (e) {
    /* ignore */
  }
  withActive((state) => focusExam(state), { skipFocusCheck: true });
});

// Every time the worker wakes: redraw the icon, resume companion + heartbeat if locked in.
fire(boot);
