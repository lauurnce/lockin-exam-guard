/*
 * rules.js
 * Pure URL classification for LockIn (SPEC section 7). Decides whether a URL
 * is allowed during an exam (the exam form, sign-in pages, professor's extra
 * allowlist) or blocked, and if blocked, which category it falls in (AI,
 * SEARCH, DOCS, ...). Also exports isEnforced(), which tells the background
 * whether a blocked category is actually enforced by this exam's settings.
 * No chrome.* calls here, so it runs unchanged in node tests.
 */

import { CATEGORIES, DEFAULT_OPTIONS, FORM_ID_REGEX } from "./constants.js";

// Ordered category map. host = exact host or subdomain suffix; path = optional
// path prefix; exact = host must match exactly (no subdomains).
const SITE_RULES = [
  // AI
  { cat: "AI", host: "chatgpt.com", site: "ChatGPT" },
  { cat: "AI", host: "chat.openai.com", site: "ChatGPT" },
  { cat: "AI", host: "openai.com", site: "OpenAI" },
  { cat: "AI", host: "gemini.google.com", site: "Gemini" },
  { cat: "AI", host: "bard.google.com", site: "Gemini" },
  { cat: "AI", host: "aistudio.google.com", site: "Google AI Studio" },
  { cat: "AI", host: "notebooklm.google.com", site: "NotebookLM" },
  { cat: "AI", host: "claude.ai", site: "Claude" },
  { cat: "AI", host: "copilot.microsoft.com", site: "Copilot" },
  { cat: "AI", host: "perplexity.ai", site: "Perplexity" },
  { cat: "AI", host: "poe.com", site: "Poe" },
  { cat: "AI", host: "deepseek.com", site: "DeepSeek" },
  { cat: "AI", host: "meta.ai", site: "Meta AI" },
  { cat: "AI", host: "grok.com", site: "Grok" },
  { cat: "AI", host: "x.ai", site: "Grok" },
  { cat: "AI", host: "character.ai", site: "Character.AI" },
  { cat: "AI", host: "you.com", site: "You.com" },
  { cat: "AI", host: "phind.com", site: "Phind" },
  { cat: "AI", host: "quillbot.com", site: "QuillBot" },
  { cat: "AI", host: "chat.mistral.ai", site: "Le Chat (Mistral)" },
  { cat: "AI", host: "huggingface.co", path: "/chat", site: "HuggingChat" },
  { cat: "AI", host: "blackbox.ai", site: "Blackbox AI" },
  // SEARCH
  { cat: "SEARCH", host: "google.com", path: "/search", exact: true, site: "Google Search" },
  { cat: "SEARCH", host: "www.google.com", exact: true, site: "Google Search" },
  { cat: "SEARCH", host: "bing.com", site: "Bing" },
  { cat: "SEARCH", host: "duckduckgo.com", site: "DuckDuckGo" },
  { cat: "SEARCH", host: "search.yahoo.com", site: "Yahoo Search" },
  { cat: "SEARCH", host: "search.brave.com", site: "Brave Search" },
  { cat: "SEARCH", host: "ecosia.org", site: "Ecosia" },
  // HOMEWORK
  { cat: "HOMEWORK", host: "brainly.ph", site: "Brainly" },
  { cat: "HOMEWORK", host: "brainly.com", site: "Brainly" },
  { cat: "HOMEWORK", host: "quizlet.com", site: "Quizlet" },
  { cat: "HOMEWORK", host: "coursehero.com", site: "Course Hero" },
  { cat: "HOMEWORK", host: "chegg.com", site: "Chegg" },
  { cat: "HOMEWORK", host: "studocu.com", site: "Studocu" },
  { cat: "HOMEWORK", host: "scribd.com", site: "Scribd" },
  { cat: "HOMEWORK", host: "numerade.com", site: "Numerade" },
  { cat: "HOMEWORK", host: "symbolab.com", site: "Symbolab" },
  { cat: "HOMEWORK", host: "photomath.com", site: "Photomath" },
  { cat: "HOMEWORK", host: "wolframalpha.com", site: "Wolfram|Alpha" },
  // DOCS
  { cat: "DOCS", host: "docs.google.com", path: "/document", site: "Google Docs" },
  { cat: "DOCS", host: "docs.google.com", path: "/spreadsheets", site: "Google Sheets" },
  { cat: "DOCS", host: "docs.google.com", path: "/presentation", site: "Google Slides" },
  { cat: "DOCS", host: "drive.google.com", site: "Google Drive" },
  { cat: "DOCS", host: "office.com", site: "Microsoft Office" },
  { cat: "DOCS", host: "word.cloud.microsoft", site: "Word online" },
  { cat: "DOCS", host: "officeapps.live.com", site: "Office online" },
  { cat: "DOCS", host: "onedrive.live.com", site: "OneDrive" },
  { cat: "DOCS", host: "sharepoint.com", site: "SharePoint" },
  { cat: "DOCS", host: "dropbox.com", site: "Dropbox" },
  // NOTES
  { cat: "NOTES", host: "keep.google.com", site: "Google Keep" },
  { cat: "NOTES", host: "notion.so", site: "Notion" },
  { cat: "NOTES", host: "notion.site", site: "Notion" },
  { cat: "NOTES", host: "onenote.com", site: "OneNote" },
  { cat: "NOTES", host: "evernote.com", site: "Evernote" },
  { cat: "NOTES", host: "icloud.com", site: "iCloud" },
  { cat: "NOTES", host: "obsidian.md", site: "Obsidian" },
  { cat: "NOTES", host: "simplenote.com", site: "Simplenote" },
  // COMMUNICATION
  { cat: "COMMUNICATION", host: "messenger.com", site: "Messenger" },
  { cat: "COMMUNICATION", host: "facebook.com", site: "Facebook" },
  { cat: "COMMUNICATION", host: "web.whatsapp.com", site: "WhatsApp" },
  { cat: "COMMUNICATION", host: "discord.com", site: "Discord" },
  { cat: "COMMUNICATION", host: "web.telegram.org", site: "Telegram" },
  { cat: "COMMUNICATION", host: "mail.google.com", site: "Gmail" },
  { cat: "COMMUNICATION", host: "outlook.live.com", site: "Outlook" },
  { cat: "COMMUNICATION", host: "x.com", site: "X" },
  { cat: "COMMUNICATION", host: "twitter.com", site: "X" },
  { cat: "COMMUNICATION", host: "instagram.com", site: "Instagram" },
  { cat: "COMMUNICATION", host: "tiktok.com", site: "TikTok" },
  { cat: "COMMUNICATION", host: "reddit.com", site: "Reddit" },
  { cat: "COMMUNICATION", host: "youtube.com", site: "YouTube" },
];

