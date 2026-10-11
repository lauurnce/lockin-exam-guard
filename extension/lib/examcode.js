/*
 * examcode.js
 * Exam code and PIN helpers (SPEC section 4). An exam code is
 *   "LOCKIN1." + base64url(UTF-8 JSON config) + "." + first 8 hex of SHA-256(payload)
 * where payload is the base64url part. PINs are hashed with PBKDF2-SHA256
 * (16-byte random salt, 150,000 iterations); the plain PIN is never stored.
 * Uses only WebCrypto (globalThis.crypto), so it runs in Chrome and node 20+.
 */

import { CATEGORIES, CODE_PREFIX, DEFAULT_OPTIONS, FORM_ID_REGEX, PIN_ITERATIONS } from "./constants.js";

const INCOMPLETE = "This exam code looks incomplete. Copy it again.";
const NOT_A_CODE = "This is not a LockIn exam code. Check that you copied the whole code.";
const TOO_NEW = "This exam code needs a newer version of LockIn. Update the extension.";
const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

const enc = new TextEncoder();
const dec = new TextDecoder("utf-8", { fatal: true });

// ---------- byte helpers ----------

function bytesToBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

function base64ToBytes(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function toBase64Url(bytes) {
  return bytesToBase64(bytes).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function fromBase64Url(s) {
  let b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  while (b64.length % 4) b64 += "=";
  return base64ToBytes(b64);
}

async function sha256Hex8(text) {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(text)));
  let hex = "";
  for (let i = 0; i < 4; i++) hex += digest[i].toString(16).padStart(2, "0");
  return hex;
}

// ---------- form links ----------

export function extractFormId(url) {
  if (typeof url !== "string") return null;
  const m = url.match(FORM_ID_REGEX);
  return m ? m[1] : null;
}

export function isFormsGle(url) {
  try {
    return new URL(String(url).trim()).hostname.toLowerCase() === "forms.gle";
  } catch (e) {
    return false;
  }
}

export function randomExamId() {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  let id = "";
  for (const b of bytes) id += BASE32[b & 31];
  return id;
}

// ---------- PIN ----------

export function isValidPin(pin) {
  return typeof pin === "string" && /^\d{4,}$/.test(pin);
}

async function derive(pin, saltBytes, iterations) {
  const key = await crypto.subtle.importKey("raw", enc.encode(String(pin)), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: saltBytes, iterations },
    key,
    256,
  );
  return new Uint8Array(bits);
}

export async function hashPin(pin) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(pin, salt, PIN_ITERATIONS);
  return { pinHash: bytesToBase64(hash), pinSalt: bytesToBase64(salt), pinIter: PIN_ITERATIONS };
}

export async function verifyPin(pin, { pinHash, pinSalt, pinIter } = {}) {
  try {
    if (typeof pin !== "string" || !pinHash || !pinSalt || !(pinIter > 0)) return false;
    const expected = base64ToBytes(pinHash);
    const actual = await derive(pin, base64ToBytes(pinSalt), pinIter);
    // Constant-time compare.
    let diff = expected.length ^ actual.length;
    const n = Math.max(expected.length, actual.length);
    for (let i = 0; i < n; i++) diff |= (expected[i] | 0) ^ (actual[i] | 0);
    return diff === 0;
  } catch (e) {
    return false;
  }
}

// ---------- exam code ----------

export async function encodeExamCode(config) {
  const payload = toBase64Url(enc.encode(JSON.stringify(config)));
  return `${CODE_PREFIX}.${payload}.${await sha256Hex8(payload)}`;
}

export async function decodeExamCode(code) {
  const s = typeof code === "string" ? code.replace(/\s+/g, "") : "";
  if (!s) return { ok: false, error: INCOMPLETE };
  const parts = s.split(".");
  if (parts[0] !== CODE_PREFIX) {
    return { ok: false, error: CODE_PREFIX.startsWith(s) ? INCOMPLETE : NOT_A_CODE };
  }
  if (parts.length !== 3 || !parts[1] || !/^[0-9a-f]{8}$/i.test(parts[2])) {
    return { ok: false, error: INCOMPLETE };
  }
  const [, payload, check] = parts;
  if ((await sha256Hex8(payload)) !== check.toLowerCase()) return { ok: false, error: INCOMPLETE };

  let config;
  try {
    config = JSON.parse(dec.decode(fromBase64Url(payload)));
  } catch (e) {
    return { ok: false, error: INCOMPLETE };
  }
  if (!config || typeof config !== "object" || Array.isArray(config)) return { ok: false, error: INCOMPLETE };
  if (config.v !== 1) return { ok: false, error: typeof config.v === "number" && config.v > 1 ? TOO_NEW : INCOMPLETE };
  if (typeof config.formUrl !== "string" || !config.formUrl) return { ok: false, error: INCOMPLETE };

  const opts = config.options && typeof config.options === "object" ? config.options : {};
  const merged = { ...DEFAULT_OPTIONS, ...opts };
  merged.categories = Array.isArray(opts.categories)
    ? opts.categories.filter((c) => CATEGORIES.includes(c))
    : DEFAULT_OPTIONS.categories.slice();
  config.options = merged;
  config.allow = Array.isArray(config.allow) ? config.allow.filter((a) => typeof a === "string" && a.trim()) : [];
  if (config.formId === undefined) config.formId = extractFormId(config.formUrl);
  return { ok: true, config };
}
