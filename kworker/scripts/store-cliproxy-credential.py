"""Copies the CLIProxyAPI gateway's address and key, as T3 gives them to
Claude Code on this machine, into the generic Windows credential
discovery-cliproxy (user name the URL, password the key). The scheduled
drain reads it there, because the Task Scheduler's environment does not
carry Claude Code's. Run it again after the key changes.

  python kworker\\scripts\\store-cliproxy-credential.py [--instance claudeAgent_claude_pool]

The key goes from the settings file to CredWriteW and is never printed.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from kworker import config, wincred  # noqa: E402

SETTINGS = Path.home() / ".t3" / "userdata" / "settings.json"


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--instance", default="claudeAgent_claude_pool", help="T3 provider instance whose environment holds the gateway")
    a = ap.parse_args()
    inst = json.loads(SETTINGS.read_text(encoding="utf-8")).get("providerInstances", {}).get(a.instance)
    if inst is None:
        raise SystemExit(f"{SETTINGS} has no provider instance {a.instance!r}")
    env = {e.get("name"): e.get("value") for e in inst.get("environment") or []}
    url, key = (env.get("ANTHROPIC_BASE_URL") or "").strip().rstrip("/"), (env.get("ANTHROPIC_AUTH_TOKEN") or "").strip()
    if not url or not key:
        raise SystemExit(f"provider instance {a.instance!r} sets no ANTHROPIC_BASE_URL and ANTHROPIC_AUTH_TOKEN")
    wincred.write(config.CLIPROXY_CREDENTIAL, url, key)
    stored = wincred.read(config.CLIPROXY_CREDENTIAL)
    if not stored or stored[0] != url or stored[1] != key:
        raise SystemExit(f"{config.CLIPROXY_CREDENTIAL}: the stored credential does not read back as written")
    print(f"stored {config.CLIPROXY_CREDENTIAL}: gateway {url}, key from {a.instance}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
