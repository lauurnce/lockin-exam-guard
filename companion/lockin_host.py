#!/usr/bin/env python3
"""
LockIn desktop companion: Chrome native messaging host "com.lockin.companion".

Chrome starts this program on demand (only while LockIn is checking or locked
in) and talks to it over stdin/stdout. Each message is a 4-byte length in
native byte order followed by UTF-8 JSON. Nothing else is ever written to
stdout; diagnostics go to a rotating log file:
  macOS/Linux: ~/.lockin/companion.log    Windows: %LOCALAPPDATA%\\LockIn\\companion.log

What it does (and nothing more): reports which desktop app is frontmost and
which watched apps (Word, Notes, PDF readers, AI apps, other browsers,
messaging and remote-access apps) are running. No screenshots, keystrokes,
window contents or files are read.

Protocol (extension -> host):
  {type:"hello", browserFamily}            -> {type:"ready", version, platform}
  {type:"precheck", categories, browserFamily}
                                           -> {type:"precheck_result", running:[{name, category, bundleId?, exe?}]}
  {type:"arm", categories, browserFamily}  -> start monitoring (only NEW launches are reported)
  {type:"disarm"}                          -> stop monitoring
  {type:"ping"}                            -> {type:"pong"}
Host -> extension, only while armed:
  {type:"frontmost", name, category, isSameBrowser, title?}   (polled every 500 ms, sent on change)
  {type:"app_launched", name, category}                         (scanned every 2 s)

watchlist.json format (JSON has no comments, so it is documented here):
  {
    "version": 1,
    "categories": {
      "<CATEGORY>": {"bundleIds": [...], "exes": [...], "names": [...]}, ...
    },
    "browserFamilies": {
      "<family as sent by the extension, e.g. Google Chrome>":
          {"bundleIds": [...], "exes": [...], "names": [...]}, ...
    }
  }
  Matching order: macOS bundle ID (exact, case-insensitive), then Windows exe
  name (case-insensitive exact), then display name (case-insensitive whole-word
  substring). Category "IGNORE" (Zoom, Teams, Meet) always wins and yields no
  category. Categories are checked in file order. The browser family the
  extension runs in is never flagged; it is reported with isSameBrowser=true.
  The app category WORD is watched when either "WORD" or "DOCS" is enforced.

CLI:
  python3 lockin_host.py --version
  python3 lockin_host.py --diagnose

Python 3.9+ compatible. Standard library plus psutil (optional: without it,
hello/ping still work and the process scan is disabled, with a log warning).
"""

import json
import logging
import logging.handlers
import os
import plistlib
import re
import shutil
import struct
import subprocess
import sys
import threading
import time

VERSION = "1.0.0"
HOST_NAME = "com.lockin.companion"
HERE = os.path.dirname(os.path.abspath(__file__))
WATCHLIST_PATH = os.path.join(HERE, "watchlist.json")
MAX_MESSAGE_BYTES = 1024 * 1024
FRONTMOST_INTERVAL = 0.5
SCAN_EVERY_TICKS = 4  # 4 * 0.5 s = 2 s

log = logging.getLogger("lockin")
log.addHandler(logging.NullHandler())


# ---------------------------------------------------------------------------
# Platform helpers
# ---------------------------------------------------------------------------

def platform_name():
    """Return "mac", "win" or "linux" (same values the extension uses)."""
    if sys.platform == "darwin":
        return "mac"
    if sys.platform.startswith("win"):
        return "win"
    return "linux"


def log_path():
    if platform_name() == "win":
        base = os.environ.get("LOCALAPPDATA") or os.path.expanduser("~")
        return os.path.join(base, "LockIn", "companion.log")
    return os.path.join(os.path.expanduser("~"), ".lockin", "companion.log")


def setup_logging():
    path = log_path()
    try:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        handler = logging.handlers.RotatingFileHandler(
            path, maxBytes=1024 * 1024, backupCount=2, encoding="utf-8")
        handler.setFormatter(logging.Formatter(
            "%(asctime)s %(levelname)s [%(threadName)s] %(message)s"))
        log.addHandler(handler)
        log.setLevel(logging.INFO)
    except Exception:  # logging must never break the host
        pass


