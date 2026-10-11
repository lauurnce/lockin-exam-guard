/*
 * blocked.js
 * Fills in the blocked page from its query string (u = blocked URL,
 * c = category, s = friendly site name, t = timestamp in ms), tells the
 * background the page opened (BLOCKED_PAGE_OPENED, a fallback logger that is a
 * no-op if the attempt was already recorded), and wires "Back to exam" to
 * FOCUS_EXAM, which returns the exam tab to the last allowed form URL.
 */

import { MSG, CATEGORY_LABELS } from "../lib/constants.js";

const params = new URLSearchParams(location.search);
const url = params.get("u") || "";
const category = params.get("c") || "OTHER";
const tsParam = Number(params.get("t"));
const ts = Number.isFinite(tsParam) && tsParam > 0 ? tsParam : Date.now();

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ""); } catch (_) { return ""; }
}

const site = params.get("s") || hostOf(url) || "This site";

document.getElementById("site").textContent = site;
document.getElementById("category").textContent = CATEGORY_LABELS[category] || CATEGORY_LABELS.OTHER;
document.getElementById("when").textContent =
  "Recorded at " + new Date(ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
document.title = `Blocked: ${site}`;

if (url) {
  const urlEl = document.getElementById("url");
  urlEl.textContent = url;
  urlEl.title = url;
  urlEl.hidden = false;
}

async function send(msg) {
  try {
    return await chrome.runtime.sendMessage(msg);
  } catch (_) {
    return null; // extension reloaded or worker unavailable
  }
}

send({ type: MSG.BLOCKED_PAGE_OPENED, url, category });

const back = document.getElementById("back");
back.addEventListener("click", async () => {
  back.disabled = true;
  const res = await send({ type: MSG.FOCUS_EXAM });
  back.disabled = false;
  // If LockIn is no longer running (or the background could not navigate),
  // fall back to going back in history.
  if (!res || !res.ok) history.back();
});
back.focus();
