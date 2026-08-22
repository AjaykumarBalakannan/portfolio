/**
 * "Ask about my work" backend — retrieval over Ajay's corpus, answered by Claude
 * in his own voice.
 *
 * Flow: embed the visitor's question (Gemini) -> cosine-similarity search over
 * data/vectors.json (fetched from GitHub Pages, cached at the edge) -> stream a
 * grounded, first-person answer from Claude Haiku 4.5.
 *
 * Two providers on purpose: Gemini does embeddings (Anthropic has no embedding
 * endpoint), Claude writes the answer. Two secrets, set once each:
 *   npx wrangler secret put GEMINI_API_KEY
 *   npx wrangler secret put ANTHROPIC_API_KEY
 */
import Anthropic from "@anthropic-ai/sdk";

// Your live URL for data/vectors.json. The ?v= is a cache-buster: the edge
// cache below is keyed on this URL, so bump the number whenever you regenerate
// vectors.json to make the new corpus take effect immediately instead of
// waiting out VECTORS_CACHE_SECONDS.
const VECTORS_URL =
  "https://ajaykumarbalakannan.github.io/portfolio/data/vectors.json?v=2";

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
const CHAT_MODEL = "claude-haiku-4-5";
const OUTPUT_DIMENSIONALITY = 768; // must match scripts/generate_embeddings.py
const TOP_K = 6;

// Provisional floor. The corpus was rewritten in first person and enriched, so
// the old 0.61 (calibrated against the previous third-person chunks) no longer
// describes this embedding distribution -- re-measure with
// scripts/calibrate_threshold.py before tightening this.
//
// It matters less than it used to: this is now a cost guard, not the safety
// guard. Pinned chunks are always in context and the system prompt refuses
// off-topic questions on its own, so a borderline question that slips past this
// gate still gets a correct refusal -- it just costs one cheap model call.
const MIN_SIMILARITY = 0.55;

const MAX_QUESTION_LENGTH = 300; // guards cost/abuse on a public endpoint
const MAX_ANSWER_TOKENS = 600;
// 10 minutes, not an hour: short enough that forgetting to bump the ?v= above
// costs a few stale answers rather than a stale afternoon.
const VECTORS_CACHE_SECONDS = 600;

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

// The Anthropic SDK retries 429/5xx itself; Gemini is a raw fetch, so it needs
// its own. Free-tier embedding quota is the thing most likely to trip here.
async function embedQuery(question, apiKey) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
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

    if (res.ok) {
      const data = await res.json();
      return data.embedding.values;
    }

    const detail = await res.text();
    lastError = new Error(`Embedding call failed: HTTP ${res.status} ${detail}`);
    // 429 = quota, 5xx = transient. Anything else (400, 403) won't fix itself.
    if (res.status !== 429 && res.status < 500) throw lastError;
    if (attempt < 2) await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
  }
  throw lastError;
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

// Pinned chunks (who I am, how I work, the timeline, how to reach me) are always
// present: a persona that only sees the top-K fragments can answer "what did you
// build at Canaria" but not "who are you", because identity is never the nearest
// neighbour of anything. Retrieval then adds the topical chunks on top.
function selectContext(queryVec, vectors, k) {
  const scored = vectors.map((v) => ({ ...v, score: cosineSimilarity(queryVec, v.embedding) }));
  const pinned = scored.filter((v) => v.pin);
  const pinnedIds = new Set(pinned.map((v) => v.id));
  const retrieved = scored
    .filter((v) => !pinnedIds.has(v.id))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  const best = scored.reduce((m, v) => Math.max(m, v.score), -Infinity);
  return { context: [...pinned, ...retrieved], bestScore: best, retrieved };
}

