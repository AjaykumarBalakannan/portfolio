#!/usr/bin/env python3
"""Pretty-print the `sessions` table that `wrangler d1 execute --json` dumps.

Not run directly. It's the back half of the npm scripts in worker/package.json:

    cd worker && npm run visitors   # one line per conversation
    cd worker && npm run networks   # which networks people came from
    cd worker && npm run stats      # counts by day

format_chats.py handles the turn-by-turn view; this one handles the
one-row-per-conversation view, which is a table rather than a transcript.
"""
import json
import sys


def main() -> None:
    raw = sys.stdin.read().strip()
    if not raw:
        sys.exit("no output from wrangler (is the command failing?)")

    start = raw.find("[")
    if start == -1:
        sys.exit(raw)
    try:
        payload = json.loads(raw[start:])
    except json.JSONDecodeError:
        sys.exit(raw)

    rows = []
    for block in payload:
        rows.extend(block.get("results", []))

    if not rows:
        print("Nothing yet.")
        return

    cols = list(rows[0].keys())
    # Shorten the two columns that would otherwise blow the width out.
    caps = {"first_question": 46, "session": 20, "network": 28}

    def cell(r, c):
        v = r.get(c)
        v = "" if v is None else str(v)
        cap = caps.get(c)
        if cap and len(v) > cap:
            v = v[: cap - 1] + "…"
        return v

    widths = {c: max(len(c), *(len(cell(r, c)) for r in rows)) for c in cols}
    line = "  ".join(c.ljust(widths[c]) for c in cols)
    print(line)
    print("-" * len(line))
    for r in rows:
        print("  ".join(cell(r, c).ljust(widths[c]) for c in cols))
    print(f"\n{len(rows)} rows.")


if __name__ == "__main__":
    main()
