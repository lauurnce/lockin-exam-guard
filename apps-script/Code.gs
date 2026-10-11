/**
 * LockIn Exam Guard - professor dashboard (Google Apps Script).
 *
 * Receives events from the LockIn extension and writes them into this Google
 * Sheet: every event goes to "Events", and "Live Status" keeps one row per
 * student (keyed by Exam ID + Student no.) with their current state, violation
 * count, last seen time and ONLINE/OFFLINE.
 *
 * SETUP (one time, about 5 minutes):
 *   1. Create a new Google Sheet (sheets.new).
 *   2. Extensions -> Apps Script. Delete the sample code and paste this file.
 *   3. Optional: put a shared secret in SHARED_SECRET below, and the same text
 *      in LockIn's "Professor setup" page. Leave "" to skip the check.
 *   4. Pick the function "setup" in the toolbar and click Run once.
 *      Allow the permissions it asks for.
 *   5. Deploy -> New deployment -> type "Web app".
 *        Execute as: Me
 *        Who has access: Anyone
 *      Click Deploy and copy the URL that ends in /exec.
 *   6. Paste that /exec URL into "Webhook URL" in LockIn's Professor setup.
 *   7. In the Sheet: File -> Settings -> Calculation -> Recalculation:
 *      "On change and every minute" (so ONLINE/OFFLINE stays fresh).
 *
 * If you edit this code later, use Deploy -> Manage deployments -> Edit ->
 * Version: "New version". Otherwise the old code keeps running.
 */

const SHARED_SECRET = "";

const EVENTS_SHEET = "Events";
const STATUS_SHEET = "Live Status";

const EVENTS_HEADERS = [
  "Server time", "Client time", "Exam ID", "Exam", "Student", "Student no.",
  "Section", "Event", "Type", "Category", "Detail", "Away (s)", "Violation count"
];
const EVENTS_WIDTHS = [150, 150, 90, 180, 170, 110, 80, 130, 160, 110, 300, 70, 110];

const STATUS_HEADERS = [
  "Exam ID", "Exam", "Student", "Student no.", "Section", "State",
  "Violations", "Last seen", "Online", "Last violation"
];
const STATUS_WIDTHS = [90, 180, 170, 110, 80, 110, 90, 150, 80, 340];

// Live Status column numbers (1-based).
const COL = {
  EXAM_ID: 1, EXAM: 2, STUDENT: 3, STUDENT_NO: 4, SECTION: 5,
  STATE: 6, VIOLATIONS: 7, LAST_SEEN: 8, ONLINE: 9, LAST_VIOLATION: 10
};

