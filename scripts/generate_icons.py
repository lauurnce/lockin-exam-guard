#!/usr/bin/env python3
"""
generate_icons.py - draws the static LockIn toolbar/store icons.

Writes extension/icons/icon-16.png, icon-32.png, icon-48.png and icon-128.png:
a dark-gray (#3F3F46) rounded-square outline with a filled gray (#A1A1AA)
center dot on a transparent background. Uses 4x4 supersampling for smooth
anti-aliased edges. Standard library only (zlib + struct PNG writer), so it
runs on any Python 3.9+ without extra packages.

The runtime icons (green/red states) are drawn by extension/lib/icons.js;
these PNGs are the gray "off" default used by the manifest.

Usage: python3 scripts/generate_icons.py
"""

import math
import os
import struct
import zlib

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT_DIR = os.path.join(ROOT, "extension", "icons")
SIZES = (16, 32, 48, 128)
SS = 4  # supersampling factor per axis

OUTLINE = (0x3F, 0x3F, 0x46)
DOT = (0xA1, 0xA1, 0xAA)


def rounded_rect_sdf(px, py, cx, cy, half, radius):
    """Signed distance from point to a rounded square (negative = inside)."""
    qx = abs(px - cx) - (half - radius)
    qy = abs(py - cy) - (half - radius)
    outside = math.hypot(max(qx, 0.0), max(qy, 0.0))
    inside = min(max(qx, qy), 0.0)
    return outside + inside - radius


def coverage_color(px, py, size):
    """Return (r, g, b, a) in 0..1 for one subsample point in icon space."""
    c = size / 2.0
    # Geometry scales with icon size; stroke never thinner than ~1.2px.
    stroke = max(1.2, size * 0.09)
    half = size / 2.0 - max(0.75, size * 0.04) - stroke / 2.0
    radius = size * 0.24
    dot_r = size * 0.2

    # Center dot (drawn on top of the outline, they never overlap anyway).
    if math.hypot(px - c, py - c) <= dot_r:
        return DOT, 1.0
    # Outline ring = points within stroke/2 of the rounded-square edge.
    d = rounded_rect_sdf(px, py, c, c, half, radius)
    if abs(d) <= stroke / 2.0:
        return OUTLINE, 1.0
    return None, 0.0


def render(size):
    """Render one icon as rows of RGBA bytes (non-premultiplied)."""
    rows = []
    n = SS * SS
    for y in range(size):
        row = bytearray()
        for x in range(size):
            r_sum = g_sum = b_sum = 0.0
            a_sum = 0.0
            for sy in range(SS):
                for sx in range(SS):
                    px = x + (sx + 0.5) / SS
                    py = y + (sy + 0.5) / SS
                    col, a = coverage_color(px, py, size)
                    if a:
                        r_sum += col[0] * a
                        g_sum += col[1] * a
                        b_sum += col[2] * a
                        a_sum += a
            if a_sum:
                r = int(round(r_sum / a_sum))
                g = int(round(g_sum / a_sum))
                b = int(round(b_sum / a_sum))
                alpha = int(round(255 * a_sum / n))
            else:
                r = g = b = alpha = 0
            row += bytes((r, g, b, alpha))
        rows.append(bytes(row))
    return rows


def png_chunk(tag, data):
    body = tag + data
    return struct.pack(">I", len(data)) + body + struct.pack(">I", zlib.crc32(body) & 0xFFFFFFFF)


def write_png(path, size, rows):
    raw = b"".join(b"\x00" + r for r in rows)  # filter type 0 per scanline
    ihdr = struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0)  # 8-bit RGBA
    data = (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", ihdr)
        + png_chunk(b"IDAT", zlib.compress(raw, 9))
        + png_chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(data)


def main():
    os.makedirs(OUT_DIR, exist_ok=True)
    for size in SIZES:
        path = os.path.join(OUT_DIR, "icon-%d.png" % size)
        write_png(path, size, render(size))
        print("wrote", os.path.relpath(path, ROOT))


if __name__ == "__main__":
    main()
