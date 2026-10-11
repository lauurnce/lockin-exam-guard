/*
 * icons.js
 * Draws the toolbar icon at runtime with OffscreenCanvas (16px and 32px):
 * a dark-gray rounded-square outline with a filled center dot in the state
 * color. Also sets the badge (violation count in red when triggered, a gray
 * check mark when submitted, empty otherwise) and the action title.
 * Call updateAction(state) on every state change and on worker startup.
 */

import { COLORS, MODE_COLORS, MODES } from "./constants.js";

function roundedRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function drawIcon(size, color) {
  const canvas = new OffscreenCanvas(size, size);
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, size, size);
  const line = Math.max(1.5, size / 10);
  const inset = line / 2 + size * 0.04;
  roundedRectPath(ctx, inset, inset, size - inset * 2, size - inset * 2, size * 0.22);
  ctx.lineWidth = line;
  ctx.strokeStyle = COLORS.iconOutline;
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(size / 2, size / 2, size * 0.2, 0, Math.PI * 2);
  ctx.fillStyle = color;
  ctx.fill();
  return ctx.getImageData(0, 0, size, size);
}

export function titleFor(state) {
  const mode = (state && state.mode) || MODES.OFF;
  const n = (state && state.violationCount) || 0;
  if (mode === MODES.ARMED) return "LockIn: Locked in";
  if (mode === MODES.TRIGGERED) return `LockIn: ${n} violation${n === 1 ? "" : "s"}`;
  if (mode === MODES.SUBMITTED) return "LockIn: Submitted";
  return "LockIn: Off";
}

export async function updateAction(state) {
  if (!globalThis.chrome || !chrome.action) return;
  const mode = (state && state.mode) || MODES.OFF;
  const color = (MODE_COLORS[mode] || MODE_COLORS.off).main;
  try {
    if (typeof OffscreenCanvas !== "undefined") {
      await chrome.action.setIcon({ imageData: { 16: drawIcon(16, color), 32: drawIcon(32, color) } });
    }
  } catch (e) {
    console.warn("[LockIn] setIcon failed", e);
  }
  try {
    let text = "";
    let bg = COLORS.red;
    if (mode === MODES.TRIGGERED) {
      const n = (state && state.violationCount) || 0;
      text = n > 999 ? "999+" : String(n);
    } else if (mode === MODES.SUBMITTED) {
      text = "✓";
      bg = COLORS.gray;
    }
    await chrome.action.setBadgeText({ text });
    if (text) {
      await chrome.action.setBadgeBackgroundColor({ color: bg });
      if (chrome.action.setBadgeTextColor) await chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
    }
    await chrome.action.setTitle({ title: titleFor(state) });
  } catch (e) {
    console.warn("[LockIn] badge/title failed", e);
  }
}