_psutil = None
_psutil_tried = False


def get_psutil():
    """Import psutil lazily. Returns the module or None (logged once)."""
    global _psutil, _psutil_tried
    if not _psutil_tried:
        _psutil_tried = True
        try:
            import psutil  # noqa: WPS433
            _psutil = psutil
        except Exception as exc:
            log.warning("psutil is not available (%s); process scan disabled", exc)
            _psutil = None
    return _psutil


# ---------------------------------------------------------------------------
# Framing
# ---------------------------------------------------------------------------

def encode_message(obj):
    """Encode obj as one native-messaging frame (bytes)."""
    data = json.dumps(obj, separators=(",", ":"), ensure_ascii=False).encode("utf-8")
    return struct.pack("=I", len(data)) + data


def _read_exact(stream, n):
    chunks = []
    remaining = n
    while remaining > 0:
        chunk = stream.read(remaining)
        if not chunk:
            return None
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def read_message(stream):
    """Read one framed message from a binary stream. Returns None on EOF."""
    header = _read_exact(stream, 4)
    if header is None:
        return None
    (length,) = struct.unpack("=I", header)
    if length > MAX_MESSAGE_BYTES:
        raise ValueError("message too large: %d bytes" % length)
    body = _read_exact(stream, length) if length else b""
    if body is None:
        return None
    return json.loads(body.decode("utf-8"))


def write_message(stream, obj):
    """Write one framed message to a binary stream and flush."""
    stream.write(encode_message(obj))
    stream.flush()


# ---------------------------------------------------------------------------
# Watchlist and matching
# ---------------------------------------------------------------------------

_watchlist_cache = None

FAMILY_ALIASES = {
    "chrome": "Google Chrome",
    "google chrome": "Google Chrome",
    "edge": "Microsoft Edge",
    "microsoft edge": "Microsoft Edge",
    "msedge": "Microsoft Edge",
    "brave": "Brave",
    "brave browser": "Brave",
    "chromium": "Chromium",
}


def _compile_entry(entry):
    entry = entry or {}
    names = [n for n in entry.get("names", []) if n]
    return {
        "bundleIds": set(b.lower() for b in entry.get("bundleIds", []) if b),
        "exes": set(e.lower() for e in entry.get("exes", []) if e),
        "names": names,
        "nameRes": [re.compile(r"(?<![A-Za-z0-9])" + re.escape(n) + r"(?![A-Za-z0-9])",
                               re.IGNORECASE) for n in names],
    }


def load_watchlist(path=None):
    """Load and compile watchlist.json. Returns a dict usable by match_app."""
    with open(path or WATCHLIST_PATH, "r", encoding="utf-8") as fh:
        raw = json.load(fh)
    return compile_watchlist(raw)


def compile_watchlist(raw):
    if raw.get("compiled"):
        return raw
    cats = []
    for cat, entry in (raw.get("categories") or {}).items():
        cats.append((cat, _compile_entry(entry)))
    fams = {}
    for fam, entry in (raw.get("browserFamilies") or {}).items():
        fams[fam] = _compile_entry(entry)
    return {"compiled": True, "categories": cats, "families": fams}


def default_watchlist():
    global _watchlist_cache
    if _watchlist_cache is None:
        try:
            _watchlist_cache = load_watchlist()
        except Exception as exc:
            log.error("could not load watchlist: %s", exc)
            _watchlist_cache = compile_watchlist({})
    return _watchlist_cache


def _exe_base(exe):
    if not exe:
        return None
    return re.split(r"[\\/]", exe)[-1].lower() or None


def _entry_matches(entry, name, bundle_id, exe_base, use_name=True):
    if bundle_id and bundle_id.lower() in entry["bundleIds"]:
        return True
    if exe_base and exe_base in entry["exes"]:
        return True
    if use_name and name:
        for rx in entry["nameRes"]:
            if rx.search(name):
                return True
    return False


