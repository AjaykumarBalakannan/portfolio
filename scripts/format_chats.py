#!/usr/bin/env python3
"""Pretty-print the chat log that `wrangler d1 execute --json` dumps.

Not run directly. It's the back half of the npm scripts in worker/package.json:

    cd worker && npm run logs        # recent turns, newest first
    cd worker && npm run logs:today  # just today
    cd worker && npm run logs:count  # how many turns and conversations

Wrangler prints the rows wrapped in a big envelope of timing metadata, which
buries the part you actually want to read. This pulls the rows out and formats
them as a conversation.
"""
import json
import sys
import textwrap


def main() -> None:
    raw = sys.stdin.read().strip()
    if not raw:
        sys.exit("no output from wrangler (is the command failing?)")

    # Wrangler prints a banner before the JSON on some versions; find the array.
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
        print("No conversations logged yet.")
        return

    # Count-only queries come back as a single row of numbers.
    if len(rows) == 1 and not any(k in rows[0] for k in ("question", "answer")):
        for k, v in rows[0].items():
            print(f"{k}: {v}")
        return

    wrap = lambda t, i: textwrap.fill(
        t or "", width=88, initial_indent=i, subsequent_indent=" " * len(i)
    )

    last_session = None
    for r in rows:
        session = r.get("session")
        if session and session != last_session:
            print(f"\n{'=' * 88}\nconversation {session}")
            last_session = session
        stamp = (r.get("asked_at") or "")[:19].replace("T", " ")
        turn = r.get("turn")
        meta = " ".join(
            str(x) for x in [stamp, f"turn {turn}" if turn else "", r.get("country") or ""] if x
        )
        print(f"\n  {meta}")
        print(wrap(r.get("question"), "  them: "))
        print(wrap(r.get("answer"), "  ajay: "))

    print(f"\n{'=' * 88}\n{len(rows)} turns shown.")


if __name__ == "__main__":
    main()
