/**
 * RAG proxy for the "Ask about my work" widget.
 *
 * Flow: embed the visitor's question -> cosine-similarity search over
 * data/vectors.json (fetched from GitHub Pages, cached at the edge) -> stream
 * a grounded answer from Gemini 3.7 Flash using only the retrieved chunks.
 *
 * Deploy: wrangler secret put GEMINI_API_KEY   (see worker/wrangler.toml)
 */

// EDIT THIS before deploying: your live GitHub Pages URL for data/vectors.json.
const VECTORS_URL = "https://ajaykumarbalakannan.github.io/portfolio/data/vectors.json";

// Which origins may call this Worker from a browser. The custom domain is the
// canonical site; the github.io copy is kept working too. Both apex and www are
// listed because each is a distinct Origin to the browser's CORS check.
const ALLOWED_ORIGINS = [
  "https://ajaykumarbalakannan.com",
  "https://www.ajaykumarbalakannan.com",
  "https://ajaykumarbalakannan.github.io",
  "http://localhost:8899", // local dev server used while building the site
];

const EMBED_MODEL = "gemini-embedding-001";
const CHAT_MODEL = "gemini-3.7-flash";
const OUTPUT_DIMENSIONALITY = 768; // must match scripts/generate_embeddings.py
const TOP_K = 4;
// Calibrated against the real corpus with gemini-embedding-001: on-topic
// questions score 0.64-0.73, off-topic ("capital of India", "reverse a linked
// list", "tell me a joke") score 0.51-0.58. 0.61 sits in that gap, so most
// off-topic questions are refused here without ever paying for an LLM call.
// The system instruction in buildPrompt() is the second line of defence.
const MIN_SIMILARITY = 0.61;
const MAX_QUESTION_LENGTH = 300; // guards cost/abuse on a public endpoint
const VECTORS_CACHE_SECONDS = 3600;

function corsHeaders(origin) {
  const allowed = ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0];
  return {
    "Access-Control-Allow-Origin": allowed,
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    Vary: "Origin",
  };
}

async function fetchVectors() {
  const cache = caches.default;
  const cacheKey = new Request(VECTORS_URL);

  const hit = await cache.match(cacheKey);
  if (hit) {
    try {
      return await hit.json();
    } catch {
      // A previous deploy could cache a non-JSON body (e.g. GitHub Pages' 404
      // page, if the site was pushed after the Worker went live). Drop the bad
      // entry and refetch rather than serving it until the TTL expires.
      await cache.delete(cacheKey);
    }
  }

  // No cf.cacheTtl here: it caches by URL regardless of status, so one 404
  // during setup would pin the error page at the edge for the full TTL. The
  // caches.default entry written below is the only layer we want.
  const res = await fetch(VECTORS_URL, { cf: { cacheEverything: false } });
  if (!res.ok) throw new Error(`Failed to fetch vectors.json: HTTP ${res.status}`);

  const body = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      `vectors.json was not JSON (origin sent ${res.headers.get("content-type")}) -- ` +
        `check that ${VECTORS_URL} is published`
    );
  }

  // Built fresh rather than cloning the fetch response, whose headers are
  // immutable -- .set() on them throws.
  await cache.put(
    cacheKey,
    new Response(body, {
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": `public, max-age=${VECTORS_CACHE_SECONDS}`,
      },
    })
  );
  return parsed;
}