def normalize_family(family, watchlist=None):
    """Map the extension's browserFamily string to a watchlist family key."""
    if not family:
        return None
    wl = compile_watchlist(watchlist) if watchlist else default_watchlist()
    if family in wl["families"]:
        return family
    alias = FAMILY_ALIASES.get(str(family).strip().lower())
    if alias and alias in wl["families"]:
        return alias
    for key in wl["families"]:
        if key.lower() == str(family).strip().lower():
            return key
    return None


def is_same_browser(name=None, bundle_id=None, exe=None, browser_family=None, watchlist=None):
    """True if the app belongs to the browser family the extension runs in."""
    wl = compile_watchlist(watchlist) if watchlist else default_watchlist()
    fam = normalize_family(browser_family, wl)
    if not fam:
        return False
    return _entry_matches(wl["families"][fam], name, bundle_id, _exe_base(exe))


def category_enforced(category, categories):
    """None/absent list means everything; WORD rides along with DOCS."""
    if categories is None:
        return True
    cats = set(categories)
    if category in cats:
        return True
    return category == "WORD" and "DOCS" in cats


def match_app(name=None, bundle_id=None, exe=None, watchlist=None,
              categories=None, browser_family=None):
    """Return the watchlist category for an app, or None.

    Order: bundle ID, then exe name, then display name. IGNORE wins and
    returns None. The extension's own browser family returns None. When
    `categories` is a list, categories not enforced return None.
    """
    wl = compile_watchlist(watchlist) if watchlist else default_watchlist()
    if browser_family and is_same_browser(name, bundle_id, exe, browser_family, wl):
        return None
    exe_base = _exe_base(exe)
    found = None
    # Three passes so a precise identifier always beats a fuzzy name match.
    for mode in ("bundle", "exe", "name"):
        for cat, entry in wl["categories"]:
            if mode == "bundle":
                hit = bool(bundle_id) and bundle_id.lower() in entry["bundleIds"]
            elif mode == "exe":
                hit = bool(exe_base) and exe_base in entry["exes"]
            else:
                hit = bool(name) and any(rx.search(name) for rx in entry["nameRes"])
            if hit:
                found = cat
                break
        if found:
            break
    if not found or found == "IGNORE":
        return None
    if not category_enforced(found, categories):
        return None
    return found


# ---------------------------------------------------------------------------
# macOS bundle info
# ---------------------------------------------------------------------------

_bundle_cache = {}
_bundle_lock = threading.Lock()


def outer_app_path(exe):
    """Return the outermost "*.app" directory containing exe, or None.

    Also accepts "*.app.bundle", which Chrome uses for its code-sign clone
    (the running Chrome exe lives in a temp copy of the bundle).
    """
    if not exe:
        return None
    parts = exe.split("/")
    for i, part in enumerate(parts):
        if part.endswith(".app") or part.endswith(".app.bundle"):
            return "/".join(parts[:i + 1])
    return None


def bundle_info(app_path):
    """Return {"bundleId", "name"} for an .app path (cached by path)."""
    with _bundle_lock:
        if app_path in _bundle_cache:
            return _bundle_cache[app_path]
    stem = os.path.basename(app_path)
    for suffix in (".app.bundle", ".app"):
        if stem.endswith(suffix):
            stem = stem[:-len(suffix)]
            break
    info = {"bundleId": None, "name": stem}
    try:
        with open(os.path.join(app_path, "Contents", "Info.plist"), "rb") as fh:
            pl = plistlib.load(fh)
        if isinstance(pl, dict):
            bid = pl.get("CFBundleIdentifier")
            if isinstance(bid, str):
                info["bundleId"] = bid
            nm = pl.get("CFBundleDisplayName") or pl.get("CFBundleName")
            if isinstance(nm, str) and nm.strip():
                info["name"] = nm.strip()
    except Exception:
        pass
    with _bundle_lock:
        _bundle_cache[app_path] = info
    return info


# ---------------------------------------------------------------------------
# Frontmost app
# ---------------------------------------------------------------------------

def _run(cmd, timeout=2.0):
    try:
        out = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL,
                             stdin=subprocess.DEVNULL, timeout=timeout)
        return out.stdout.decode("utf-8", "replace")
    except Exception:
        return ""