/** Run once from the Apps Script editor. Safe to run again. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const events = prepareSheet_(ss, EVENTS_SHEET, EVENTS_HEADERS, EVENTS_WIDTHS);
  const status = prepareSheet_(ss, STATUS_SHEET, STATUS_HEADERS, STATUS_WIDTHS);

  // Keep student numbers as text so leading zeros survive.
  events.getRange("F:F").setNumberFormat("@");
  status.getRange("D:D").setNumberFormat("@");
  events.getRange("A:B").setNumberFormat("yyyy-mm-dd hh:mm:ss");
  status.getRange("H:H").setNumberFormat("yyyy-mm-dd hh:mm:ss");

  const stateRange = status.getRange("F2:F");
  const onlineRange = status.getRange("I2:I");
  const rules = [
    textRule_(stateRange, "ARMED", "#DCFCE7", "#16A34A"),
    textRule_(stateRange, "TRIGGERED", "#FEE2E2", "#DC2626"),
    textRule_(stateRange, "UNINSTALLED", "#FEE2E2", "#DC2626"),
    textRule_(stateRange, "ENDED", "#F4F4F5", "#71717A"),
    textRule_(stateRange, "SUBMITTED", "#F4F4F5", "#71717A"),
    textRule_(onlineRange, "OFFLINE", "#FEE2E2", "#DC2626"),
    textRule_(onlineRange, "ONLINE", "#FFFFFF", "#16A34A")
  ];
  status.setConditionalFormatRules(rules);

  // Remove the default empty "Sheet1" if it is still there and unused.
  const sheet1 = ss.getSheetByName("Sheet1");
  if (sheet1 && sheet1.getLastRow() === 0 && ss.getSheets().length > 2) {
    ss.deleteSheet(sheet1);
  }
}

function prepareSheet_(ss, name, headers, widths) {
  let sheet = ss.getSheetByName(name);
  if (!sheet) sheet = ss.insertSheet(name);
  sheet.getRange(1, 1, 1, headers.length)
    .setValues([headers])
    .setFontWeight("bold")
    .setBackground("#F4F4F5");
  sheet.setFrozenRows(1);
  for (let i = 0; i < widths.length; i++) sheet.setColumnWidth(i + 1, widths[i]);
  return sheet;
}

function textRule_(range, text, background, fontColor) {
  return SpreadsheetApp.newConditionalFormatRule()
    .whenTextEqualTo(text)
    .setBackground(background)
    .setFontColor(fontColor)
    .setBold(true)
    .setRanges([range])
    .build();
}

/** Receives events from the extension (POST, body = JSON as text/plain). */
function doPost(e) {
  let data;
  try {
    data = JSON.parse((e && e.postData && e.postData.contents) || "{}");
  } catch (err) {
    return json_({ ok: false, error: "Invalid JSON" });
  }
  if (!secretOk_(data.secret)) return json_({ ok: false, error: "Wrong secret" });
  if (!data.examId || !data.event) return json_({ ok: false, error: "Missing examId or event" });

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
  } catch (err) {
    return json_({ ok: false, error: "Busy, try again" });
  }
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const events = ensureSheets_(ss).events;
    const status = ss.getSheetByName(STATUS_SHEET);
    const student = data.student || {};
    const now = new Date();

    if (data.event !== "HEARTBEAT") {
      events.appendRow([
        now,
        data.clientTs ? new Date(Number(data.clientTs)) : "",
        String(data.examId),
        str_(data.examName),
        str_(student.name),
        str_(student.studentNo),
        str_(student.section),
        str_(data.event),
        str_(data.type),
        str_(data.category),
        detailText_(data),
        data.durationMs ? Math.round(Number(data.durationMs) / 100) / 10 : "",
        data.violationCount != null ? Number(data.violationCount) : ""
      ]);
    }

    upsertStatus_(status, data, now);
    return json_({ ok: true });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    lock.releaseLock();
  }
}

/**
 * GET is used by the uninstall URL (?event=UNINSTALLED&examId=..&studentNo=..&secret=..).
 * With no parameters it returns {ok:true} so you can test the deployment in a browser.
 */
function doGet(e) {
  const p = (e && e.parameter) || {};
  if (p.event !== "UNINSTALLED") return json_({ ok: true });
  if (!secretOk_(p.secret)) return json_({ ok: false, error: "Wrong secret" });

  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(10000);
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const events = ensureSheets_(ss).events;
    const status = ss.getSheetByName(STATUS_SHEET);
    const now = new Date();
    const data = {
      examId: p.examId || "",
      examName: "",
      student: { studentNo: p.studentNo || "" },
      event: "UNINSTALLED",
      state: "uninstalled"
    };
    events.appendRow([now, "", str_(data.examId), "", "", str_(p.studentNo), "",
      "UNINSTALLED", "", "", "LockIn was removed from the browser", "", ""]);
    if (data.examId && p.studentNo) upsertStatus_(status, data, now);
  } catch (err) {
    // Still show the page; the student has already removed the extension.
  } finally {
    try { lock.releaseLock(); } catch (err2) { /* not held */ }
  }
  return HtmlService.createHtmlOutput(
    "<p style=\"font-family:sans-serif\">LockIn was removed. Your professor has been notified.</p>"
  );
}

