"""
generate_readme_art.py
Writes the animated SVGs used by README.md into assets/readme/:
  header-light.svg / header-dark.svg  the moving banner (icon cycles off -> locked in -> triggered -> submitted)
  flow-light.svg / flow-dark.svg      "How it works" diagram with events travelling between the parts
Colors match extension/lib/constants.js. Animation is plain CSS/SMIL inside the
SVG, so it plays on GitHub (which shows SVGs as images) and stops under
prefers-reduced-motion. Run: python3 scripts/generate_readme_art.py
"""

from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "assets" / "readme"

THEMES = {
    "light": {
        "bg": "#F4F4F5", "surface": "#FFFFFF", "text": "#18181B", "muted": "#71717A",
        "border": "#E4E4E7", "gray": "#A1A1AA", "green": "#16A34A", "green_soft": "#DCFCE7",
        "red": "#DC2626", "red_soft": "#FEE2E2", "outline": "#3F3F46", "ink": "#52525B",
    },
    "dark": {
        "bg": "#09090B", "surface": "#18181B", "text": "#FAFAFA", "muted": "#A1A1AA",
        "border": "#27272A", "gray": "#71717A", "green": "#16A34A", "green_soft": "#052E16",
        "red": "#DC2626", "red_soft": "#450A0A", "outline": "#D4D4D8", "ink": "#A1A1AA",
    },
}

FONT = "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif"
MONO = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"

# One 12s loop in four equal phases: off, locked in, triggered, submitted.
PHASE_KEYFRAMES = """
  @keyframes p0 { 0%, 22% { opacity: 1 } 25%, 97% { opacity: 0 } 100% { opacity: 1 } }
  @keyframes p1 { 0%, 22% { opacity: 0 } 25%, 47% { opacity: 1 } 50%, 100% { opacity: 0 } }
  @keyframes p2 { 0%, 47% { opacity: 0 } 50%, 72% { opacity: 1 } 75%, 100% { opacity: 0 } }
  @keyframes p3 { 0%, 72% { opacity: 0 } 75%, 97% { opacity: 1 } 100% { opacity: 0 } }
  .p0 { animation: p0 12s infinite; opacity: 0 }
  .p1 { animation: p1 12s infinite; opacity: 1 }
  .p2 { animation: p2 12s infinite; opacity: 0 }
  .p3 { animation: p3 12s infinite; opacity: 0 }
"""

PHASES = [
    # (state word, explanation, chip fill, chip ink, sheet label, sheet color)
    ("Off", "LockIn does nothing", "bg", "ink", "OFF", "gray"),
    ("Locked in", "exam running, nothing flagged", "green_soft", "green", "ARMED", "green"),
    ("Triggered", "1 violation logged · chatgpt.com", "red_soft", "red", "TRIGGERED", "red"),
    ("Submitted", "form sent, LockIn turns off", "bg", "ink", "SUBMITTED", "gray"),
]


