/*
 * state.js
 * The LockIn state machine and its chrome.storage.local persistence.
 *
 * - loadState()/saveState(): read and write `lockin_state`. Every save also
 *   writes `lockin_public`, the sanitized copy the in-page pill reads.
 * - sanitizeState(): the copy returned by GET_STATE (no PIN hash, no secret).
 * - applyViolation(): pure de-duplication + counting for the violation
 *   pipeline (same type + detail within DEDUPE_MS bumps `count`).
 * - newSession()/buildLastSession(): mode transition helpers.
 * - checkPin(): PIN guard (5 wrong tries lock PIN entry for 30s).
 * No listeners live here; background.js drives everything.
 */

import {
  STORAGE_KEYS,
  MODES,
  WARNING_TYPES,
  DEDUPE_MS,
  PIN_MAX_FAILURES,
  PIN_LOCK_MS,
  DEFAULT_OPTIONS,
} from "./constants.js";
import { verifyPin } from "./examcode.js";

const MAX_VIOLATIONS = 500;

export function defaultState() {
  return {
    mode: MODES.OFF,
    config: null,
    student: null,
    examWindowId: null,
    examTabId: null,
    startedAt: null,
    submittedAt: null,
    violations: [],
    violationCount: 0,
    warningCount: 0,
    focusLostAt: null,
    focusLostViolationId: null,
    lastFrontmostApp: null,
    browserFamily: null,
    lastAllowedExamUrl: null,
    examFullscreen: null,
    helperTabs: [],
    helperWindows: [],
    pendingTabs: {},
    companionDown: false,
    notice: null,
    lastWarning: null,
  };
}

function storage() {
  return globalThis.chrome && chrome.storage && chrome.storage.local;
}

export async function loadState() {
  try {
    const area = storage();
    if (!area) return defaultState();
    const got = await area.get(STORAGE_KEYS.STATE);
    const raw = got && got[STORAGE_KEYS.STATE];
    if (!raw || typeof raw !== "object") return defaultState();
    const s = Object.assign(defaultState(), raw);
    if (!Array.isArray(s.violations)) s.violations = [];
    if (!Array.isArray(s.helperTabs)) s.helperTabs = [];
    if (!Array.isArray(s.helperWindows)) s.helperWindows = [];
    if (!s.pendingTabs || typeof s.pendingTabs !== "object") s.pendingTabs = {};
    return s;
  } catch (e) {
    console.warn("[LockIn] loadState failed", e);
    return defaultState();
  }
}

export async function saveState(state) {
  try {
    if (state.violations && state.violations.length > MAX_VIOLATIONS) {
      state.violations = state.violations.slice(-MAX_VIOLATIONS);
    }
    const area = storage();
    if (!area) return;
    await area.set({
      [STORAGE_KEYS.STATE]: state,
      [STORAGE_KEYS.PUBLIC]: buildPublic(state),
    });
  } catch (e) {
    console.warn("[LockIn] saveState failed", e);
  }
}

export function isActive(state) {
  return !!state && (state.mode === MODES.ARMED || state.mode === MODES.TRIGGERED);
}

export function getOptions(state) {
  const opts = (state && state.config && state.config.options) || {};
  return Object.assign({}, DEFAULT_OPTIONS, opts);
}

/* Last real (non-warning) violation, for the pill's toast. */
function lastRealViolation(state) {
  const list = state.violations || [];
  for (let i = list.length - 1; i >= 0; i--) {
    if (!list[i].warning) return list[i];
  }
  return null;
}

export function buildPublic(state) {
  const s = state || defaultState();
  const opts = getOptions(s);
  const last = lastRealViolation(s);
  return {
    mode: s.mode || MODES.OFF,
    examName: (s.config && s.config.examName) || "",
    startedAt: s.startedAt || null,
    submittedAt: s.submittedAt || null,
    violationCount: s.violationCount || 0,
    warningCount: s.warningCount || 0,
    lastViolation: last ? { label: last.label, ts: last.ts } : null,
    lastWarning: s.lastWarning || null,
    blockPaste: s.mode === MODES.OFF ? false : !!opts.blockPaste,
    blockContextMenu: s.mode === MODES.OFF ? false : !!opts.blockContextMenu,
    notice: s.notice || null,
  };
}

/* GET_STATE copy: drop pinHash/pinSalt/pinIter/secret and internal bookkeeping. */
export function sanitizeState(state) {
  const s = JSON.parse(JSON.stringify(state || defaultState()));
  if (!s.mode) s.mode = MODES.OFF;
  if (s.config) {
    delete s.config.pinHash;
    delete s.config.pinSalt;
    delete s.config.pinIter;
    delete s.config.secret;
  }
  delete s.pendingTabs;
  return s;
}

