#!/usr/bin/env python3
"""Embed data/resume_chunks.json into data/vectors.json via the Gemini API.

Run this locally whenever resume_chunks.json changes. Reads GEMINI_API_KEY
from the environment only -- never pass it as a CLI arg or paste it into a
tracked file.

    GEMINI_API_KEY=... python3 scripts/generate_embeddings.py
"""
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CHUNKS_PATH = ROOT / "data" / "resume_chunks.json"
VECTORS_PATH = ROOT / "data" / "vectors.json"

# GA model, not the -2-preview multimodal one: this is plain text, and task_type
# gives real asymmetric retrieval quality (documents vs. queries embed differently).
MODEL = "gemini-embedding-001"
ENDPOINT = f"https://generativelanguage.googleapis.com/v1beta/models/{MODEL}:embedContent"
OUTPUT_DIMENSIONALITY = 768  # matryoshka-truncated; plenty for ~25 short chunks


def embed(api_key: str, text: str, task_type: str) -> list[float]:
    body = json.dumps({
        "content": {"parts": [{"text": text}]},
        "task_type": task_type,
        "output_dimensionality": OUTPUT_DIMENSIONALITY,
    }).encode()
    req = urllib.request.Request(
        ENDPOINT,
        data=body,
        headers={"Content-Type": "application/json", "x-goog-api-key": api_key},
        method="POST",
    )
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                data = json.loads(resp.read())
                return data["embedding"]["values"]
        except urllib.error.HTTPError as e:
            detail = e.read().decode(errors="replace")
            if e.code == 429 and attempt < 2:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError(f"Gemini API error {e.code}: {detail}") from None
    raise RuntimeError("unreachable")


def main() -> None:
    api_key = os.environ.get("GEMINI_API_KEY")
    if not api_key:
        print("Set GEMINI_API_KEY in your environment first.", file=sys.stderr)
        sys.exit(1)

    chunks = json.loads(CHUNKS_PATH.read_text())
    print(f"Embedding {len(chunks)} chunks with {MODEL} (task_type=RETRIEVAL_DOCUMENT)...")

    vectors = []
    for i, chunk in enumerate(chunks, 1):
        vec = embed(api_key, chunk["text"], "RETRIEVAL_DOCUMENT")
        vectors.append({
            "id": chunk["id"],
            "source": chunk.get("source", ""),
            "text": chunk["text"],
            "embedding": vec,
        })
        print(f"  [{i}/{len(chunks)}] {chunk['id']} -> {len(vec)} dims")
        time.sleep(0.2)  # stay well under free-tier rate limits

    VECTORS_PATH.write_text(json.dumps({
        "model": MODEL,
        "dimensions": OUTPUT_DIMENSIONALITY,
        "vectors": vectors,
    }, indent=2))
    print(f"\nWrote {len(vectors)} vectors to {VECTORS_PATH}")
    print("Commit and push data/vectors.json (and data/resume_chunks.json) so the")
    print("Worker can fetch it from GitHub Pages.")


if __name__ == "__main__":
    main()
