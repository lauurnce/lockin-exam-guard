/*
 * reporter.js
 * Sends session events to the professor's Google Apps Script web app.
 *
 * - queueEvent(state, event, info): builds the payload and appends it to the
 *   `lockin_outbox` in chrome.storage.local, then flushes in the background.
 * - flush(): POSTs each queued event (text/plain JSON, follow redirects).
 *   An event is removed only on a 2xx answer; events older than 24h are
 *   dropped. A network failure stops the flush until the next try.
 * - setUninstallUrl()/clearUninstallUrl(): the UNINSTALLED ping (SPEC 6.9).
 * If the exam has no webhookUrl, nothing is queued and no network call is made.
 * Events: SESSION_START, HEARTBEAT, VIOLATION, WARNING, WARNING_CLEARED,
 * SESSION_END, plus FOCUS_RETURNED (away time for a LEFT_BROWSER already sent).
 */

import { STORAGE_KEYS, VERSION, OUTBOX_MAX_AGE_MS } from "./constants.js";

const OUTBOX_MAX_ITEMS = 1000;

/* ---------- tiny mutex so outbox read-modify-write never interleaves ---------- */
let outboxChain = Promise.resolve();
function withOutbox(fn) {
  const run = outboxChain.then(fn);
  outboxChain = run.catch(() => {});
  return run;
}

function area() {
  return globalThis.chrome && chrome.storage && chrome.storage.local;
}

async function readOutbox() {
  try {
    const a = area();
    if (!a) return [];
    const got = await a.get(STORAGE_KEYS.OUTBOX);
    const list = got && got[STORAGE_KEYS.OUTBOX];
    return Array.isArray(list) ? list : [];
  } catch (e) {
    return [];
  }
}

async function writeOutbox(list) {
  try {
    const a = area();
    if (a) await a.set({ [STORAGE_KEYS.OUTBOX]: list });
  } catch (e) {
    console.warn("[LockIn] writeOutbox failed", e);
  }
}

export function stateLabel(mode, event, reason) {
  if (event === "SESSION_END") return reason === "submitted" ? "SUBMITTED" : "ENDED";
  return String(mode || "off").toUpperCase();
}

export function buildPayload(state, event, info = {}) {
  const cfg = (state && state.config) || {};
  const st = (state && state.student) || {};
  return {
    secret: cfg.secret || "",
    examId: cfg.examId || "",
    examName: cfg.examName || "",
    student: { name: st.name || "", studentNo: st.studentNo || "", section: st.section || "" },
    event,
    type: info.type || "",
    category: info.category || "",
    label: info.label || "",
    detail: info.detail || "",
    durationMs: info.durationMs == null ? null : info.durationMs,
    violationCount: (state && state.violationCount) || 0,
    state: stateLabel(state && state.mode, event, info.reason),
    clientTs: info.ts || Date.now(),
    version: VERSION,
  };
}

export function pruneOutbox(list, now) {
  const t = now || Date.now();
  const fresh = list.filter((e) => e && e.url && t - (e.createdAt || 0) <= OUTBOX_MAX_AGE_MS);
  return fresh.length > OUTBOX_MAX_ITEMS ? fresh.slice(-OUTBOX_MAX_ITEMS) : fresh;
}

/* Queue an event. Returns the outbox entry id, or null when there is no webhook. */
export async function queueEvent(state, event, info = {}) {
  const url = state && state.config && state.config.webhookUrl;
  if (!url) return null;
  const entry = {
    id: Date.now().toString(36) + Math.random().toString(36).slice(2, 8),
    createdAt: Date.now(),
    url,
    violationId: info.violationId || null,
    payload: buildPayload(state, event, info),
  };
  await withOutbox(async () => {
    const list = pruneOutbox(await readOutbox());
    list.push(entry);
    await writeOutbox(list);
  });
  flush().catch(() => {});
  return entry.id;
}

/*
 * If the VIOLATION event for `violationId` has not been sent yet, write the
 * away time into it. Returns true when patched (then no extra event is needed).
 */
export async function patchQueuedDuration(violationId, durationMs) {
  if (!violationId) return false;
  return withOutbox(async () => {
    const list = await readOutbox();
    const hit = list.find((e) => e.violationId === violationId && e.payload && e.payload.event === "VIOLATION");
    if (!hit || inFlight.has(hit.id)) return false;
    hit.payload.durationMs = durationMs;
    await writeOutbox(list);
    return true;
  });
}

export async function outboxSize() {
  return (await readOutbox()).length;
}

let flushing = null;
const inFlight = new Set();

export function flush() {
  if (flushing) return flushing;
  flushing = doFlush().finally(() => {
    flushing = null;
  });
  return flushing;
}

async function doFlush() {
  const pending = await withOutbox(async () => {
    const list = await readOutbox();
    const pruned = pruneOutbox(list);
    if (pruned.length !== list.length) await writeOutbox(pruned);
    return pruned;
  });
  for (const entry of pending) {
    let ok = false;
    inFlight.add(entry.id);
    try {
      const res = await fetch(entry.url, {
        method: "POST",
        headers: { "Content-Type": "text/plain;charset=utf-8" },
        body: JSON.stringify(entry.payload),
        redirect: "follow",
      });
      ok = res.status >= 200 && res.status < 300;
    } catch (e) {
      inFlight.delete(entry.id);
      break; // offline or blocked: try again on the next event/heartbeat
    }
    inFlight.delete(entry.id);
    if (ok) {
      await withOutbox(async () => {
        const list = await readOutbox();
        await writeOutbox(list.filter((e) => e.id !== entry.id));
      });
    }
  }
}

export function buildUninstallUrl(state) {
  const cfg = (state && state.config) || {};
  if (!cfg.webhookUrl) return "";
  const st = (state && state.student) || {};
  const sep = cfg.webhookUrl.includes("?") ? "&" : "?";
  const base =
    cfg.webhookUrl + sep +
    "event=UNINSTALLED" +
    "&examId=" + encodeURIComponent(cfg.examId || "") +
    "&studentNo=" + encodeURIComponent(st.studentNo || "");
  const full = base + "&secret=" + encodeURIComponent(cfg.secret || "");
  if (full.length <= 1023) return full;
  if (base.length <= 1023) return base;
  return "";
}

export async function setUninstallUrl(state) {
  try {
    await chrome.runtime.setUninstallURL(buildUninstallUrl(state));
  } catch (e) {
    console.warn("[LockIn] setUninstallURL failed", e);
  }
}

export async function clearUninstallUrl() {
  try {
    await chrome.runtime.setUninstallURL("");
  } catch (e) {
    console.warn("[LockIn] clearUninstallURL failed", e);
  }
}
