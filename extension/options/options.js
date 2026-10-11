/*
 * options.js
 * Logic for the Professor setup page (ES module).
 * Validates the form (exam name, Google Form link via the form ID regex or a
 * forms.gle link, extra allowed sites, PIN + confirmation, optional https
 * webhook, grace period), hashes the PIN with PBKDF2 (lib/examcode.js), builds
 * the exam config from SPEC section 4 and encodes it into a LOCKIN1 exam code
 * with a Copy button. Non-secret fields are remembered between visits in
 * chrome.storage.local ("lockin_prof_draft"); the PIN never is.
 */

import {
  VERSION, CATEGORIES, CATEGORY_LABELS, DEFAULT_OPTIONS,
} from "../lib/constants.js";
import {
  encodeExamCode, hashPin, isValidPin, extractFormId, isFormsGle, randomExamId,
} from "../lib/examcode.js";

const DRAFT_KEY = "lockin_prof_draft"; // local to this page

const $ = (id) => document.getElementById(id);
const el = {
  form: $("setup"),
  examName: $("examName"),
  formUrl: $("formUrl"),
  allow: $("allow"),
  pin: $("pin"),
  pin2: $("pin2"),
  webhookUrl: $("webhookUrl"),
  secret: $("secret"),
  requireCompanion: $("requireCompanion"),
  fullscreen: $("fullscreen"),
  blockPaste: $("blockPaste"),
  blockContextMenu: $("blockContextMenu"),
  grace: $("grace"),
  categories: $("categories"),
  formErr: $("formErr"),
  generate: $("generate"),
  result: $("result"),
  resultName: $("resultName"),
  resultMeta: $("resultMeta"),
  code: $("code"),
  copy: $("copy"),
  version: $("version"),
};

const CATEGORY_HINTS = {
  AI: "ChatGPT, Gemini, Claude, Copilot",
  SEARCH: "Google Search, Bing",
  HOMEWORK: "Brainly, Quizlet, Chegg",
  DOCS: "Google Docs, Word online, Drive",
  NOTES: "Keep, Notion, Notes app",
  PDF: "PDF files and readers",
  BROWSER: "Other browsers",
  COMMUNICATION: "Messenger, Discord, email",
  REMOTE: "AnyDesk, TeamViewer",
};

/* ---------- build UI ---------- */

function buildCategories() {
  const frag = document.createDocumentFragment();
  for (const cat of CATEGORIES) {
    const label = document.createElement("label");
    label.className = "cat";
    label.title = CATEGORY_HINTS[cat] || "";
    const box = document.createElement("input");
    box.type = "checkbox";
    box.value = cat;
    box.checked = DEFAULT_OPTIONS.categories.includes(cat);
    const text = document.createElement("span");
    text.textContent = CATEGORY_LABELS[cat] || cat;
    label.append(box, text);
    frag.append(label);
  }
  el.categories.replaceChildren(frag);
}

function applyDefaults() {
  el.requireCompanion.checked = DEFAULT_OPTIONS.requireCompanion;
  el.fullscreen.checked = DEFAULT_OPTIONS.fullscreen;
  el.blockPaste.checked = DEFAULT_OPTIONS.blockPaste;
  el.blockContextMenu.checked = DEFAULT_OPTIONS.blockContextMenu;
  el.grace.value = String(DEFAULT_OPTIONS.graceMs / 1000);
}

/* ---------- draft persistence (never the PIN) ---------- */

function readDraft() {
  return {
    examName: el.examName.value,
    formUrl: el.formUrl.value,
    allow: el.allow.value,
    webhookUrl: el.webhookUrl.value,
    secret: el.secret.value,
    requireCompanion: el.requireCompanion.checked,
    fullscreen: el.fullscreen.checked,
    blockPaste: el.blockPaste.checked,
    blockContextMenu: el.blockContextMenu.checked,
    grace: el.grace.value,
    categories: selectedCategories(),
  };
}

async function loadDraft() {
  try {
    const got = await chrome.storage.local.get(DRAFT_KEY);
    const d = got[DRAFT_KEY];
    if (!d) return;
    for (const k of ["examName", "formUrl", "allow", "webhookUrl", "secret", "grace"]) {
      if (typeof d[k] === "string") el[k].value = d[k];
    }
    for (const k of ["requireCompanion", "fullscreen", "blockPaste", "blockContextMenu"]) {
      if (typeof d[k] === "boolean") el[k].checked = d[k];
    }
    if (Array.isArray(d.categories)) {
      for (const box of el.categories.querySelectorAll("input")) box.checked = d.categories.includes(box.value);
    }
  } catch (_) { /* no storage: keep defaults */ }
}

let draftTimer = null;
function saveDraftSoon() {
  clearTimeout(draftTimer);
  draftTimer = setTimeout(() => {
    try { chrome.storage.local.set({ [DRAFT_KEY]: readDraft() }); } catch (_) { /* ignore */ }
  }, 300);
}

/* ---------- validation ---------- */

function selectedCategories() {
  return [...el.categories.querySelectorAll("input:checked")].map((b) => b.value);
}

function setError(input, message) {
  const errEl = $(input.id + "-err");
  if (message) {
    input.setAttribute("aria-invalid", "true");
    if (errEl) errEl.textContent = message;
  } else {
    input.removeAttribute("aria-invalid");
    if (errEl) errEl.textContent = "";
  }
  return !message;
}

function parseHttpUrl(value) {
  try {
    const u = new URL(value);
    return (u.protocol === "https:" || u.protocol === "http:") ? u : null;
  } catch (_) {
    return null;
  }
}

