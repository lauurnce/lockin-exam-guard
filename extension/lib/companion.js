/*
 * companion.js
 * Native messaging client for the LockIn desktop companion
 * ("com.lockin.companion", protocol in SPEC 10.1).
 *
 * - connect(browserFamily): connectNative + `hello`, waits up to 3s for
 *   `ready`. Resolves with a COMPANION_STATUS value.
 * - precheck(categories, browserFamily): request/response with a timeout.
 * - arm()/disarm()/disconnect().
 * - Pings every 15s while connected.
 * - onDisconnect maps lastError to not_installed / wrong_extension_id /
 *   disconnected and calls the background's onDisconnect handler (unless we
 *   closed the port ourselves).
 * - scheduleReconnect(fn): backoff 1s, 2s, 4s, 4s, 4s (max 5 tries); the
 *   counter resets once the companion answers `ready` again.
 * Host events `frontmost` and `app_launched` are passed to the handlers.
 */

import { NATIVE_HOST, COMPANION_STATUS } from "./constants.js";

const READY_TIMEOUT_MS = 3000;
const PRECHECK_TIMEOUT_MS = 5000;
const PING_MS = 15000;
const BACKOFF_MS = [1000, 2000, 4000, 4000, 4000];

let port = null;
let status = COMPANION_STATUS.IDLE;
let hostInfo = null; // { version, platform } from `ready`
let connecting = null; // Promise while waiting for `ready`
let readyResolve = null;
let pendingPrecheck = null; // { resolve, timer }
let pingTimer = null;
let reconnectTimer = null;
let reconnectAttempt = 0;
let handlers = {};

export function setHandlers(h) {
  handlers = h || {};
}

export function getStatus() {
  return status;
}

export function getHostInfo() {
  return hostInfo;
}

export function isConnected() {
  return !!port && status === COMPANION_STATUS.READY;
}

export function isBusy() {
  return !!connecting || !!reconnectTimer;
}

export function statusFromError(msg) {
  const m = String(msg || "").toLowerCase();
  if (m.includes("not found")) return COMPANION_STATUS.NOT_INSTALLED;
  if (m.includes("forbidden")) return COMPANION_STATUS.WRONG_ID;
  return COMPANION_STATUS.DISCONNECTED;
}

function post(msg) {
  if (!port) return false;
  try {
    port.postMessage(msg);
    return true;
  } catch (e) {
    console.warn("[LockIn] companion post failed", e);
    return false;
  }
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => post({ type: "ping" }), PING_MS);
}

function stopPing() {
  if (pingTimer) clearInterval(pingTimer);
  pingTimer = null;
}

function settleReady(s) {
  if (readyResolve) {
    const r = readyResolve;
    readyResolve = null;
    r(s);
  }
}

function settlePrecheck(result) {
  if (pendingPrecheck) {
    const p = pendingPrecheck;
    pendingPrecheck = null;
    clearTimeout(p.timer);
    p.resolve(result);
  }
}

function onPortMessage(myPort, msg) {
  if (myPort !== port || !msg || typeof msg !== "object") return;
  try {
    switch (msg.type) {
      case "ready":
        status = COMPANION_STATUS.READY;
        hostInfo = { version: msg.version || "", platform: msg.platform || "" };
        reconnectAttempt = 0;
        startPing();
        settleReady(status);
        break;
      case "pong":
        break;
      case "precheck_result":
        settlePrecheck({ ok: true, running: Array.isArray(msg.running) ? msg.running : [], warning: msg.warning || null });
        break;
      case "frontmost":
        if (handlers.onFrontmost) handlers.onFrontmost(msg);
        break;
      case "app_launched":
        if (handlers.onAppLaunched) handlers.onAppLaunched(msg);
        break;
      default:
        break;
    }
  } catch (e) {
    console.warn("[LockIn] companion message handler failed", e);
  }
}

function onPortDisconnect(myPort) {
  // lastError must be read inside the listener.
  let err = "";
  try {
    err = (chrome.runtime.lastError && chrome.runtime.lastError.message) || "";
  } catch (e) {
    err = "";
  }
  if (myPort !== port) return;
  port = null;
  stopPing();
  status = statusFromError(err);
  settleReady(status);
  settlePrecheck({ ok: false, error: status });
  try {
    if (handlers.onDisconnect) handlers.onDisconnect(status, err);
  } catch (e) {
    console.warn("[LockIn] companion onDisconnect handler failed", e);
  }
}

/* Connects (or reuses the connection). Resolves with the status. */
export function connect(browserFamily) {
  if (port && status === COMPANION_STATUS.READY) return Promise.resolve(status);
  if (connecting) return connecting;
  connecting = new Promise((resolve) => {
    let timer = null;
    readyResolve = (s) => {
      clearTimeout(timer);
      connecting = null;
      resolve(s);
    };
    let myPort;
    try {
      myPort = chrome.runtime.connectNative(NATIVE_HOST);
    } catch (e) {
      port = null;
      status = statusFromError(e && e.message);
      settleReady(status);
      return;
    }
    port = myPort;
    try {
      myPort.onMessage.addListener((msg) => onPortMessage(myPort, msg));
      myPort.onDisconnect.addListener(() => onPortDisconnect(myPort));
    } catch (e) {
      console.warn("[LockIn] companion listener setup failed", e);
    }
    timer = setTimeout(() => {
      if (status !== COMPANION_STATUS.READY && port === myPort) {
        port = null;
        stopPing();
        try {
          myPort.disconnect();
        } catch (e) {
          /* ignore */
        }
        status = COMPANION_STATUS.DISCONNECTED;
        settleReady(status);
      }
    }, READY_TIMEOUT_MS);
    post({ type: "hello", browserFamily: browserFamily || "Chromium" });
  });
  return connecting;
}

/* Resolves { ok:true, running:[...] } or { ok:false, error }. */
export function precheck(categories, browserFamily) {
  if (!isConnected()) return Promise.resolve({ ok: false, error: status });
  settlePrecheck({ ok: false, error: "superseded" });
  return new Promise((resolve) => {
    const timer = setTimeout(() => settlePrecheck({ ok: false, error: "timeout" }), PRECHECK_TIMEOUT_MS);
    pendingPrecheck = { resolve, timer };
    if (!post({ type: "precheck", categories: categories || [], browserFamily: browserFamily || "Chromium" })) {
      settlePrecheck({ ok: false, error: "send_failed" });
    }
  });
}

export function arm(categories, browserFamily) {
  return post({ type: "arm", categories: categories || [], browserFamily: browserFamily || "Chromium" });
}

export function disarm() {
  return post({ type: "disarm" });
}

/* Intentional close: no onDisconnect callback, status back to idle. */
export function disconnect() {
  cancelReconnect();
  stopPing();
  const p = port;
  port = null;
  status = COMPANION_STATUS.IDLE;
  settleReady(status);
  settlePrecheck({ ok: false, error: "disconnected" });
  if (p) {
    try {
      p.disconnect();
    } catch (e) {
      /* ignore */
    }
  }
}

/* Schedules fn() with backoff. Returns false when the 5 tries are used up. */
export function scheduleReconnect(fn) {
  if (reconnectTimer) return true;
  if (reconnectAttempt >= BACKOFF_MS.length) return false;
  const delay = BACKOFF_MS[reconnectAttempt++];
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    try {
      Promise.resolve(fn()).catch((e) => console.warn("[LockIn] reconnect failed", e));
    } catch (e) {
      console.warn("[LockIn] reconnect failed", e);
    }
  }, delay);
  return true;
}

export function cancelReconnect() {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
  reconnectAttempt = 0;
}
