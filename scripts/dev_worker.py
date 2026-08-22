#!/usr/bin/env python3
"""Local stand-in for worker/index.js, for testing the chat widget without deploying.

This is DEV ONLY -- it is not what ships. worker/index.js is the real backend.
To avoid the two drifting, the system instruction and the tuning constants are
parsed straight out of worker/index.js rather than duplicated here.

    GEMINI_API_KEY=... python3 scripts/dev_worker.py
    # then open http://localhost:8899 (js/ask.js auto-targets localhost:8787)
"""
import json
import math
import os
import re
import sys
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WORKER_JS = (ROOT / "worker" / "index.js").read_text()
VECTORS = json.loads((ROOT / "data" / "vectors.json").read_text())["vectors"]

PORT = 8787
API_KEY = os.environ.get("GEMINI_API_KEY")


def js_const(name, cast=str):
    m = re.search(rf'const {name} = "?([^";\n]+)"?;', WORKER_JS)
    return cast(m.group(1))


EMBED_MODEL = js_const("EMBED_MODEL")
CHAT_MODEL = js_const("CHAT_MODEL")
DIMS = js_const("OUTPUT_DIMENSIONALITY", int)
TOP_K = js_const("TOP_K", int)
MIN_SIMILARITY = js_const("MIN_SIMILARITY", float)
MAX_Q = js_const("MAX_QUESTION_LENGTH", int)

# Pull the system instruction text out of buildPrompt()'s concatenated string.
_block = re.search(
    r"systemInstruction:\s*\{\s*parts:\s*\[\{\s*text:\s*(.*?)\n\s*\}\],", WORKER_JS, re.S
).group(1)
SYSTEM = "".join(
    p.encode().decode("unicode_escape")
    for p in re.findall(r'"((?:[^"\\]|\\.)*)"', _block)
)

REFUSAL = re.search(r'"(I can only answer questions[^"]*)"', WORKER_JS).group(1)


def gemini(path, body, stream=False):
    url = f"https://generativelanguage.googleapis.com/v1beta/models/{path}"
    if stream:
        url += "?alt=sse"
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json", "x-goog-api-key": API_KEY},
        method="POST",
    )
    return urllib.request.urlopen(req, timeout=90)


def embed_query(q):
    with gemini(
        f"{EMBED_MODEL}:embedContent",
        {
            "content": {"parts": [{"text": q}]},
            "task_type": "RETRIEVAL_QUERY",
            "output_dimensionality": DIMS,
        },
    ) as r:
        return json.loads(r.read())["embedding"]["values"]


def cosine(a, b):
    dot = sum(x * y for x, y in zip(a, b))
    na = math.sqrt(sum(x * x for x in a))
    nb = math.sqrt(sum(y * y for y in b))
    return dot / (na * nb)


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_POST(self):
        try:
            n = int(self.headers.get("Content-Length", 0))
            question = (json.loads(self.rfile.read(n)).get("question") or "").strip()
        except Exception:
            return self._plain(400, "Invalid JSON body.")

        if not question:
            return self._plain(400, "Missing 'question'.")
        if len(question) > MAX_Q:
            return self._plain(400, f"Question too long (max {MAX_Q} chars).")

        try:
            qv = embed_query(question)
        except urllib.error.HTTPError as e:
            return self._plain(502, f"Embedding failed: {e.code} {e.read().decode()[:200]}")

        ranked = sorted(
            ((cosine(qv, v["embedding"]), v) for v in VECTORS), key=lambda t: -t[0]
        )
        top = ranked[:TOP_K]
        best = top[0][0]
        print(f"  q={question!r}\n  top={top[0][1]['id']} sim={best:.3f}", file=sys.stderr)

        if best < MIN_SIMILARITY:
            print("  -> refused pre-LLM\n", file=sys.stderr)
            return self._plain(200, REFUSAL)

        ctx = "\n\n".join(
            f"[{i+1}] ({v['source']})\n{v['text']}" for i, (s, v) in enumerate(top)
        )
        body = {
            "systemInstruction": {"parts": [{"text": SYSTEM}]},
            "contents": [
                {"role": "user", "parts": [{"text": f"Context:\n\n{ctx}\n\nQuestion: {question}"}]}
            ],
            "generationConfig": {
                "maxOutputTokens": 1200,
                "temperature": 0.3,
                "thinkingConfig": {"thinkingLevel": "low"},
            },
        }

        try:
            upstream = gemini(f"{CHAT_MODEL}:streamGenerateContent", body, stream=True)
        except urllib.error.HTTPError as e:
            return self._plain(502, f"Generation failed: {e.code} {e.read().decode()[:200]}")

        self.send_response(200)
        self._cors()
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.end_headers()

        sent = 0
        for raw in upstream:
            line = raw.decode("utf-8", "replace").strip()
            if not line.startswith("data:"):
                continue
            payload = line[5:].strip()
            if not payload or payload == "[DONE]":
                continue
            try:
                parsed = json.loads(payload)
                for part in parsed["candidates"][0]["content"]["parts"]:
                    txt = part.get("text")
                    if txt:
                        self.wfile.write(txt.encode())
                        self.wfile.flush()
                        sent += len(txt)
            except Exception:
                continue
        print(f"  -> streamed {sent} chars\n", file=sys.stderr)

    def _plain(self, code, msg):
        data = msg.encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "text/plain; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):
        pass


if __name__ == "__main__":
    if not API_KEY:
        sys.exit("Set GEMINI_API_KEY in your environment first.")
    print(f"dev worker on http://localhost:{PORT}")
    print(f"  embed={EMBED_MODEL} chat={CHAT_MODEL} dims={DIMS}")
    print(f"  top_k={TOP_K} min_similarity={MIN_SIMILARITY} ({len(VECTORS)} chunks)")
    print("  (dev only -- worker/index.js is what actually ships)\n")
    HTTPServer(("localhost", PORT), Handler).serve_forever()