def _frontmost_mac():
    front = _run(["lsappinfo", "front"]).strip()
    m = re.search(r"ASN:0x[0-9a-fA-F]+-0x[0-9a-fA-F]+:?", front)
    if not m:
        return None
    asn = m.group(0)
    text = _run(["lsappinfo", "info", asn])
    if not text:
        return None
    result = {"pid": None, "name": None, "bundleId": None, "exe": None}
    pm = re.search(r'"?pid"?\s*=\s*(\d+)', text)
    if pm:
        result["pid"] = int(pm.group(1))
    nm = re.match(r'\s*"([^"]*)"\s+ASN:', text)
    if nm:
        result["name"] = nm.group(1)
    bm = re.search(r'bundleID="([^"]*)"', text)
    if bm and bm.group(1) not in ("", "[ NULL ]"):
        result["bundleId"] = bm.group(1)
    em = re.search(r'executable path="([^"]*)"', text)
    if em:
        result["exe"] = em.group(1)
    bp = re.search(r'bundle path="([^"]*)"', text)
    app_path = bp.group(1) if bp else outer_app_path(result["exe"])
    ps = get_psutil()
    if ps and result["pid"] and not result["exe"]:
        try:
            result["exe"] = ps.Process(result["pid"]).exe()
        except Exception:
            pass
        app_path = app_path or outer_app_path(result["exe"])
    if app_path:
        info = bundle_info(app_path)
        result["bundleId"] = result["bundleId"] or info["bundleId"]
        result["name"] = result["name"] or info["name"]
    if not result["name"] and result["exe"]:
        result["name"] = os.path.basename(result["exe"])
    if not result["name"]:
        return None
    return result


def _frontmost_windows():
    import ctypes
    from ctypes import wintypes
    user32 = ctypes.windll.user32
    hwnd = user32.GetForegroundWindow()
    if not hwnd:
        return None
    pid = wintypes.DWORD()
    user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
    title = ""
    try:
        length = user32.GetWindowTextLengthW(hwnd)
        buf = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buf, length + 1)
        title = buf.value[:80]
    except Exception:
        pass
    exe = None
    name = None
    ps = get_psutil()
    if ps:
        try:
            proc = ps.Process(pid.value)
            name = proc.name()
            exe = proc.exe()
        except Exception:
            pass
    if not exe:
        try:
            kernel32 = ctypes.windll.kernel32
            handle = kernel32.OpenProcess(0x1000, False, pid.value)  # QUERY_LIMITED_INFORMATION
            if handle:
                size = wintypes.DWORD(1024)
                buf = ctypes.create_unicode_buffer(1024)
                if kernel32.QueryFullProcessImageNameW(handle, 0, buf, ctypes.byref(size)):
                    exe = buf.value
                kernel32.CloseHandle(handle)
        except Exception:
            pass
    if not name and exe:
        name = re.split(r"[\\/]", exe)[-1]
    if not name:
        return None
    return {"pid": pid.value, "name": name, "bundleId": None, "exe": exe or name, "title": title}


def _frontmost_linux():
    if not shutil.which("xdotool"):
        return None
    out = _run(["xdotool", "getactivewindow", "getwindowpid"]).strip()
    if not out.isdigit():
        return None
    pid = int(out)
    ps = get_psutil()
    name = exe = None
    if ps:
        try:
            proc = ps.Process(pid)
            name, exe = proc.name(), proc.exe()
        except Exception:
            pass
    if not name:
        try:
            with open("/proc/%d/comm" % pid, "r") as fh:
                name = fh.read().strip()
        except Exception:
            return None
    return {"pid": pid, "name": name, "bundleId": None, "exe": exe}


def get_frontmost():
    """Return {pid, name, bundleId, exe, title?} for the frontmost app, or None."""
    try:
        plat = platform_name()
        if plat == "mac":
            return _frontmost_mac()
        if plat == "win":
            return _frontmost_windows()
        return _frontmost_linux()
    except Exception as exc:
        log.warning("frontmost detection failed: %s", exc)
        return None


# ---------------------------------------------------------------------------
# Process scan
# ---------------------------------------------------------------------------