function validateFormUrl(value) {
  if (!value) return "Paste the Google Form link.";
  const u = parseHttpUrl(value);
  if (!u) return "This is not a web link. It should start with https://";
  if (isFormsGle(value)) return "";
  if (u.hostname !== "docs.google.com" || !extractFormId(value)) {
    return "Use a Google Form link (docs.google.com/forms/…) or a forms.gle link.";
  }
  return "";
}

// "https://www.desmos.com/calculator/" -> "www.desmos.com/calculator"
function normalizeSite(line) {
  let s = line.trim().toLowerCase();
  if (!s) return "";
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\*\./, "");
  s = s.replace(/[?#].*$/, "").replace(/\/+$/, "");
  return s;
}
const SITE_RE = /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s]*)?$/;

function parseAllow(text) {
  const sites = [];
  const bad = [];
  for (const raw of text.split(/\r?\n/)) {
    const s = normalizeSite(raw);
    if (!s) continue;
    if (SITE_RE.test(s)) {
      if (!sites.includes(s)) sites.push(s);
    } else {
      bad.push(raw.trim());
    }
  }
  return { sites, bad };
}

function validate() {
  let ok = true;
  const examName = el.examName.value.trim();
  ok = setError(el.examName, examName ? "" : "Give the exam a name students will recognize.") && ok;

  ok = setError(el.formUrl, validateFormUrl(el.formUrl.value.trim())) && ok;

  const { sites, bad } = parseAllow(el.allow.value);
  ok = setError(el.allow, bad.length ? `Not a site: ${bad.slice(0, 3).join(", ")}` : "") && ok;

  const pin = el.pin.value.trim();
  const pinOk = setError(el.pin, isValidPin(pin) ? "" : "Use at least 4 digits, numbers only.");
  ok = pinOk && ok;
  ok = setError(el.pin2, !pinOk || el.pin2.value.trim() === pin ? "" : "The two PINs do not match.") && ok;

  const hook = el.webhookUrl.value.trim();
  let hookMsg = "";
  if (hook) {
    const u = parseHttpUrl(hook);
    if (!u || u.protocol !== "https:") hookMsg = "Use the https:// web app URL that ends in /exec.";
  }
  ok = setError(el.webhookUrl, hookMsg) && ok;

  const graceSec = Number(el.grace.value);
  const graceOk = el.grace.value.trim() !== "" && Number.isFinite(graceSec) && graceSec >= 0 && graceSec <= 10;
  ok = setError(el.grace, graceOk ? "" : "Pick a number of seconds from 0 to 10.") && ok;

  return { ok, examName, sites, pin, hook, graceMs: Math.round(graceSec * 1000) };
}

/* ---------- generate ---------- */

async function onGenerate(ev) {
  ev.preventDefault();
  el.formErr.hidden = true;
  const v = validate();
  if (!v.ok) {
    el.formErr.textContent = "Fix the highlighted fields first.";
    el.formErr.hidden = false;
    const first = el.form.querySelector('[aria-invalid="true"]');
    if (first) first.focus();
    return;
  }

  el.generate.disabled = true;
  el.generate.textContent = "Generating…";
  try {
    const formUrl = el.formUrl.value.trim();
    const pinFields = await hashPin(v.pin);
    const config = {
      v: 1,
      examId: randomExamId(),
      examName: v.examName,
      formUrl,
      formId: isFormsGle(formUrl) ? null : extractFormId(formUrl),
      allow: v.sites,
      pinHash: pinFields.pinHash,
      pinSalt: pinFields.pinSalt,
      pinIter: pinFields.pinIter,
      webhookUrl: v.hook,
      secret: el.secret.value.trim(),
      options: {
        requireCompanion: el.requireCompanion.checked,
        fullscreen: el.fullscreen.checked,
        blockPaste: el.blockPaste.checked,
        blockContextMenu: el.blockContextMenu.checked,
        graceMs: v.graceMs,
        categories: selectedCategories(),
      },
    };
    const code = await encodeExamCode(config);
    el.code.value = code;
    el.resultName.textContent = config.examName;
    el.resultMeta.textContent = `Exam ID ${config.examId} · ${config.webhookUrl ? "live dashboard on" : "no live dashboard"}`;
    el.result.hidden = false;
    el.copy.textContent = "Copy";
    el.copy.classList.remove("copied");
    el.pin.value = "";
    el.pin2.value = "";
    el.result.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "nearest" });
    el.code.focus();
    el.code.select();
  } catch (err) {
    el.formErr.textContent = "Could not generate the code: " + (err && err.message ? err.message : String(err));
    el.formErr.hidden = false;
  } finally {
    el.generate.disabled = false;
    el.generate.textContent = "Generate exam code";
  }
}

async function onCopy() {
  try {
    await navigator.clipboard.writeText(el.code.value);
  } catch (_) {
    el.code.select();
    document.execCommand("copy");
  }
  el.copy.textContent = "Copied";
  el.copy.classList.add("copied");
  setTimeout(() => {
    el.copy.textContent = "Copy";
    el.copy.classList.remove("copied");
  }, 1800);
}

/* ---------- init ---------- */

function markStale() {
  // Any edit after generating means the shown code no longer matches the form.
  if (!el.result.hidden) el.result.hidden = true;
}

async function init() {
  el.version.textContent = "v" + VERSION;
  buildCategories();
  applyDefaults();
  await loadDraft();

  el.form.addEventListener("submit", onGenerate);
  el.copy.addEventListener("click", onCopy);
  el.form.addEventListener("input", (e) => {
    if (e.target === el.code) return;
    if (e.target.getAttribute && e.target.getAttribute("aria-invalid") === "true") setError(e.target, "");
    markStale();
    if (e.target !== el.pin && e.target !== el.pin2) saveDraftSoon();
  });
  el.form.addEventListener("change", (e) => {
    if (e.target.type === "checkbox") { markStale(); saveDraftSoon(); }
  });
}

init();