/** Insert or update the student's Live Status row. */
function upsertStatus_(status, data, now) {
  const student = data.student || {};
  const examId = String(data.examId);
  const studentNo = str_(student.studentNo);
  const row = findStatusRow_(status, examId, studentNo);
  const state = stateFor_(data);

  if (row === -1) {
    const r = status.getLastRow() + 1;
    status.getRange(r, 1, 1, STATUS_HEADERS.length).setValues([[
      examId,
      str_(data.examName),
      str_(student.name),
      studentNo,
      str_(student.section),
      state,
      data.violationCount != null ? Number(data.violationCount) : 0,
      now,
      onlineFormula_(r),
      lastViolationText_(data, now)
    ]]);
    return;
  }

  status.getRange(row, COL.STATE).setValue(state);
  status.getRange(row, COL.LAST_SEEN).setValue(now);
  status.getRange(row, COL.ONLINE).setFormula(onlineFormula_(row));
  if (data.examName) status.getRange(row, COL.EXAM).setValue(str_(data.examName));
  if (student.name) status.getRange(row, COL.STUDENT).setValue(str_(student.name));
  if (student.section) status.getRange(row, COL.SECTION).setValue(str_(student.section));
  if (data.violationCount != null) status.getRange(row, COL.VIOLATIONS).setValue(Number(data.violationCount));
  const lv = lastViolationText_(data, now);
  if (lv) status.getRange(row, COL.LAST_VIOLATION).setValue(lv);
}

function findStatusRow_(status, examId, studentNo) {
  const last = status.getLastRow();
  if (last < 2) return -1;
  const values = status.getRange(2, 1, last - 1, COL.STUDENT_NO).getValues();
  for (let i = 0; i < values.length; i++) {
    if (String(values[i][COL.EXAM_ID - 1]) === examId &&
        String(values[i][COL.STUDENT_NO - 1]) === studentNo) {
      return i + 2;
    }
  }
  return -1;
}

/** Turn the extension's mode + event into the State column text. */
function stateFor_(data) {
  if (data.event === "UNINSTALLED") return "UNINSTALLED";
  if (data.event === "SESSION_END") {
    const reason = String(data.detail || data.type || data.state || "").toLowerCase();
    return reason.indexOf("submit") !== -1 ? "SUBMITTED" : "ENDED";
  }
  const mode = String(data.state || "").toLowerCase();
  if (mode === "armed") return "ARMED";
  if (mode === "triggered") return "TRIGGERED";
  if (mode === "submitted") return "SUBMITTED";
  if (mode === "off") return "ENDED";
  return mode ? mode.toUpperCase() : "ARMED";
}

function lastViolationText_(data, now) {
  if (data.event !== "VIOLATION") return "";
  const when = Utilities.formatDate(
    data.clientTs ? new Date(Number(data.clientTs)) : now,
    Session.getScriptTimeZone(),
    "h:mm:ss a"
  );
  return str_(data.label || data.type) + " · " + when;
}

function onlineFormula_(row) {
  return '=IF(H' + row + '="","",IF(NOW()-H' + row + '>3/1440,"OFFLINE","ONLINE"))';
}

function ensureSheets_(ss) {
  if (!ss.getSheetByName(EVENTS_SHEET) || !ss.getSheetByName(STATUS_SHEET)) setup();
  return { events: ss.getSheetByName(EVENTS_SHEET) };
}

function secretOk_(given) {
  if (!SHARED_SECRET) return true;
  return String(given || "") === SHARED_SECRET;
}

/** Text for the Events "Detail" column: label, plus detail when it adds something. */
function detailText_(data) {
  const label = data.label ? String(data.label) : "";
  const detail = data.detail ? String(data.detail) : "";
  if (label && detail && detail !== label) return str_(label + " (" + detail + ")");
  return str_(label || detail);
}

/** Stringify and stop cell text from being read as a formula (=, +, -, @). */
function str_(v) {
  if (v == null) return "";
  const s = String(v);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
