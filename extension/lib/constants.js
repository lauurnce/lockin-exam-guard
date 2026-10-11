/*
 * constants.js
 * Shared constants for every part of the LockIn extension: version, colors,
 * storage keys, modes, violation types, human-readable labels, categories,
 * defaults and message names. Pure data plus one tiny formatting helper.
 * Safe to import from the service worker, extension pages and node tests.
 */

export const VERSION = "1.0.0";
export const CODE_PREFIX = "LOCKIN1";
export const NATIVE_HOST = "com.lockin.companion";
export const POPUP_PORT = "lockin-popup";
export const HEARTBEAT_ALARM = "lockin-heartbeat";

export const COLORS = {
  bg: "#F4F4F5",
  surface: "#FFFFFF",
  text: "#18181B",
  muted: "#71717A",
  border: "#E4E4E7",
  gray: "#A1A1AA",
  green: "#16A34A",
  greenSoft: "#DCFCE7",
  red: "#DC2626",
  redSoft: "#FEE2E2",
  iconOutline: "#3F3F46",
};

export const STORAGE_KEYS = {
  STATE: "lockin_state",
  PUBLIC: "lockin_public",
  OUTBOX: "lockin_outbox",
  LAST_SESSION: "lockin_last_session",
  STUDENT_PREFS: "lockin_student_prefs", // { name, studentNo, section, code } remembered by the popup
  PIN_GUARD: "lockin_pin_guard", // { failures, lockedUntil }
};

export const MODES = {
  OFF: "off",
  ARMED: "armed",
  TRIGGERED: "triggered",
  SUBMITTED: "submitted",
};

export const MODE_COLORS = {
  off: { main: COLORS.gray, soft: COLORS.bg },
  armed: { main: COLORS.green, soft: COLORS.greenSoft },
  triggered: { main: COLORS.red, soft: COLORS.redSoft },
  submitted: { main: COLORS.gray, soft: COLORS.bg },
};

export const VIOLATION_TYPES = {
  NEW_TAB: "NEW_TAB",
  TAB_SWITCH: "TAB_SWITCH",
  BLOCKED_SITE: "BLOCKED_SITE",
  NEW_WINDOW: "NEW_WINDOW",
  OTHER_WINDOW: "OTHER_WINDOW",
  LEFT_BROWSER: "LEFT_BROWSER",
  APP_LAUNCHED: "APP_LAUNCHED",
  EXAM_WINDOW_CLOSED: "EXAM_WINDOW_CLOSED",
  PASTE: "PASTE",
  CONTEXT_MENU: "CONTEXT_MENU",
  EXITED_FULLSCREEN: "EXITED_FULLSCREEN",
  COMPANION_DISCONNECTED: "COMPANION_DISCONNECTED",
  BROWSER_RESTARTED: "BROWSER_RESTARTED",
};

// Types that are logged and toasted but do NOT turn the state red.
export const WARNING_TYPES = ["EXITED_FULLSCREEN"];

// Labels may contain {site} or {app}; fill them with formatLabel().
export const LABELS = {
  NEW_TAB: "Opened a new tab",
  TAB_SWITCH: "Switched to another tab",
  BLOCKED_SITE: "Tried to open {site}",
  NEW_WINDOW: "Opened a new window",
  OTHER_WINDOW: "Switched to another browser window",
  LEFT_BROWSER: "Left the exam window",
  LEFT_BROWSER_APP: "Left the exam → {app}",
  APP_LAUNCHED: "Opened {app}",
  EXAM_WINDOW_CLOSED: "Closed the exam window",
  PASTE: "Pasted text into the form",
  CONTEXT_MENU: "Right-clicked in the form",
  EXITED_FULLSCREEN: "Exited fullscreen",
  COMPANION_DISCONNECTED: "Desktop companion stopped",
  BROWSER_RESTARTED: "Browser restarted during the exam",
};

// URL categories (rules.js) and app categories (companion).
export const CATEGORIES = [
  "AI", "SEARCH", "HOMEWORK", "DOCS", "NOTES", "PDF",
  "BROWSER", "COMMUNICATION", "REMOTE",
];

export const CATEGORY_LABELS = {
  AI: "AI tool",
  SEARCH: "Search engine",
  HOMEWORK: "Homework help site",
  DOCS: "Documents",
  NOTES: "Notes",
  PDF: "PDF",
  BROWSER: "Another browser",
  COMMUNICATION: "Messaging / social",
  REMOTE: "Remote access",
  WORD: "Word processor",
  SETTINGS: "Browser settings",
  LOCAL_FILE: "Local file",
  OWN_OPTIONS: "LockIn setup",
  OTHER: "Other site",
};

export const DEFAULT_OPTIONS = {
  requireCompanion: true,
  fullscreen: true,
  blockPaste: true,
  blockContextMenu: false,
  graceMs: 1500,
  categories: CATEGORIES.slice(),
};

export const PIN_ITERATIONS = 150000;
export const PIN_MAX_FAILURES = 5;
export const PIN_LOCK_MS = 30000;
export const DEDUPE_MS = 3000;
export const OUTBOX_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const FORM_ID_REGEX = /\/forms\/(?:u\/\d+\/)?d\/(?:e\/)?([A-Za-z0-9_-]{10,})/;

// chrome.runtime.onMessage message types.
export const MSG = {
  GET_STATE: "GET_STATE",
  PRECHECK: "PRECHECK",
  ARM: "ARM",
  END_EXAM: "END_EXAM",
  CLEAR_WARNING: "CLEAR_WARNING",
  FOCUS_EXAM: "FOCUS_EXAM",
  DONE: "DONE",
  CONTENT_EVENT: "CONTENT_EVENT",
  BLOCKED_PAGE_OPENED: "BLOCKED_PAGE_OPENED",
};

export const COMPANION_STATUS = {
  READY: "ready",
  NOT_INSTALLED: "not_installed",
  WRONG_ID: "wrong_extension_id",
  DISCONNECTED: "disconnected",
  NOT_REQUIRED: "not_required",
  IDLE: "idle", // not connected because LockIn is off (popup shows gray)
};

export const INSTALL_HINTS = {
  mac: "bash companion/install_macos.sh",
  win: "powershell -ExecutionPolicy Bypass -File companion\\install_windows.ps1",
  linux: "Linux: see README (best effort)",
};

export function formatLabel(key, vars) {
  const tpl = LABELS[key] || key;
  return tpl.replace(/\{(\w+)\}/g, (_, k) => (vars && vars[k] != null ? String(vars[k]) : k));
}
