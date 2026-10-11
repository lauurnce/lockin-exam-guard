/*
 * rules.test.mjs
 * Unit tests for the pure URL rules (rules.js) and the exam code / PIN
 * helpers (examcode.js). Run with:  node --test extension/lib/rules.test.mjs
 * Uses only node:test and node:assert/strict (no npm packages).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { classifyUrl, isEnforced } from "./rules.js";
import {
  extractFormId, isFormsGle, randomExamId, hashPin, verifyPin, isValidPin,
  encodeExamCode, decodeExamCode,
} from "./examcode.js";
import { CATEGORIES, DEFAULT_OPTIONS, PIN_ITERATIONS } from "./constants.js";

const FORM_ID = "1FAIpQLSdAbCdEfGhIjKlMnOp";
const EXT = "chrome-extension://abcdefghijklmnop";
const ctx = { formId: FORM_ID, allow: [], extensionOrigin: EXT };
const c = (url, extra) => classifyUrl(url, { ...ctx, ...(extra || {}) });

// ---------- rules.js: allowed ----------

test("published form URL is allowed as EXAM", () => {
  const r = c(`https://docs.google.com/forms/d/e/${FORM_ID}/viewform`);
  assert.equal(r.allowed, true);
  assert.equal(r.category, "EXAM");
});

test("/u/1/ multi-account form URL is allowed", () => {
  const r = c(`https://docs.google.com/forms/u/1/d/e/${FORM_ID}/formResponse`);
  assert.equal(r.allowed, true);
  assert.equal(r.category, "EXAM");
});

test("a different form ID is blocked", () => {
  const r = c("https://docs.google.com/forms/d/e/1FAIpQLSzzzzzzzzzzzzzzz/viewform");
  assert.equal(r.allowed, false);
});

test("null formId allows any docs.google.com/forms URL", () => {
  const r = c("https://docs.google.com/forms/d/e/1FAIpQLSzzzzzzzzzzzzzzz/viewform", { formId: null });
  assert.equal(r.allowed, true);
  assert.equal(r.category, "EXAM");
});

test("null formId still blocks Google Docs documents", () => {
  const r = c("https://docs.google.com/document/d/abc/edit", { formId: null });
  assert.equal(r.allowed, false);
  assert.equal(r.category, "DOCS");
});

test("forms.gle short link is allowed", () => {
  const r = c("https://forms.gle/AbC123xyz");
  assert.equal(r.allowed, true);
  assert.equal(r.category, "ALLOWED");
});

test("accounts.google.com is allowed", () => {
  const r = c("https://accounts.google.com/ServiceLogin?continue=x");
  assert.equal(r.allowed, true);
  assert.equal(r.category, "ALLOWED");
});

test("empty URL and about:blank are allowed as TRANSITIONAL", () => {
  for (const u of ["", "about:blank", "about:srcdoc", undefined, null]) {
    const r = c(u);
    assert.equal(r.allowed, true, String(u));
    assert.equal(r.category, "TRANSITIONAL");
  }
});

test("own blocked page is allowed", () => {
  const r = c(`${EXT}/blocked/blocked.html?u=x&c=AI`);
  assert.equal(r.allowed, true);
  assert.equal(r.category, "BLOCKED_PAGE");
});

test("own options page is OWN_OPTIONS and blocked", () => {
  const r = c(`${EXT}/options/options.html`);
  assert.equal(r.allowed, false);
  assert.equal(r.category, "OWN_OPTIONS");
});

test("another extension's page is SETTINGS", () => {
  const r = c("chrome-extension://zzzzzzzzzzzzzzzz/popup.html");
  assert.equal(r.allowed, false);
  assert.equal(r.category, "SETTINGS");
});

test("extra allow desmos.com allows host and subdomains", () => {
  const extra = { allow: ["desmos.com"] };
  assert.equal(c("https://www.desmos.com/calculator", extra).allowed, true);
  assert.equal(c("https://desmos.com/", extra).allowed, true);
  assert.equal(c("https://notdesmos.com/", extra).allowed, false);
});

test("extra allow with path prefix only allows under that path", () => {
  const extra = { allow: ["https://example.edu/formulas"] };
  assert.equal(c("https://example.edu/formulas", extra).allowed, true);
  assert.equal(c("https://example.edu/formulas/sheet1", extra).allowed, true);
  assert.equal(c("https://example.edu/other", extra).allowed, false);
  assert.equal(c("https://example.edu/formulasX", extra).allowed, false);
});

// ---------- rules.js: blocked categories ----------

test("chatgpt.com is AI with friendly site name", () => {
  const r = c("https://chatgpt.com/");
  assert.equal(r.allowed, false);
  assert.equal(r.category, "AI");
  assert.equal(r.site, "ChatGPT");
});

test("chat.openai.com is AI", () => {
  assert.equal(c("https://chat.openai.com/c/123").category, "AI");
});

test("gemini.google.com is AI", () => {
  assert.equal(c("https://gemini.google.com/app").category, "AI");
});

test("host containing 'chatgpt' is AI", () => {
  assert.equal(c("https://free-chatgpt-online.example/").category, "AI");
});

test("huggingface.co/chat is AI but huggingface.co is OTHER", () => {
  assert.equal(c("https://huggingface.co/chat/conversation/1").category, "AI");
  assert.equal(c("https://huggingface.co/models").category, "OTHER");
});

test("www.google.com/search?q=x is SEARCH", () => {
  assert.equal(c("https://www.google.com/search?q=x").category, "SEARCH");
});

test("www.google.com home page is SEARCH", () => {
  const r = c("https://www.google.com/");
  assert.equal(r.category, "SEARCH");
  assert.equal(r.allowed, false);
});

test("docs.google.com/document is DOCS", () => {
  const r = c("https://docs.google.com/document/d/abc/edit");
  assert.equal(r.category, "DOCS");
  assert.equal(r.site, "Google Docs");
});

test("keep.google.com is NOTES", () => {
  assert.equal(c("https://keep.google.com/u/0/").category, "NOTES");
});

test("https://x.com/file.pdf is PDF", () => {
  assert.equal(c("https://x.com/file.pdf").category, "PDF");
});

test("file:///Users/me/a.pdf is PDF; other local files are LOCAL_FILE", () => {
  assert.equal(c("file:///Users/me/a.pdf").category, "PDF");
  assert.equal(c("file:///Users/me/notes.txt").category, "LOCAL_FILE");
});

test("chrome://extensions and other browser pages are SETTINGS", () => {
  for (const u of ["chrome://extensions", "edge://settings", "about:config", "view-source:https://a.com", "devtools://devtools/x"]) {
    const r = c(u);
    assert.equal(r.allowed, false, u);
    assert.equal(r.category, "SETTINGS", u);
  }
});

test("brainly.ph is HOMEWORK", () => {
  const r = c("https://brainly.ph/question/123");
  assert.equal(r.category, "HOMEWORK");
  assert.equal(r.site, "Brainly");
});

test("x.com is COMMUNICATION", () => {
  assert.equal(c("https://x.com/home").category, "COMMUNICATION");
});

test("unknown site is OTHER with hostname as site", () => {
  const r = c("https://example.org/page");
  assert.equal(r.allowed, false);
  assert.equal(r.category, "OTHER");
  assert.equal(r.site, "example.org");
});

test("unparseable URL is blocked OTHER", () => {
  const r = c("ht!tp:::// not a url");
  assert.equal(r.allowed, false);
  assert.equal(r.category, "OTHER");
});

// ---------- rules.js: isEnforced ----------

test("isEnforced: listed category is enforced, unlisted known category is not", () => {
  assert.equal(isEnforced("AI", ["AI", "SEARCH"]), true);
  assert.equal(isEnforced("HOMEWORK", ["AI", "SEARCH"]), false);
});

test("isEnforced: SETTINGS, LOCAL_FILE, OWN_OPTIONS, OTHER are always enforced", () => {
  for (const cat of ["SETTINGS", "LOCAL_FILE", "OWN_OPTIONS", "OTHER"]) {
    assert.equal(isEnforced(cat, []), true, cat);
  }
});

test("isEnforced: missing list falls back to all categories", () => {
  for (const cat of CATEGORIES) assert.equal(isEnforced(cat, undefined), true, cat);
});

// ---------- examcode.js ----------

test("extractFormId and isFormsGle", () => {
  assert.equal(extractFormId(`https://docs.google.com/forms/u/2/d/e/${FORM_ID}/viewform`), FORM_ID);
  assert.equal(extractFormId("https://forms.gle/abc"), null);
  assert.equal(extractFormId(null), null);
  assert.equal(isFormsGle("https://forms.gle/abc"), true);
  assert.equal(isFormsGle("https://docs.google.com/forms/d/x"), false);
  assert.equal(isFormsGle("garbage"), false);
});

test("randomExamId is 8 base32 chars", () => {
  const id = randomExamId();
  assert.match(id, /^[A-Z2-7]{8}$/);
  assert.notEqual(randomExamId(), randomExamId());
});

test("isValidPin requires at least 4 digits", () => {
  assert.equal(isValidPin("1234"), true);
  assert.equal(isValidPin("123456"), true);
  assert.equal(isValidPin("123"), false);
  assert.equal(isValidPin("12a4"), false);
  assert.equal(isValidPin(""), false);
  assert.equal(isValidPin(null), false);
});

test("hashPin + verifyPin: correct PIN verifies, wrong PIN fails", async () => {
  const h = await hashPin("4821");
  assert.equal(h.pinIter, PIN_ITERATIONS);
  assert.equal(typeof h.pinHash, "string");
  assert.equal(typeof h.pinSalt, "string");
  assert.notEqual(h.pinHash, "4821");
  assert.equal(await verifyPin("4821", h), true);
  assert.equal(await verifyPin("4822", h), false);
  assert.equal(await verifyPin("4821", { pinHash: "", pinSalt: "", pinIter: 0 }), false);
});

function sampleConfig() {
  return {
    v: 1,
    examId: "ABCD2345",
    examName: "COMP 018 Quiz 2 — ñ",
    formUrl: `https://docs.google.com/forms/d/e/${FORM_ID}/viewform`,
    formId: FORM_ID,
    allow: ["desmos.com"],
    pinHash: "aGFzaA==", pinSalt: "c2FsdA==", pinIter: PIN_ITERATIONS,
    webhookUrl: "",
    secret: "",
    options: { ...DEFAULT_OPTIONS, blockContextMenu: true },
  };
}

test("exam code round trip", async () => {
  const cfg = sampleConfig();
  const code = await encodeExamCode(cfg);
  assert.match(code, /^LOCKIN1\.[A-Za-z0-9_-]+\.[0-9a-f]{8}$/);
  const res = await decodeExamCode(`  ${code}\n`);
  assert.equal(res.ok, true);
  assert.deepEqual(res.config, cfg);
});

test("tampered exam code fails checksum with friendly error", async () => {
  const code = await encodeExamCode(sampleConfig());
  const parts = code.split(".");
  const p = parts[1];
  parts[1] = p.slice(0, 10) + (p[10] === "A" ? "B" : "A") + p.slice(11);
  const res = await decodeExamCode(parts.join("."));
  assert.equal(res.ok, false);
  assert.equal(res.error, "This exam code looks incomplete. Copy it again.");
});

test("decoding garbage gives the friendly error", async () => {
  for (const g of ["", "hello", "LOCKIN1.", "LOCKIN1.abc.def", null]) {
    const res = await decodeExamCode(g);
    assert.equal(res.ok, false, String(g));
    assert.equal(typeof res.error, "string");
    assert.ok(res.error.length > 0);
  }
  const trunc = await decodeExamCode("LOCKIN1.eyJ2IjoxfQ");
  assert.equal(trunc.error, "This exam code looks incomplete. Copy it again.");
});

test("decode fills missing options from DEFAULT_OPTIONS", async () => {
  const cfg = sampleConfig();
  cfg.options = { blockPaste: false };
  delete cfg.allow;
  const res = await decodeExamCode(await encodeExamCode(cfg));
  assert.equal(res.ok, true);
  assert.equal(res.config.options.blockPaste, false);
  assert.equal(res.config.options.graceMs, DEFAULT_OPTIONS.graceMs);
  assert.deepEqual(res.config.options.categories, DEFAULT_OPTIONS.categories);
  assert.deepEqual(res.config.allow, []);
});