def header(c):
    chips = []
    for i, (word, why, fill, ink, _, _) in enumerate(PHASES):
        chips.append(f"""
    <g class="p{i}">
      <rect x="300" y="248" width="460" height="40" rx="20" fill="{c[fill]}" stroke="{c['border']}"/>
      <circle cx="324" cy="268" r="6" fill="{c[ink]}"/>
      <text x="340" y="274" font-size="17" fill="{c['text']}"><tspan font-weight="650">{word}</tspan><tspan fill="{c['muted']}"> · {why}</tspan></text>
    </g>""")

    sheet_cells = []
    for i, (_, _, _, _, label, color) in enumerate(PHASES):
        sheet_cells.append(f"""
      <g class="p{i}">
        <rect x="952" y="160" width="118" height="26" rx="6" fill="{c[color]}"/>
        <text x="1011" y="178" font-size="12.5" font-weight="700" fill="#FFFFFF" text-anchor="middle" font-family="{MONO}">{label}</text>
      </g>""")

    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="380" viewBox="0 0 1200 380" role="img" aria-labelledby="t d">
  <title id="t">LockIn</title>
  <desc id="d">The LockIn icon cycles through its four states: off (gray), locked in (green, pulsing), triggered (red) and submitted (gray with a check mark), while the professor's Live Status sheet updates to match.</desc>
  <style>
  text {{ font-family: {FONT} }}
  {PHASE_KEYFRAMES}
  @keyframes tint {{
    0%, 22% {{ fill: {c['bg']} }} 25%, 47% {{ fill: {c['green_soft']} }}
    50%, 72% {{ fill: {c['red_soft']} }} 75%, 97% {{ fill: {c['bg']} }} 100% {{ fill: {c['bg']} }}
  }}
  @keyframes dot {{
    0%, 22% {{ fill: {c['gray']} }} 25%, 47% {{ fill: {c['green']} }}
    50%, 72% {{ fill: {c['red']} }} 75%, 97% {{ fill: {c['gray']} }} 100% {{ fill: {c['gray']} }}
  }}
  @keyframes pulse {{ 0% {{ transform: scale(1); opacity: .6 }} 100% {{ transform: scale(1.9); opacity: 0 }} }}
  @keyframes bar {{ 0% {{ transform: scaleX(0) }} 100% {{ transform: scaleX(1) }} }}
  @keyframes blink {{ 0%, 60% {{ opacity: 1 }} 61%, 100% {{ opacity: 0 }} }}
  .tint {{ animation: tint 12s infinite; fill: {c['green_soft']} }}
  .dot {{ animation: dot 12s infinite; fill: {c['green']} }}
  .ring {{ animation: pulse 2s ease-out infinite; transform-box: fill-box; transform-origin: center }}
  .bar {{ animation: bar 3s linear infinite, dot 12s infinite; transform-box: fill-box; transform-origin: left; fill: {c['green']} }}
  .live {{ animation: blink 1.2s infinite }}
  @media (prefers-reduced-motion: reduce) {{
    * {{ animation: none !important }}
    .bar {{ transform: scaleX(1) }}
  }}
  </style>

  <rect class="tint" width="1200" height="380" rx="24"/>
  <rect x="32" y="32" width="1136" height="316" rx="20" fill="{c['surface']}" stroke="{c['border']}"/>

  <!-- Icon: rounded-square outline with a state-colored dot, as drawn by extension/lib/icons.js -->
  <g transform="translate(96 110)">
    <rect x="8" y="8" width="144" height="144" rx="34" fill="none" stroke="{c['outline']}" stroke-width="14"/>
    <g class="p1"><circle class="ring" cx="80" cy="80" r="32" fill="none" stroke="{c['green']}" stroke-width="6"/></g>
    <circle class="dot" cx="80" cy="80" r="32"/>
    <g class="p2"><rect x="76" y="62" width="8" height="24" rx="4" fill="#FFFFFF"/><circle cx="80" cy="96" r="4.5" fill="#FFFFFF"/></g>
    <g class="p3"><path d="M66 81 l10 10 l19 -21" fill="none" stroke="#FFFFFF" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/></g>
  </g>

  <text x="296" y="160" font-size="76" font-weight="700" letter-spacing="-2.5" fill="{c['text']}">LockIn</text>
  <text x="300" y="198" font-size="21" fill="{c['muted']}">Minimalist exam lockdown for Google Forms.</text>
  <text x="300" y="226" font-size="21" fill="{c['muted']}">Make cheating visible, not impossible.</text>
  {''.join(chips)}

  <!-- Professor's Live Status sheet -->
  <g>
    <rect x="800" y="84" width="300" height="196" rx="14" fill="{c['surface']}" stroke="{c['border']}"/>
    <text x="822" y="116" font-size="14" font-weight="650" fill="{c['text']}">Live Status</text>
    <g class="live"><circle cx="1040" cy="111" r="4" fill="{c['red']}"/></g>
    <text x="1050" y="116" font-size="11" font-weight="700" fill="{c['muted']}" font-family="{MONO}">LIVE</text>
    <line x1="800" y1="132" x2="1100" y2="132" stroke="{c['border']}"/>
    <text x="822" y="152" font-size="11" fill="{c['muted']}" font-family="{MONO}">STUDENT</text>
    <text x="952" y="152" font-size="11" fill="{c['muted']}" font-family="{MONO}">STATUS</text>
    <text x="822" y="178" font-size="14" fill="{c['text']}">Student 01</text>
    {''.join(sheet_cells)}
    <text x="822" y="216" font-size="14" fill="{c['text']}">Student 02</text>
    <rect x="952" y="198" width="118" height="26" rx="6" fill="{c['green']}"/>
    <text x="1011" y="216" font-size="12.5" font-weight="700" fill="#FFFFFF" text-anchor="middle" font-family="{MONO}">ARMED</text>
    <text x="822" y="254" font-size="14" fill="{c['text']}">Student 03</text>
    <rect x="952" y="236" width="118" height="26" rx="6" fill="{c['green']}"/>
    <text x="1011" y="254" font-size="12.5" font-weight="700" fill="#FFFFFF" text-anchor="middle" font-family="{MONO}">ARMED</text>
  </g>

  <rect x="96" y="310" width="1004" height="4" rx="2" fill="{c['border']}"/>
  <rect class="bar" x="96" y="310" width="1004" height="4" rx="2"/>
