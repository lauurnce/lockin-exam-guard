/*
 * popup.js
 * Logic for the LockIn toolbar popup (ES module).
 * - Opens the "lockin-popup" port so the background ignores focus loss while
 *   the popup is open.
 * - Asks the background for GET_STATE on load and again whenever
 *   lockin_state / lockin_public / lockin_last_session change.
 * - Off: remembers name / student no. / section / code (lockin_student_prefs),
 *   runs PRECHECK, shows problems (invalid code, missing companion with the
 *   OS-specific install command, apps to close), then turns into "Lock in" (ARM).
 * - Armed / triggered: live elapsed timer, latest violations, Go to exam,
 *   Clear warning and End exam behind the professor PIN (with lockout).
 * - Submitted: summary and Done.
 */

import {
  VERSION, MSG, MODES, STORAGE_KEYS, POPUP_PORT, COMPANION_STATUS, INSTALL_HINTS,
} from "../lib/constants.js";

const $ = (id) => document.getElementById(id);

const ui = {
  body: document.body,
  version: $("version"),
  stateTitle: $("stateTitle"),
  stateSub: $("stateSub"),
  viewOff: $("viewOff"),
  viewActive: $("viewActive"),
  viewSubmitted: $("viewSubmitted"),
  offForm: $("offForm"),
  code: $("code"),
  name: $("name"),
  studentNo: $("studentNo"),
  section: $("section"),
  companionDot: $("companionDot"),
  companionText: $("companionText"),
  errorBox: $("errorBox"),
  errorList: $("errorList"),
  installBox: $("installBox"),
  installTitle: $("installTitle"),
  installCmd: $("installCmd"),
  copyInstall: $("copyInstall"),
  appsBox: $("appsBox"),
  appsList: $("appsList"),
  readyBox: $("readyBox"),
  readyExam: $("readyExam"),
  primaryOff: $("primaryOff"),
  lastSession: $("lastSession"),
  actExam: $("actExam"),
  actStudent: $("actStudent"),
  actElapsed: $("actElapsed"),
  actCount: $("actCount"),
  violationLog: $("violationLog"),
  goExam: $("goExam"),
  clearBtn: $("clearBtn"),
  endBtn: $("endBtn"),
  pinForm: $("pinForm"),
  pinLabel: $("pinLabel"),
  pin: $("pin"),
  pinError: $("pinError"),
  pinCancel: $("pinCancel"),
  pinSubmit: $("pinSubmit"),
  subExam: $("subExam"),
  subTime: $("subTime"),
  subCount: $("subCount"),
  doneBtn: $("doneBtn"),
  openSetup: $("openSetup"),
  toggleCollect: $("toggleCollect"),
  collectBox: $("collectBox"),
};

let current = null;          // last GET_STATE response
let publicState = null;      // lockin_public (for submittedAt)
let precheckPassed = false;  // primary button is "Lock in" when true
let busy = false;
let pinAction = null;        // "end" | "clear" | null
let pinLockedUntil = 0;
let tickTimer = null;

/* ---------- helpers ---------- */

async function send(msg) {
  try {
    const res = await chrome.runtime.sendMessage(msg);
    return res || { ok: false, error: "No answer from LockIn. Try again." };
  } catch (err) {
    return { ok: false, error: "LockIn is restarting. Close and reopen this popup." };
  }
}