def scan_apps():
    """Return a dict key -> {name, bundleId, exe} of running apps.

    On macOS only the main executable of each .app bundle is kept, so helper
    processes collapse into one app and plug-ins/widgets are ignored. Returns
    an empty dict if psutil is missing.
    """
    ps = get_psutil()
    if ps is None:
        return {}
    plat = platform_name()
    apps = {}
    try:
        iterator = ps.process_iter(["pid", "name", "exe"])
    except Exception as exc:
        log.warning("process_iter failed: %s", exc)
        return {}
    for proc in iterator:
        try:
            info = proc.info
            name = info.get("name")
            exe = info.get("exe")
        except (ps.AccessDenied, ps.NoSuchProcess, ps.ZombieProcess):
            continue
        except Exception:
            continue
        if plat == "mac":
            app_path = outer_app_path(exe)
            if not app_path:
                continue
            if os.path.dirname(exe) != app_path + "/Contents/MacOS":
                continue  # helper, XPC service or extension inside the bundle
            binfo = bundle_info(app_path)
            key = (binfo["bundleId"] or app_path).lower()
            if key not in apps:
                apps[key] = {"name": binfo["name"], "bundleId": binfo["bundleId"], "exe": exe}
        else:
            if not name:
                continue
            key = name.lower()
            if key not in apps:
                apps[key] = {"name": name, "bundleId": None, "exe": exe or name}
    return apps


def watched_running(categories=None, browser_family=None, watchlist=None):
    """Return dict key -> {name, category, bundleId?, exe?} for watched apps."""
    result = {}
    for key, app in scan_apps().items():
        cat = match_app(app["name"], app["bundleId"], app["exe"], watchlist,
                        categories, browser_family)
        if not cat:
            continue
        item = {"name": app["name"], "category": cat}
        if app["bundleId"]:
            item["bundleId"] = app["bundleId"]
        elif app["exe"]:
            item["exe"] = re.split(r"[\\/]", app["exe"])[-1]
        result[key] = item
    return result


# ---------------------------------------------------------------------------
# Host runtime
# ---------------------------------------------------------------------------

class Host(object):
    def __init__(self, out_stream):
        self.out = out_stream
        self.write_lock = threading.Lock()
        self.state_lock = threading.Lock()
        self.armed = False
        self.categories = None
        self.browser_family = None
        self.seen = set()
        self.last_front_key = None
        self.stop = threading.Event()

    def send(self, obj):
        with self.write_lock:
            try:
                write_message(self.out, obj)
            except Exception as exc:
                log.error("write failed (%s); exiting", exc)
                os._exit(0)

    # -- message handling --------------------------------------------------
    def handle(self, msg):
        if not isinstance(msg, dict):
            return
        mtype = msg.get("type")
        if msg.get("browserFamily"):
            self.browser_family = msg.get("browserFamily")
        if mtype == "hello":
            log.info("hello from %s", self.browser_family)
            self.send({"type": "ready", "version": VERSION, "platform": platform_name()})
        elif mtype == "ping":
            self.send({"type": "pong"})
        elif mtype == "precheck":
            cats = msg.get("categories")
            running = list(watched_running(cats, self.browser_family).values())
            reply = {"type": "precheck_result", "running": running}
            if get_psutil() is None:
                reply["warning"] = "psutil_missing"
            log.info("precheck: %d watched apps running", len(running))
            self.send(reply)
        elif mtype == "arm":
            cats = msg.get("categories")
            snapshot = set(watched_running(cats, self.browser_family).keys())
            with self.state_lock:
                self.categories = cats
                self.seen = snapshot
                self.last_front_key = None
                self.armed = True
            log.info("armed (categories=%s, baseline=%d)", cats, len(snapshot))
        elif mtype == "disarm":
            with self.state_lock:
                self.armed = False
                self.seen = set()
            log.info("disarmed")
        else:
            log.info("ignoring unknown message type %r", mtype)

    # -- threads -----------------------------------------------------------
    def reader(self, in_stream):
        while True:
            try:
                msg = read_message(in_stream)
            except Exception as exc:
                log.error("bad message: %s", exc)
                break
            if msg is None:
                log.info("stdin closed; exiting")
                break
            try:
                self.handle(msg)
            except Exception as exc:
                log.exception("handler error: %s", exc)
        self.stop.set()

    def check_frontmost(self, cats, family):
        front = get_frontmost()
        if not front:
            return
        key = (front.get("pid"), front.get("name"), front.get("bundleId"))
        if key == self.last_front_key:
            return
        self.last_front_key = key
        same = is_same_browser(front["name"], front.get("bundleId"), front.get("exe"), family)
        cat = None if same else match_app(front["name"], front.get("bundleId"),
                                          front.get("exe"), None, cats, None)
        msg = {"type": "frontmost", "name": front["name"], "category": cat,
               "isSameBrowser": same}
        if front.get("title"):
            msg["title"] = front["title"]
        with self.state_lock:
            if not self.armed:
                return
        self.send(msg)

    def check_launches(self, cats, family):
        current = watched_running(cats, family)
        with self.state_lock:
            if not self.armed:
                return
            new_keys = [k for k in current if k not in self.seen]
            self.seen = set(current.keys())
        for k in new_keys:
            item = current[k]
            log.info("app launched: %s (%s)", item["name"], item["category"])
            self.send({"type": "app_launched", "name": item["name"],
                       "category": item["category"]})

    def monitor(self):
        tick = 0
        while not self.stop.is_set():
            with self.state_lock:
                armed = self.armed
                cats = self.categories
                family = self.browser_family
            if armed:
                try:
                    self.check_frontmost(cats, family)
                    if tick % SCAN_EVERY_TICKS == 0:
                        self.check_launches(cats, family)
                except Exception as exc:
                    log.exception("monitor error: %s", exc)
                tick += 1
            else:
                tick = 0
            self.stop.wait(FRONTMOST_INTERVAL)