const DEFAULT_ALLOW_HOSTS = ["accounts.google.com", "accounts.youtube.com", "forms.gle"];

const SETTINGS_PREFIXES = [
  "chrome://", "edge://", "brave://", "opera://", "vivaldi://", "about:",
  "view-source:", "devtools://", "chrome-search://", "chrome-untrusted://",
];

function result(allowed, category, site) {
  return { allowed, category, site: site || "" };
}

function hostMatches(host, ruleHost, exact) {
  if (host === ruleHost) return true;
  return !exact && host.endsWith("." + ruleHost);
}

function pathMatches(pathname, prefix) {
  if (!prefix) return true;
  const p = prefix.replace(/\/+$/, "");
  if (!p) return true;
  return pathname === p || pathname.startsWith(p + "/");
}

// Turns an allow entry like "https://www.desmos.com/calculator/" into
// { host: "desmos.com", path: "/calculator" }. Returns null when empty.
function parseAllowEntry(entry) {
  if (typeof entry !== "string") return null;
  let s = entry.trim().toLowerCase();
  if (!s) return null;
  s = s.replace(/^[a-z][a-z0-9+.-]*:\/\//, "").replace(/^\*\./, "").replace(/^www\./, "");
  const slash = s.indexOf("/");
  let host = slash === -1 ? s : s.slice(0, slash);
  const path = slash === -1 ? "" : s.slice(slash).split(/[?#]/)[0];
  host = host.replace(/:\d+$/, "");
  if (!host) return null;
  return { host, path };
}

function isAboutBlank(lower) {
  return /^about:(blank|srcdoc)([?#].*)?$/.test(lower);
}

export function classifyUrl(url, ctx) {
  const c = ctx || {};
  const raw = url == null ? "" : String(url).trim();
  const lower = raw.toLowerCase();

  // 1. Transitional blank pages.
  if (!raw || isAboutBlank(lower)) return result(true, "TRANSITIONAL", "");

  // 2. Our own extension pages.
  const origin = (c.extensionOrigin || "").replace(/\/+$/, "").toLowerCase();
  if (origin && (lower === origin || lower.startsWith(origin + "/"))) {
    const path = lower.slice(origin.length).split(/[?#]/)[0];
    if (path === "/blocked/blocked.html") return result(true, "BLOCKED_PAGE", "LockIn");
    if (path === "/options/options.html" || path.endsWith("/options.html")) {
      return result(false, "OWN_OPTIONS", "LockIn setup");
    }
    return result(true, "ALLOWED", "LockIn");
  }

  // 3. Browser internals and other extensions.
  if (lower.startsWith("chrome-extension://") || SETTINGS_PREFIXES.some((p) => lower.startsWith(p))) {
    const m = raw.match(/^([a-z-]+:(?:\/\/)?[^/?#]*)/i);
    return result(false, "SETTINGS", m ? m[1] : raw.slice(0, 60));
  }

  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return result(false, "OTHER", raw.slice(0, 60));
  }

  let pathname = u.pathname || "/";
  try {
    pathname = decodeURIComponent(pathname);
  } catch (e) { /* keep raw pathname */ }
  const pathLower = pathname.toLowerCase();

  // 4. Local files.
  if (u.protocol === "file:") {
    const name = pathname.split("/").filter(Boolean).pop() || "Local file";
    return pathLower.endsWith(".pdf") ? result(false, "PDF", name) : result(false, "LOCAL_FILE", name);
  }

  const host = (u.hostname || "").toLowerCase().replace(/\.$/, "");
  if (!host) return result(false, "OTHER", raw.slice(0, 60));

  // 5. The exam form.
  if (host === "docs.google.com" && pathLower.startsWith("/forms/")) {
    const m = u.pathname.match(FORM_ID_REGEX);
    if (!c.formId || (m && m[1] === c.formId)) return result(true, "EXAM", "Google Forms");
  }

  // 6. Default allowlist and professor's extra sites.
  if (DEFAULT_ALLOW_HOSTS.some((h) => host === h)) return result(true, "ALLOWED", host);
  const allow = Array.isArray(c.allow) ? c.allow : [];
  for (const entry of allow) {
    const a = parseAllowEntry(entry);
    if (a && hostMatches(host, a.host, false) && pathMatches(pathLower, a.path)) {
      return result(true, "ALLOWED", host);
    }
  }

  // 7. Blocked: find the category.
  if (pathLower.endsWith(".pdf")) {
    return result(false, "PDF", pathname.split("/").filter(Boolean).pop() || host);
  }
  for (const r of SITE_RULES) {
    if (hostMatches(host, r.host, r.exact) && pathMatches(pathLower, r.path)) {
      return result(false, r.cat, r.site);
    }
  }
  if (host.includes("chatgpt")) return result(false, "AI", "ChatGPT");
  if (host === "docs.google.com" && pathLower.startsWith("/forms/")) {
    return result(false, "OTHER", "Google Forms");
  }
  return result(false, "OTHER", host);
}

// True when a blocked URL of this category must be acted on for this exam.
// The 9 professor-selectable CATEGORIES are enforced only when listed;
// anything else (SETTINGS, LOCAL_FILE, OWN_OPTIONS, OTHER, ...) always is.
export function isEnforced(category, categories) {
  if (!CATEGORIES.includes(category)) return true;
  const list = Array.isArray(categories) ? categories : DEFAULT_OPTIONS.categories;
  return list.includes(category);
}