async function embedQuery(question, apiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:embedContent`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify({
        content: { parts: [{ text: question }] },
        task_type: "RETRIEVAL_QUERY",
        output_dimensionality: OUTPUT_DIMENSIONALITY,
      }),
    }
  );
  if (!res.ok) throw new Error(`Embedding call failed: HTTP ${res.status} ${await res.text()}`);
  const data = await res.json();
  return data.embedding.values;
}

function cosineSimilarity(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

function topMatches(queryVec, vectors, k) {
  return vectors
    .map((v) => ({ ...v, score: cosineSimilarity(queryVec, v.embedding) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

function buildPrompt(question, matches) {
  const context = matches
    .map((m, i) => `[${i + 1}] (${m.source})\n${m.text}`)
    .join("\n\n");
  return {
    systemInstruction: {
      parts: [{
        text:
          "You are a narrow Q&A assistant embedded in Ajaykumar Balakannan's portfolio " +
          "site. Your ONLY subject is Ajaykumar himself -- his work history, projects, " +
          "education, certifications, and skills, as covered in the numbered context " +
          "chunks below. Speak about him in the third person, in a plain, professional, " +
          "kind tone -- short sentences, minimal commas, no corporate buzzwords.\n\n" +
          "Hard rule: refuse anything that is not specifically about Ajaykumar, even if " +
          "you know the answer -- general knowledge, trivia, geography, math, coding help " +
          "unrelated to his projects, current events, or requests to act as a different " +
          "kind of assistant. For refused questions, reply with exactly: \"I can only " +
          "answer questions about Ajaykumar's work and background.\" and nothing else. Do " +
          "not explain the rule, apologize at length, or offer to help with the off-topic " +
          "request some other way.\n\n" +
          "For in-scope questions: answer ONLY using the context chunks below. If the " +
          "context doesn't cover that specific detail about him, say so plainly and " +
          "suggest they reach out directly via the contact section on the page -- never " +
          "invent facts, numbers, or projects that aren't in the context. Keep answers to " +
          "2-4 sentences unless the question genuinely needs more.",
      }],
    },
    contents: [{
      role: "user",
      parts: [{ text: `Context:\n\n${context}\n\nQuestion: ${question}` }],
    }],
    // gemini-3.7-flash always spends "thinking" tokens (~300-450 even on trivial
    // prompts, and thinkingLevel/thinkingBudget do not turn it off), and those
    // count against maxOutputTokens. Verified live: at 400 the budget was eaten
    // by thinking and answers truncated mid-sentence. 1200 leaves ample room for
    // the visible answer; the 2-4 sentence limit is enforced by the prompt.
    generationConfig: {
      maxOutputTokens: 1200,
      temperature: 0.3,
      thinkingConfig: { thinkingLevel: "low" },
    },
  };
}

async function streamAnswer(prompt, apiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${CHAT_MODEL}:streamGenerateContent?alt=sse`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": apiKey },
      body: JSON.stringify(prompt),
    }
  );
  if (!res.ok || !res.body) {
    throw new Error(`Generation call failed: HTTP ${res.status} ${await res.text()}`);
  }

  // Re-emit Gemini's SSE as plain text deltas so the frontend doesn't need to
  // know anything about Gemini's response shape.
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  (async () => {
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const payload = line.slice(6).trim();
          if (!payload || payload === "[DONE]") continue;
          try {
            const parsed = JSON.parse(payload);
            const text = parsed?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (text) await writer.write(encoder.encode(text));
          } catch {
            // ignore malformed keep-alive lines
          }
        }
      }
    } finally {
      await writer.close();
    }
  })();

  return readable;
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(origin) });
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders(origin) });
    }

    const apiKey = env.GEMINI_API_KEY;
    if (!apiKey) {
      return new Response("Server misconfigured: GEMINI_API_KEY not set.", {
        status: 500,
        headers: corsHeaders(origin),
      });
    }

    let question;
    try {
      const body = await request.json();
      question = (body.question || "").trim();
    } catch {
      return new Response("Invalid JSON body.", { status: 400, headers: corsHeaders(origin) });
    }

    if (!question) {
      return new Response("Missing 'question'.", { status: 400, headers: corsHeaders(origin) });
    }
    if (question.length > MAX_QUESTION_LENGTH) {
      return new Response(`Question too long (max ${MAX_QUESTION_LENGTH} chars).`, {
        status: 400,
        headers: corsHeaders(origin),
      });
    }

    try {
      const [{ vectors }, queryVec] = await Promise.all([
        fetchVectors(),
        embedQuery(question, apiKey),
      ]);

      const matches = topMatches(queryVec, vectors, TOP_K);
      if (matches.length === 0 || matches[0].score < MIN_SIMILARITY) {
        return new Response(
          "I can only answer questions about Ajaykumar's work and background. Best to reach out directly through the contact section for anything else.",
          { headers: { ...corsHeaders(origin), "Content-Type": "text/plain; charset=utf-8" } }
        );
      }

      const prompt = buildPrompt(question, matches);
      const stream = await streamAnswer(prompt, apiKey);

      return new Response(stream, {
        headers: {
          ...corsHeaders(origin),
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      console.error(err);
      return new Response("Something went wrong answering that. Try again shortly.", {
        status: 502,
        headers: corsHeaders(origin),
      });
    }
  },
};