export function makeId() {
  return Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

/*
 * Pure part of the violation pipeline (SPEC 6.6 steps 2-3).
 * Mutates `state`. Returns { record, deduped }.
 */
export function applyViolation(state, rec, now) {
  const t = now || rec.ts || Date.now();
  const list = state.violations || (state.violations = []);
  for (let i = list.length - 1; i >= 0; i--) {
    const prev = list[i];
    if (prev.type !== rec.type) continue;
    const lastTs = prev.lastTs || prev.ts;
    if ((prev.detail || "") === (rec.detail || "") && t - lastTs < DEDUPE_MS) {
      prev.count = (prev.count || 1) + 1;
      prev.lastTs = t;
      return { record: prev, deduped: true };
    }
    break; // only compare with the latest record of the same type
  }
  const record = Object.assign({ count: 1 }, rec);
  const warning = WARNING_TYPES.includes(record.type);
  if (warning) record.warning = true;
  list.push(record);
  if (warning) {
    state.warningCount = (state.warningCount || 0) + 1;
    state.lastWarning = { label: record.label, ts: record.ts };
  } else {
    state.violationCount = (state.violationCount || 0) + 1;
    if (isActive(state)) state.mode = MODES.TRIGGERED;
  }
  return { record, deduped: false };
}

export function newSession({ config, student, browserFamily, examWindowId, examTabId, examFullscreen }) {
  const s = defaultState();
  s.mode = MODES.ARMED;
  s.config = config;
  s.student = student;
  s.browserFamily = browserFamily;
  s.examWindowId = examWindowId;
  s.examTabId = examTabId;
  s.startedAt = Date.now();
  s.lastAllowedExamUrl = config.formUrl;
  s.examFullscreen = examFullscreen;
  return s;
}

export function buildLastSession(state, reason, endedAt) {
  return {
    examName: (state.config && state.config.examName) || "",
    startedAt: state.startedAt || null,
    endedAt: endedAt || Date.now(),
    violationCount: state.violationCount || 0,
    warningCount: state.warningCount || 0,
    reason,
  };
}

export async function saveLastSession(summary) {
  try {
    const area = storage();
    if (area) await area.set({ [STORAGE_KEYS.LAST_SESSION]: summary });
  } catch (e) {
    console.warn("[LockIn] saveLastSession failed", e);
  }
}

export async function loadLastSession() {
  try {
    const area = storage();
    if (!area) return null;
    const got = await area.get(STORAGE_KEYS.LAST_SESSION);
    return (got && got[STORAGE_KEYS.LAST_SESSION]) || null;
  } catch (e) {
    return null;
  }
}

export async function saveStudentPrefs(prefs) {
  try {
    const area = storage();
    if (area) await area.set({ [STORAGE_KEYS.STUDENT_PREFS]: prefs });
  } catch (e) {
    console.warn("[LockIn] saveStudentPrefs failed", e);
  }
}

/* ---------- PIN guard ---------- */

export async function loadPinGuard() {
  try {
    const area = storage();
    if (!area) return { failures: 0, lockedUntil: 0 };
    const got = await area.get(STORAGE_KEYS.PIN_GUARD);
    const g = (got && got[STORAGE_KEYS.PIN_GUARD]) || {};
    return { failures: g.failures || 0, lockedUntil: g.lockedUntil || 0 };
  } catch (e) {
    return { failures: 0, lockedUntil: 0 };
  }
}

async function savePinGuard(guard) {
  try {
    const area = storage();
    if (area) await area.set({ [STORAGE_KEYS.PIN_GUARD]: guard });
  } catch (e) {
    console.warn("[LockIn] savePinGuard failed", e);
  }
}

export async function pinLockedUntil() {
  const g = await loadPinGuard();
  return g.lockedUntil > Date.now() ? g.lockedUntil : 0;
}

/* Returns { ok:true } or { ok:false, error, lockedUntil? }. */
export async function checkPin(pin, config) {
  const now = Date.now();
  const guard = await loadPinGuard();
  if (guard.lockedUntil > now) {
    const secs = Math.ceil((guard.lockedUntil - now) / 1000);
    return { ok: false, error: `Too many wrong tries. Wait ${secs}s.`, lockedUntil: guard.lockedUntil };
  }
  let good = false;
  try {
    good = !!config && (await verifyPin(String(pin == null ? "" : pin), config));
  } catch (e) {
    good = false;
  }
  if (good) {
    await savePinGuard({ failures: 0, lockedUntil: 0 });
    return { ok: true };
  }
  const failures = guard.failures + 1;
  if (failures >= PIN_MAX_FAILURES) {
    const lockedUntil = now + PIN_LOCK_MS;
    await savePinGuard({ failures: 0, lockedUntil });
    return { ok: false, error: "Wrong PIN", lockedUntil };
  }
  await savePinGuard({ failures, lockedUntil: 0 });
  return { ok: false, error: "Wrong PIN" };
}