</svg>
"""


def node(c, x, y, w, title, sub, accent=None):
    stripe = f'<rect x="{x}" y="{y + 18}" width="4" height="54" rx="2" fill="{accent}"/>' if accent else ""
    return f"""
  <g>
    <rect x="{x}" y="{y}" width="{w}" height="90" rx="14" fill="{c['surface']}" stroke="{c['border']}"/>
    {stripe}
    <text x="{x + 22}" y="{y + 40}" font-size="18" font-weight="650" fill="{c['text']}">{title}</text>
    <text x="{x + 22}" y="{y + 64}" font-size="13.5" fill="{c['muted']}">{sub}</text>
  </g>"""


def packet(path, color, dur, begin, r=6):
    return f"""
  <circle r="{r}" fill="{color}" opacity="0">
    <animateMotion dur="{dur}s" begin="{begin}s" repeatCount="indefinite" path="{path}"/>
    <animate attributeName="opacity" dur="{dur}s" begin="{begin}s" repeatCount="indefinite" values="0;1;1;0" keyTimes="0;.1;.85;1"/>
  </circle>"""


def flow(c):
    # Edge paths (centers of node sides)
    form_ext = "M340 145 L460 145"
    ext_form = "M460 145 L340 145"
    ext_comp = "M740 145 L860 145"
    comp_ext = "M860 145 L740 145"
    ext_apps = "M600 190 L600 290"
    apps_sheet = "M740 335 L860 335"

    def edge(d, label, lx, ly, anchor="middle"):
        return f"""
  <path d="{d}" stroke="{c['gray']}" stroke-width="2" stroke-dasharray="5 6" fill="none"/>
  <text x="{lx}" y="{ly}" font-size="12.5" fill="{c['muted']}" text-anchor="{anchor}" font-family="{MONO}">{label}</text>"""

    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="430" viewBox="0 0 1200 430" role="img" aria-labelledby="t d">
  <title id="t">How LockIn works</title>
  <desc id="d">The extension watches the Google Form tab, talks to the desktop companion over native messaging, and sends events and a heartbeat to a Google Apps Script web app, which writes them into the professor's Google Sheet.</desc>
  <style>
  text {{ font-family: {FONT} }}
  @media (prefers-reduced-motion: reduce) {{ circle[opacity="0"] {{ display: none }} }}
  </style>
  <rect width="1200" height="430" rx="24" fill="{c['bg']}"/>

  <rect x="36" y="34" width="1128" height="176" rx="18" fill="none" stroke="{c['gray']}" stroke-dasharray="2 6" stroke-width="1.5"/>
  <text x="58" y="66" font-size="12.5" font-weight="700" letter-spacing="1" fill="{c['muted']}" font-family="{MONO}">STUDENT'S COMPUTER</text>
  <text x="1142" y="400" font-size="12.5" font-weight="700" letter-spacing="1" fill="{c['muted']}" text-anchor="end" font-family="{MONO}">PROFESSOR</text>

  {edge(form_ext, "tabs · sites · paste", 400, 132)}
  {edge(ext_comp, "native msg", 800, 132)}
  {edge(ext_apps, "events + heartbeat, 1/min (optional)", 614, 245, "start")}
  {edge(apps_sheet, "rows", 800, 322)}

  {node(c, 60, 100, 280, "Google Form", "the exam tab")}
  {node(c, 460, 100, 280, "LockIn extension", "switch, rules, status", c['green'])}
  {node(c, 860, 100, 280, "Desktop companion", "Word, Notes, PDF, ChatGPT app")}
  {node(c, 460, 290, 280, "Apps Script web app", "/exec endpoint")}
  {node(c, 860, 290, 280, "Google Sheet", "Events · Live Status", c['green'])}

  {packet(form_ext, c['green'], 2.2, 0)}
  {packet(ext_form, c['gray'], 2.2, 1.1)}
  {packet(comp_ext, c['green'], 2.6, 0.4)}
  {packet(ext_comp, c['gray'], 2.6, 1.7)}
  {packet(ext_apps, c['green'], 2.0, 0.2)}
  {packet(ext_apps, c['red'], 6.0, 3.0)}
  {packet(apps_sheet, c['green'], 2.0, 1.2)}
</svg>
"""


def main():
    OUT.mkdir(parents=True, exist_ok=True)
    for name, c in THEMES.items():
        (OUT / f"header-{name}.svg").write_text(header(c))
        (OUT / f"flow-{name}.svg").write_text(flow(c))
    print(f"wrote 4 SVGs to {OUT}")


if __name__ == "__main__":
    main()