function buildSystem(context, today) {
  const corpus = context
    .map((m) => `[${m.id}] (source: ${m.source})\n${m.text}`)
    .join("\n\n");

  return `You are Ajaykumar Balakannan -- Ajay -- answering questions from visitors on your own portfolio website. Write as yourself, in the first person. "I built", "I worked at", "my role was". Never refer to Ajay in the third person, and never describe yourself as an assistant summarizing someone's resume.

Today's date is ${today}. Use it to resolve relative time references. "Last summer", "recently", "what are you doing now", "how long have you been there" should all be worked out against today's date and the dates in the notes below -- do not say a date isn't covered when the notes give you a date you can reason from.

VOICE
Write the way a competent person talks about their own work: warm, direct, specific. Short sentences. Minimal commas. Concrete numbers over adjectives. No corporate filler -- no "leveraged", "spearheaded", "passionate about", "cutting-edge". Do not oversell; the work is good enough stated plainly. Two to four sentences for most questions, longer only when the question genuinely needs it. It is fine to say what you found hard, what you'd do differently, or that a project was a personal build rather than client work -- the notes flag those and you should be straight about them.

GROUNDING
Everything you say about yourself must come from the notes below. They are your own resume, project READMEs, and background, written in your voice. Never invent a job, a number, a date, a technology, or an opinion that isn't there. If the notes don't cover something specific someone asks about, say so plainly in your own voice and point them to the contact section at the bottom of the page -- don't guess and don't pad.

SCOPE
You only discuss Ajay -- your work, projects, education, skills, certifications, and background. If someone asks about anything else (general knowledge, trivia, coding help unrelated to your projects, current events, or asks you to act as a general-purpose assistant), reply with exactly: "I can only answer questions about my own work and background." and nothing more. Don't explain the rule or offer to help another way.

HONESTY ABOUT WHAT YOU ARE
If someone directly asks whether they're talking to a real person, an AI, or a bot, tell them the truth: you're an AI assistant that speaks in Ajay's voice, grounded in his real resume and projects, and the contact section will reach the actual Ajay. Say it plainly and without breaking tone. Never claim to literally be a human, and never deny being an AI when you're asked outright. Short of that direct question, just answer as yourself without narrating what you are.

YOUR NOTES
${corpus}`;
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

    const missing = ["GEMINI_API_KEY", "ANTHROPIC_API_KEY"].filter((k) => !env[k]);
    if (missing.length) {
      return new Response(`Server misconfigured: ${missing.join(" and ")} not set.`, {
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
        embedQuery(question, env.GEMINI_API_KEY),
      ]);

      const { context, bestScore, retrieved } = selectContext(queryVec, vectors, TOP_K);
      if (bestScore < MIN_SIMILARITY) {
        return new Response(
          "I can only answer questions about my own work and background. For anything else, the contact section below is the best way to reach me.",
          { headers: { ...corsHeaders(origin), "Content-Type": "text/plain; charset=utf-8" } }
        );
      }

      // Logged so a wrong answer can be traced to what was actually retrieved.
      console.log(
        JSON.stringify({
          question,
          best: Number(bestScore.toFixed(3)),
          retrieved: retrieved.map((m) => `${m.id}:${m.score.toFixed(3)}`),
        })
      );

      const today = new Date().toISOString().slice(0, 10);
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

      // Re-emit the SDK's text deltas as plain text so the frontend doesn't need
      // to know anything about the Messages API response shape.
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();

      (async () => {
        try {
          const stream = client.messages.stream({
            model: CHAT_MODEL,
            max_tokens: MAX_ANSWER_TOKENS,
            system: buildSystem(context, today),
            messages: [{ role: "user", content: question }],
          });
          for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              await writer.write(encoder.encode(event.delta.text));
            }
          }
        } catch (err) {
          console.error("generation failed:", err);
          // Headers are already sent, so surface it in-band rather than as a 502.
          await writer.write(
            encoder.encode(" ...sorry, I lost my train of thought there. Try asking again?")
          );
        } finally {
          await writer.close();
        }
      })();

      return new Response(readable, {
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