function formatElapsed(ms) {
  if (!Number.isFinite(ms) || ms < 0) ms = 0;
  const s = Math.floor(ms / 1000);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, "0");
  return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${sec}` : `${m}:${sec}`;
}

function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

function formatTime(ts) {
  if (!ts) return "";
  return new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function studentFields() {
  return {
    name: ui.name.value.trim(),
    studentNo: ui.studentNo.value.trim(),
    section: ui.section.value.trim(),
  };
}

/* ---------- prefs ---------- */

async function loadPrefs() {
  try {
    const got = await chrome.storage.local.get(STORAGE_KEYS.STUDENT_PREFS);
    const p = got[STORAGE_KEYS.STUDENT_PREFS] || {};
    if (p.code) ui.code.value = p.code;
    if (p.name) ui.name.value = p.name;
    if (p.studentNo) ui.studentNo.value = p.studentNo;
    if (p.section) ui.section.value = p.section;
  } catch (_) { /* storage unavailable: start empty */ }
}

let prefsTimer = null;
function savePrefsSoon() {
  clearTimeout(prefsTimer);
  prefsTimer = setTimeout(savePrefs, 250);
}
async function savePrefs() {
  try {
    await chrome.storage.local.set({
      [STORAGE_KEYS.STUDENT_PREFS]: { ...studentFields(), code: ui.code.value.trim() },
    });
  } catch (_) { /* ignore */ }
}

/* ---------- companion line ---------- */

const COMPANION_TEXT = {
  [COMPANION_STATUS.READY]: ["Ready", "ok"],
  [COMPANION_STATUS.NOT_INSTALLED]: ["Not installed", "bad"],
  [COMPANION_STATUS.WRONG_ID]: ["Installed for a different extension ID", "bad"],
  [COMPANION_STATUS.DISCONNECTED]: ["Disconnected", "bad"],
  [COMPANION_STATUS.NOT_REQUIRED]: ["Not required for this exam", ""],
  [COMPANION_STATUS.IDLE]: ["Checked when you lock in", ""],
};

function renderCompanion(status) {
  const [text, cls] = COMPANION_TEXT[status] || COMPANION_TEXT[COMPANION_STATUS.IDLE];
  ui.companionText.textContent = text;
  ui.companionDot.className = "dot" + (cls ? " " + cls : "");
}

/* ---------- precheck results ---------- */

function clearPrecheck() {
  precheckPassed = false;
  ui.errorBox.hidden = true;
  ui.installBox.hidden = true;
  ui.appsBox.hidden = true;
  ui.readyBox.hidden = true;
  for (const el of [ui.code, ui.name, ui.studentNo, ui.section]) el.removeAttribute("aria-invalid");
  ui.primaryOff.textContent = "Check and lock in";
  ui.primaryOff.classList.remove("ready");
}

function guessPlatform() {
  const p = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || "";
  if (/win/i.test(p)) return "win";
  if (/mac/i.test(p)) return "mac";
  return "linux";
}

function showPrecheck(res) {
  clearPrecheck();
  renderCompanion(res.companionStatus);

  const companionBad = res.requireCompanion !== false && [
    COMPANION_STATUS.NOT_INSTALLED, COMPANION_STATUS.WRONG_ID, COMPANION_STATUS.DISCONNECTED,
  ].includes(res.companionStatus);

  // Errors that are not about the companion or running apps (those get their own boxes).
  const errors = (res.errors || []).filter((e) => {
    if (companionBad && /companion/i.test(e)) return false;
    if (res.runningBlocked && res.runningBlocked.length && /close/i.test(e)) return false;
    return true;
  });
  if (!res.ok && res.error && !errors.length) errors.push(res.error);
  if (errors.length) {
    ui.errorList.replaceChildren(...errors.map((e) => {
      const li = document.createElement("li");
      li.textContent = e;
      return li;
    }));
    ui.errorBox.hidden = false;
    const s = studentFields();
    if (errors.some((e) => /code/i.test(e))) ui.code.setAttribute("aria-invalid", "true");
    if (!s.name) ui.name.setAttribute("aria-invalid", "true");
    if (!s.studentNo) ui.studentNo.setAttribute("aria-invalid", "true");
    if (!s.section) ui.section.setAttribute("aria-invalid", "true");
  }

  if (companionBad) {
    const platform = res.platform || guessPlatform();
    ui.installTitle.textContent = res.companionStatus === COMPANION_STATUS.WRONG_ID
      ? "Desktop companion was installed for a different copy of LockIn"
      : res.companionStatus === COMPANION_STATUS.DISCONNECTED
        ? "Desktop companion did not answer"
        : "Desktop companion not installed";
    ui.installCmd.textContent = INSTALL_HINTS[platform] || INSTALL_HINTS.linux;
    ui.installBox.hidden = false;
  }

  const running = res.runningBlocked || [];
  if (running.length) {
    const names = [...new Set(running.map((a) => a.name))];
    ui.appsList.textContent = names.join(", ");
    ui.appsBox.hidden = false;
  }

  if (res.ok) {
    precheckPassed = true;
    ui.readyExam.textContent = res.examName || "the exam";
    ui.readyBox.hidden = false;
    ui.primaryOff.textContent = "Lock in";
    ui.primaryOff.classList.add("ready");
  } else {
    ui.primaryOff.textContent = (companionBad || running.length) ? "Check again" : "Check and lock in";
  }
}

/* ---------- off form submit ---------- */

async function onOffSubmit(ev) {
  ev.preventDefault();
  if (busy) return;
  busy = true;
  ui.primaryOff.disabled = true;
  const code = ui.code.value.trim();
  const student = studentFields();
  await savePrefs();

  try {
    if (precheckPassed) {
      ui.primaryOff.textContent = "Locking in…";
      const res = await send({ type: MSG.ARM, code, student });
      if (!res.ok) {
        clearPrecheck();
        showPrecheck({ ok: false, errors: [res.error || "Could not lock in. Try again."], companionStatus: current && current.companionStatus });
      }
      // On success the background opens the exam window; storage changes re-render us.
    } else {
      ui.primaryOff.textContent = "Checking…";
      const res = await send({ type: MSG.PRECHECK, code, student });
      showPrecheck(res);
    }
  } finally {
    busy = false;
    ui.primaryOff.disabled = false;
  }
}

/* ---------- PIN ---------- */

function openPin(action) {
  pinAction = action;
  ui.pinForm.hidden = false;
  ui.pinError.hidden = true;
  ui.pin.value = "";
  const isEnd = action === "end";
  ui.pinLabel.textContent = isEnd ? "Professor PIN to end the exam" : "Professor PIN to clear the warning";
  ui.pinSubmit.textContent = isEnd ? "End exam" : "Clear warning";
  renderPinLock();
  if (!ui.pin.disabled) ui.pin.focus();
}

function closePin() {
  pinAction = null;
  ui.pinForm.hidden = true;
  ui.pin.value = "";
}

function renderPinLock() {
  const left = pinLockedUntil - Date.now();
  const locked = left > 0;
  ui.pin.disabled = locked;
  ui.pinSubmit.disabled = locked;
  if (locked) {
    ui.pinError.textContent = `Too many wrong tries. Try again in ${Math.ceil(left / 1000)}s.`;
    ui.pinError.hidden = false;
  } else if (/Too many wrong tries/.test(ui.pinError.textContent)) {
    ui.pinError.hidden = true;
    ui.pinError.textContent = "";
  }
}

async function onPinSubmit(ev) {
  ev.preventDefault();
  if (!pinAction || busy) return;
  const pin = ui.pin.value.trim();
  if (!pin) {
    ui.pinError.textContent = "Enter the professor PIN.";
    ui.pinError.hidden = false;
    return;
  }
  busy = true;
  ui.pinSubmit.disabled = true;
  const type = pinAction === "end" ? MSG.END_EXAM : MSG.CLEAR_WARNING;
  const res = await send({ type, pin });
  busy = false;
  ui.pinSubmit.disabled = false;
  if (res.ok) {
    closePin();
    refresh();
    return;
  }
  if (res.lockedUntil) pinLockedUntil = res.lockedUntil;
  ui.pin.value = "";
  ui.pinError.textContent = res.error || "Wrong PIN";
  ui.pinError.hidden = false;
  renderPinLock();
  if (!ui.pin.disabled) ui.pin.focus();
}

/* ---------- render ---------- */

function setView(mode) {
  ui.body.dataset.mode = mode;
  ui.viewOff.hidden = mode !== MODES.OFF;
  ui.viewActive.hidden = !(mode === MODES.ARMED || mode === MODES.TRIGGERED);
  ui.viewSubmitted.hidden = mode !== MODES.SUBMITTED;
}

function render() {
  const state = (current && current.state) || { mode: MODES.OFF };
  const mode = Object.values(MODES).includes(state.mode) ? state.mode : MODES.OFF;
  const prevMode = ui.body.dataset.mode;
  setView(mode);
  if (prevMode !== mode) closePin();
  if (current && current.pinLockedUntil) pinLockedUntil = Math.max(pinLockedUntil, current.pinLockedUntil);

  const config = state.config || {};
  const examName = config.examName || (publicState && publicState.examName) || "Exam";
  const count = state.violationCount || 0;

  if (mode === MODES.OFF) {
    ui.stateTitle.textContent = "Off";
    ui.stateSub.textContent = "Exam mode is not running";
    if (prevMode !== MODES.OFF) clearPrecheck();
    if (ui.errorBox.hidden && ui.installBox.hidden && ui.appsBox.hidden) {
      renderCompanion(current ? current.companionStatus : COMPANION_STATUS.IDLE);
    }
    const last = current && current.lastSession;
    if (last && last.examName) {
      const dur = last.endedAt && last.startedAt ? formatDuration(last.endedAt - last.startedAt) : "";
      const how = last.reason === "submitted" ? "submitted" : "ended by professor";
      ui.lastSession.textContent =
        `Last exam: ${last.examName}, ${how}${dur ? " after " + dur : ""}, ${plural(last.violationCount || 0, "violation")}`;
      ui.lastSession.hidden = false;
    } else {
      ui.lastSession.hidden = true;
    }
  } else if (mode === MODES.ARMED || mode === MODES.TRIGGERED) {
    const triggered = mode === MODES.TRIGGERED;
    ui.stateTitle.textContent = triggered ? "Violation recorded" : "Locked in";
    ui.stateSub.textContent = triggered
      ? "Your professor can see this. Go back to your exam."
      : "Stay in the exam window until you submit";
    ui.actExam.textContent = examName;
    ui.actExam.title = examName;
    const student = state.student || {};
    ui.actStudent.textContent = student.name || "-";
    ui.actStudent.title = student.name || "";
    ui.actCount.textContent = String(count);
    ui.clearBtn.hidden = !triggered;
    if (!triggered && pinAction === "clear") closePin();

    const list = (state.violations || []).slice(-5).reverse();
    if (triggered && list.length) {
      ui.violationLog.replaceChildren(...list.map((v) => {
        const li = document.createElement("li");
        const t = document.createElement("time");
        t.textContent = formatTime(v.ts);
        const span = document.createElement("span");
        span.textContent = v.label || v.type || "Violation";
        const extras = [];
        if (v.count > 1) extras.push(`×${v.count}`);
        const d = formatDuration(v.durationMs);
        if (d) extras.push(`away ${d}`);
        if (extras.length) {
          const ex = document.createElement("span");
          ex.className = "extra";
          ex.textContent = " · " + extras.join(" · ");
          span.append(ex);
        }
        li.append(t, span);
        return li;
      }));
      ui.violationLog.hidden = false;
    } else {
      ui.violationLog.hidden = true;
    }
  } else if (mode === MODES.SUBMITTED) {
    ui.stateTitle.textContent = "Submitted";
    ui.stateSub.textContent = "Your form was submitted. The exam is over.";
    const endTs = state.submittedAt || (publicState && publicState.submittedAt) || Date.now();
    ui.subExam.textContent = examName;
    ui.subExam.title = examName;
    ui.subTime.textContent = state.startedAt ? formatDuration(endTs - state.startedAt) || "under 1s" : "-";
    ui.subCount.textContent = String(count);
  }

  tick();
}

function tick() {
  const state = current && current.state;
  if (state && (state.mode === MODES.ARMED || state.mode === MODES.TRIGGERED) && state.startedAt) {
    ui.actElapsed.textContent = formatElapsed(Date.now() - state.startedAt);
  }
  if (pinAction) renderPinLock();
}

// Coalesces bursts of storage changes: at most one GET_STATE in flight, plus
// one follow-up if something changed while it was running.
let refreshing = false;
let refreshAgain = false;
async function refresh() {
  if (refreshing) { refreshAgain = true; return; }
  refreshing = true;
  try {
    do {
      refreshAgain = false;
      const res = await send({ type: MSG.GET_STATE });
      if (res && res.ok) current = res;
      else if (!current) current = { ok: false, state: { mode: MODES.OFF }, companionStatus: COMPANION_STATUS.IDLE };
      try {
        const got = await chrome.storage.local.get(STORAGE_KEYS.PUBLIC);
        publicState = got[STORAGE_KEYS.PUBLIC] || null;
      } catch (_) { publicState = null; }
      render();
    } while (refreshAgain);
  } finally {
    refreshing = false;
  }
}

/* ---------- wiring ---------- */

function init() {
  ui.version.textContent = "v" + VERSION;

  try { chrome.runtime.connect({ name: POPUP_PORT }); } catch (_) { /* worker restarting */ }

  ui.offForm.addEventListener("submit", onOffSubmit);
  for (const el of [ui.code, ui.name, ui.studentNo, ui.section]) {
    el.addEventListener("input", () => {
      el.removeAttribute("aria-invalid");
      if (precheckPassed) clearPrecheck();
      savePrefsSoon();
    });
  }

  ui.copyInstall.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(ui.installCmd.textContent);
      ui.copyInstall.textContent = "Copied";
      setTimeout(() => { ui.copyInstall.textContent = "Copy"; }, 1500);
    } catch (_) { /* clipboard blocked */ }
  });

  ui.goExam.addEventListener("click", async () => {
    await send({ type: MSG.FOCUS_EXAM });
    window.close();
  });
  ui.endBtn.addEventListener("click", () => (pinAction === "end" ? closePin() : openPin("end")));
  ui.clearBtn.addEventListener("click", () => (pinAction === "clear" ? closePin() : openPin("clear")));
  ui.pinCancel.addEventListener("click", closePin);
  ui.pinForm.addEventListener("submit", onPinSubmit);

  ui.doneBtn.addEventListener("click", async () => {
    ui.doneBtn.disabled = true;
    await send({ type: MSG.DONE });
    ui.doneBtn.disabled = false;
    refresh();
  });

  ui.openSetup.addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });

  ui.toggleCollect.addEventListener("click", () => {
    const open = ui.collectBox.hidden;
    ui.collectBox.hidden = !open;
    ui.toggleCollect.setAttribute("aria-expanded", String(open));
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes[STORAGE_KEYS.STATE] || changes[STORAGE_KEYS.PUBLIC] || changes[STORAGE_KEYS.LAST_SESSION]) {
      refresh();
    }
  });

  tickTimer = setInterval(tick, 1000); // dies with the popup

  loadPrefs().then(refresh);
}

init();
