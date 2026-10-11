#!/usr/bin/env python3
"""
generate_key.py - gives LockIn a stable Chrome extension ID.

Chrome derives an unpacked extension's ID from the "key" field in
manifest.json. Pinning that key means every "Load unpacked" install gets the
same ID, which the desktop companion's native messaging manifest needs in its
"allowed_origins".

Steps:
  1. Create scripts/.keys/lockin-key.pem with `openssl genrsa` if missing
     (the private key is git-ignored and is never needed by Chrome).
  2. Export the public key as DER with `openssl rsa -pubout -outform DER`.
  3. Write base64(DER) into extension/manifest.json "key" (order and 2-space
     indent preserved).
  4. ID = first 32 hex chars of sha256(DER), each hex digit 0-f mapped to a-p.
     Written to extension/EXTENSION_ID.txt and printed.

Safety: the .pem is git-ignored, so a fresh clone does not have it. If the
.pem is missing but manifest.json already holds a real key, that key is kept
and only EXTENSION_ID.txt is refreshed, so the ID never changes by accident.
Pass --new to force a brand-new key (this changes the extension ID).

Python 3.9 compatible. Needs the `openssl` command line tool (only when a key
has to be created or read from the .pem).
Usage: python3 scripts/generate_key.py [--new]
"""

import base64
import collections
import hashlib
import json
import os
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
KEY_DIR = os.path.join(ROOT, "scripts", ".keys")
PEM_PATH = os.path.join(KEY_DIR, "lockin-key.pem")
MANIFEST_PATH = os.path.join(ROOT, "extension", "manifest.json")
ID_PATH = os.path.join(ROOT, "extension", "EXTENSION_ID.txt")


def run_openssl(args):
    try:
        return subprocess.run(
            ["openssl"] + args, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE
        ).stdout
    except FileNotFoundError:
        sys.exit("error: the `openssl` command was not found. Install OpenSSL and try again.")
    except subprocess.CalledProcessError as exc:
        sys.exit("error: openssl failed: " + exc.stderr.decode("utf-8", "replace").strip())


def extension_id_from_der(der):
    digest = hashlib.sha256(der).hexdigest()[:32]
    return "".join(chr(ord("a") + int(ch, 16)) for ch in digest)


def existing_manifest_key(manifest):
    """Return DER bytes of the key already in manifest.json, or None."""
    value = manifest.get("key", "")
    if not value or value.startswith("<"):
        return None
    try:
        return base64.b64decode(value, validate=True)
    except (ValueError, TypeError):
        return None


def write_id(der):
    ext_id = extension_id_from_der(der)
    with open(ID_PATH, "w", encoding="utf-8") as f:
        f.write(ext_id + "\n")
    print(ext_id)


def main():
    force_new = "--new" in sys.argv[1:]
    with open(MANIFEST_PATH, "r", encoding="utf-8") as f:
        manifest = json.load(f, object_pairs_hook=collections.OrderedDict)

    if not force_new and not os.path.exists(PEM_PATH):
        der = existing_manifest_key(manifest)
        if der is not None:
            print("kept the existing key in manifest.json (no .pem found)", file=sys.stderr)
            write_id(der)
            return

    os.makedirs(KEY_DIR, exist_ok=True)
    if force_new and os.path.exists(PEM_PATH):
        os.remove(PEM_PATH)
    if not os.path.exists(PEM_PATH):
        run_openssl(["genrsa", "-out", PEM_PATH, "2048"])
        os.chmod(PEM_PATH, 0o600)
        print("created", os.path.relpath(PEM_PATH, ROOT), file=sys.stderr)

    der = run_openssl(["rsa", "-in", PEM_PATH, "-pubout", "-outform", "DER"])
    key_b64 = base64.b64encode(der).decode("ascii")

    manifest["key"] = key_b64  # existing key keeps its position
    with open(MANIFEST_PATH, "w", encoding="utf-8") as f:
        json.dump(manifest, f, indent=2, ensure_ascii=False)
        f.write("\n")

    write_id(der)


if __name__ == "__main__":
    main()
