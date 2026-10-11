"""
Unit tests for the LockIn companion (companion/lockin_host.py).

Standard library only (psutil is optional). Covers: native-messaging framing
helpers, a real host subprocess answering hello -> ready and ping -> pong,
watchlist matching (bundle ID, exe, display name), IGNORE apps and
same-browser-family exclusion.

Run from the repo root:  python3 -m unittest discover companion/tests -v
"""

import io
import json
import os
import struct
import subprocess
import sys
import tempfile
import unittest

COMPANION_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if COMPANION_DIR not in sys.path:
    sys.path.insert(0, COMPANION_DIR)

import lockin_host  # noqa: E402


class FramingTests(unittest.TestCase):
    def test_encode_header_is_native_length(self):
        frame = lockin_host.encode_message({"type": "ping"})
        (n,) = struct.unpack("=I", frame[:4])
        self.assertEqual(n, len(frame) - 4)
        self.assertEqual(json.loads(frame[4:].decode("utf-8")), {"type": "ping"})

    def test_round_trip_multiple_and_unicode(self):
        buf = io.BytesIO()
        msgs = [{"type": "hello", "browserFamily": "Google Chrome"},
                {"type": "x", "text": "caf\u00e9 \u2713"}, {}]
        for m in msgs:
            lockin_host.write_message(buf, m)
        buf.seek(0)
        for m in msgs:
            self.assertEqual(lockin_host.read_message(buf), m)
        self.assertIsNone(lockin_host.read_message(buf))

    def test_truncated_returns_none(self):
        frame = lockin_host.encode_message({"type": "ping"})
        self.assertIsNone(lockin_host.read_message(io.BytesIO(frame[:-2])))
        self.assertIsNone(lockin_host.read_message(io.BytesIO(b"\x01")))


class MatchingTests(unittest.TestCase):
    def setUp(self):
        self.wl = lockin_host.load_watchlist()

    def m(self, **kw):
        return lockin_host.match_app(watchlist=self.wl, **kw)

    def test_word_by_name(self):
        self.assertEqual(self.m(name="Microsoft Word"), "WORD")

    def test_word_by_exe_case_insensitive(self):
        self.assertEqual(self.m(exe="WINWORD.EXE"), "WORD")
        self.assertEqual(self.m(exe=r"C:\Program Files\Microsoft Office\root\Office16\winword.exe"), "WORD")

    def test_notes_by_bundle(self):
        self.assertEqual(self.m(bundle_id="com.apple.Notes"), "NOTES")

    def test_preview_by_name(self):
        self.assertEqual(self.m(name="Preview"), "PDF")

    def test_chatgpt_by_name(self):
        self.assertEqual(self.m(name="ChatGPT"), "AI")

    def test_communication_and_remote(self):
        self.assertEqual(self.m(bundle_id="com.hnc.Discord"), "COMMUNICATION")
        self.assertEqual(self.m(exe="AnyDesk.exe"), "REMOTE")

    def test_unknown_app(self):
        self.assertIsNone(self.m(name="Terminal", bundle_id="com.apple.Terminal"))

    def test_ignore_zoom(self):
        self.assertIsNone(self.m(name="zoom.us", bundle_id="us.zoom.xos"))
        self.assertIsNone(self.m(name="zoom.us"))
        self.assertIsNone(self.m(exe="Zoom.exe"))
        self.assertIsNone(self.m(name="Microsoft Teams"))

    def test_same_browser_excluded(self):
        self.assertEqual(self.m(name="Google Chrome", bundle_id="com.google.Chrome"), "BROWSER")
        self.assertIsNone(self.m(name="Google Chrome", bundle_id="com.google.Chrome",
                                 browser_family="Google Chrome"))
        self.assertIsNone(self.m(exe="chrome.exe", browser_family="Google Chrome"))
        self.assertTrue(lockin_host.is_same_browser(
            bundle_id="com.google.Chrome", browser_family="Google Chrome", watchlist=self.wl))

    def test_other_browser_still_flagged(self):
        self.assertEqual(self.m(name="Safari", bundle_id="com.apple.Safari",
                                browser_family="Google Chrome"), "BROWSER")
        self.assertEqual(self.m(exe="msedge.exe", browser_family="Google Chrome"), "BROWSER")

    def test_category_filter(self):
        self.assertIsNone(self.m(name="Preview", categories=["AI"]))
        self.assertEqual(self.m(name="ChatGPT", categories=["AI"]), "AI")
        self.assertEqual(self.m(name="Microsoft Word", categories=["DOCS"]), "WORD")


class HostProcessTests(unittest.TestCase):
    def test_hello_and_ping(self):
        script = os.path.join(COMPANION_DIR, "lockin_host.py")
        tmp_home = tempfile.mkdtemp(prefix="lockin-test-")
        env = dict(os.environ, HOME=tmp_home, LOCALAPPDATA=tmp_home)
        proc = subprocess.Popen([sys.executable, script], stdin=subprocess.PIPE,
                                stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        try:
            data = (lockin_host.encode_message({"type": "hello", "browserFamily": "Google Chrome"})
                    + lockin_host.encode_message({"type": "ping"}))
            out, err = proc.communicate(data, timeout=20)
        finally:
            if proc.poll() is None:
                proc.kill()
        self.assertEqual(proc.returncode, 0, err.decode("utf-8", "replace"))
        stream = io.BytesIO(out)
        ready = lockin_host.read_message(stream)
        pong = lockin_host.read_message(stream)
        self.assertEqual(ready["type"], "ready")
        self.assertEqual(ready["version"], lockin_host.VERSION)
        self.assertIn(ready["platform"], ("mac", "win", "linux"))
        self.assertEqual(pong, {"type": "pong"})
        # Nothing but framed messages on stdout.
        self.assertIsNone(lockin_host.read_message(stream))
        self.assertEqual(stream.read(), b"")

    def test_version_cli(self):
        script = os.path.join(COMPANION_DIR, "lockin_host.py")
        out = subprocess.check_output([sys.executable, script, "--version"], timeout=20)
        self.assertIn(lockin_host.VERSION, out.decode("utf-8"))


if __name__ == "__main__":
    unittest.main()