def run_host():
    setup_logging()
    in_stream = sys.stdin.buffer
    out_stream = sys.stdout.buffer
    if platform_name() == "win":
        try:
            import msvcrt
            msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
            msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
        except Exception as exc:
            log.warning("could not set binary mode: %s", exc)
    # Anything that accidentally prints must not corrupt the framed stream.
    sys.stdout = sys.stderr
    log.info("LockIn companion %s starting (python %s, %s)",
             VERSION, sys.version.split()[0], platform_name())
    get_psutil()
    default_watchlist()
    host = Host(out_stream)
    mon = threading.Thread(target=host.monitor, name="monitor", daemon=True)
    mon.start()
    rd = threading.Thread(target=host.reader, args=(in_stream,), name="reader", daemon=True)
    rd.start()
    rd.join()
    logging.shutdown()
    os._exit(0)


def run_diagnose():
    print("LockIn companion %s" % VERSION)
    print("Platform: %s (%s)" % (platform_name(), sys.platform))
    print("Python:   %s" % sys.version.split()[0])
    print("psutil:   %s" % ("available" if get_psutil() else "MISSING (pip install psutil)"))
    print("Log file: %s" % log_path())
    print("")
    print("Frontmost app, once per second for 8 seconds (switch apps to test):")
    for _ in range(8):
        front = get_frontmost()
        if front:
            ident = front.get("bundleId") or front.get("exe") or "-"
            cat = match_app(front["name"], front.get("bundleId"), front.get("exe"))
            print("  %-30s %-45s %s" % (front["name"], ident, cat or "-"))
        else:
            print("  (not available)")
        time.sleep(1)
    print("")
    print("Watched apps running now:")
    running = watched_running()
    if not running:
        print("  none" if get_psutil() else "  (process scan needs psutil)")
    for item in sorted(running.values(), key=lambda x: (x["category"], x["name"])):
        print("  %-14s %-30s %s" % (item["category"], item["name"],
                                    item.get("bundleId") or item.get("exe") or ""))


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if "--version" in argv:
        print("LockIn companion %s" % VERSION)
        return 0
    if "--diagnose" in argv:
        setup_logging()
        run_diagnose()
        return 0
    # Chrome passes the caller origin (and on Windows a --parent-window arg).
    run_host()
    return 0


if __name__ == "__main__":
    sys.exit(main())
