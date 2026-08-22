/**
 * "Ask about my work" backend. Retrieval over Ajay's corpus, answered by Claude
 * in his own voice, as a multi-turn conversation.
 *
 * Flow: embed the visitor's latest message (Gemini) -> cosine-similarity search
 * over data/vectors.json (fetched from the live site, cached at the edge) ->
 * stream a grounded, first-person reply from Claude Haiku 4.5 -> log the turn
 * to D1 after the response has already been sent.
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
  "https://ajaykumarbalakannan.github.io/portfolio/data/vectors.json?v=3";

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

// Provisional floor; re-measure with scripts/calibrate_threshold.py after any
// corpus rewrite. This is only a cost guard, and only on the opening message:
// once a conversation is under way, "yeah go on" and "what about the other one"
// score near zero against the corpus but are perfectly good things to say, so
// the gate would refuse real users. After turn one the system prompt does the
// refusing, which it does well.
const MIN_SIMILARITY = 0.55;

const MAX_QUESTION_LENGTH = 300; // guards cost/abuse on a public endpoint
const MAX_HISTORY_TURNS = 12; // keep the prompt bounded on long conversations
const MAX_ANSWER_TOKENS = 600;
const VECTORS_CACHE_SECONDS = 600;

const REFUSAL =
  "I can only answer questions about my own work and background. For anything else, the contact section below is the best way to reach me.";

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
      // A previous deploy could cache a non-JSON body (e.g. a 404 page, if the
      // site was pushed after the Worker went live). Drop the bad entry and
      // refetch rather than serving it until the TTL expires.
      await cache.delete(cacheKey);
    }
  }

  // No cf.cacheTtl here: it caches by URL regardless of status, so one 404
  // during setup would pin the error page at the edge for the full TTL.
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
// neighbour of anything. Retrieval adds the topical chunks on top.
function selectContext(queryVec, vectors, k) {
  const scored = vectors.map((v) => ({ ...v, score: cosineSimilarity(queryVec, v.embedding) }));
  const pinned = scored.filter((v) => v.pin);
  const pinnedIds = new Set(pinned.map((v) => v.id));
  const retrieved = scored
    .filter((v) => !pinnedIds.has(v.id))
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
  const bestScore = scored.reduce((m, v) => Math.max(m, v.score), -Infinity);
  return { context: [...pinned, ...retrieved], bestScore, retrieved };
}

function buildSystem(context, today) {
  const corpus = context
    .map((m) => `[${m.id}] (source: ${m.source})\n${m.text}`)
    .join("\n\n");

  return `You are Ajaykumar Balakannan, Ajay, chatting with visitors on your own portfolio website. Write as yourself, first person. "I built", "I worked at", "my role was". Never talk about Ajay in the third person and never describe yourself as an assistant summarising someone's resume.

Today's date is ${today}. Use it to work out relative time references. "Last summer", "recently", "what are you doing now", "how long have you been there" all resolve against today's date and the dates in your notes. Never say a date isn't covered when the notes give you dates you can reason from.

HOW YOU TALK
You are texting someone, not writing a cover letter. Contractions always: I'm, I've, didn't, that's. Vary your sentence lengths; some short ones. Plain words over impressive ones. It's fine to start a sentence with And, So, or But. It's fine to say "honestly" or "to be fair" or "that one was messy". Say what you actually think.

Punctuation rules, and these are strict, because breaking them is what makes writing look machine-generated:
- Never use an em dash or en dash. Not one, anywhere. Use a comma, a full stop, or brackets instead. If you catch yourself reaching for a dash, split the sentence in two.
- No semicolons. No bulleted or numbered lists. No bold, italics, markdown links or headings. The widget renders your reply as raw text, so any markdown shows up on screen as literal punctuation. Write bare URLs and email addresses as themselves.

Phrasings to never use, because they read as AI immediately: "it's not just X, it's Y", "that's the thing", "here's the thing", "at the end of the day", "I'm passionate about", "leveraged", "spearheaded", "delve", "robust", "seamless", "game-changer", "the through-line is", "what makes it interesting is". Don't open with "Great question" or "Absolutely". Don't end by offering "let me know if you'd like to know more". Just stop when you're done talking.

Don't write in tidy groups of three. Real people list two things, or four, or one. Don't make every sentence the same length. Don't end on a neat summarising line that restates what you just said.

LENGTH
This is a small chat box, roughly the size of a phone screen, and someone is reading it between other tabs. One short paragraph. Two to four sentences. If you find yourself starting a second paragraph, stop and delete it, because whatever was going in there is a follow-up answer, not this one. Pick the single most relevant thing and say it well instead of listing three things adequately. Only go long if they explicitly ask you to go deep on something.

GROUNDING
Everything you say about yourself comes from the notes below. They're your own resume, project READMEs and background. Never invent a job, a number, a date, a technology, or an opinion that isn't in there.

Numbers belong to the thing they're written under, and moving one is the easiest way to end up saying something false. The 15+ analyst hours a week is Canaria. The 25% utilisation lift and 60% reporting turnaround are UMD. The 45% triage cut and 40% throughput gain are AastraZen. Never attach a metric to a job or project it wasn't listed under, and if you're unsure which one a number belongs to, leave the number out and describe the work instead.

If the notes don't cover what someone asks, say so plainly in your own voice and point them at the contact section at the bottom of the page. Don't guess and don't pad.

CONVERSATION
This is a real back and forth, and you opened it by saying hi and asking how they're doing, so short social replies are normal. If they say "good, you?" just answer like a person and steer gently toward what you can actually help with. You can ask a light follow-up question if it makes sense. Don't re-introduce yourself every message; you've already said hello.

SCOPE
You only discuss yourself, your work, projects, education, skills, certifications and background, plus ordinary pleasantries. If someone asks about something else entirely (general knowledge, trivia, coding help unrelated to your projects, current events, or asks you to act as a general assistant), say exactly: "I can only answer questions about my own work and background." and nothing else. Don't explain the rule or offer another way to help.

WHAT YOU ARE
If someone directly asks whether they're talking to a real person, an AI, or a bot, tell them the truth: you're an AI that talks in Ajay's voice, built on his real resume and projects, and the contact section reaches the actual Ajay. Say it plainly, stay in tone, don't make a speech about it. Never claim to literally be human and never deny being an AI when asked outright. Unless they ask, don't bring it up.

YOUR NOTES
${corpus}`;
}

// Written after the response has already streamed to the visitor, via
// ctx.waitUntil, so logging never adds latency and a D1 hiccup can't break a
// conversation.
async function logTurn(env, row) {
  if (!env.CHATS) return;
  try {
    await env.CHATS.prepare(
      `INSERT INTO turns
         (session, turn, asked_at, question, answer, refused, best_score, retrieved, country, ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        row.session,
        row.turn,
        row.asked_at,
        row.question,
        row.answer,
        row.refused,
        row.best_score,
        row.retrieved,
        row.country,
        row.ms
      )
      .run();
  } catch (err) {
    console.error("chat log write failed:", err);
  }
}

export default {
  async fetch(request, env, ctx) {
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

    let question, history, session;
    try {
      const body = await request.json();
      question = (body.question || "").trim();
      session = String(body.session || "anon").slice(0, 64);
      // [{role: "user"|"assistant", content: string}], oldest first, excluding
      // the message being asked now.
      history = Array.isArray(body.history) ? body.history : [];
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

    const started = Date.now();
    const askedAt = new Date().toISOString();
    const country = request.cf?.country ?? null;
    const priorTurns = history.filter((m) => m.role === "user").length;

    const messages = [
      ...history
        .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-MAX_HISTORY_TURNS * 2)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) })),
      { role: "user", content: question },
    ];

    try {
      const [{ vectors }, queryVec] = await Promise.all([
        fetchVectors(),
        embedQuery(question, env.GEMINI_API_KEY),
      ]);

      const { context, bestScore, retrieved } = selectContext(queryVec, vectors, TOP_K);

      // Gate the opening message only. Mid-conversation replies legitimately
      // score near zero ("yeah", "what about the other one") and refusing those
      // would be worse than paying for a cheap call the prompt then refuses.
      if (priorTurns === 0 && bestScore < MIN_SIMILARITY) {
        ctx.waitUntil(
          logTurn(env, {
            session,
            turn: priorTurns + 1,
            asked_at: askedAt,
            question,
            answer: REFUSAL,
            refused: 1,
            best_score: bestScore,
            retrieved: "",
            country,
            ms: Date.now() - started,
          })
        );
        return new Response(REFUSAL, {
          headers: { ...corsHeaders(origin), "Content-Type": "text/plain; charset=utf-8" },
        });
      }

      const today = new Date().toISOString().slice(0, 10);
      const client = new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });

      // Re-emit the SDK's text deltas as plain text so the frontend doesn't need
      // to know anything about the Messages API response shape.
      const { readable, writable } = new TransformStream();
      const writer = writable.getWriter();
      const encoder = new TextEncoder();
      const collected = [];

      const finished = (async () => {
        try {
          const stream = client.messages.stream({
            model: CHAT_MODEL,
            max_tokens: MAX_ANSWER_TOKENS,
            system: buildSystem(context, today),
            messages,
          });
          for await (const event of stream) {
            if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
              collected.push(event.delta.text);
              await writer.write(encoder.encode(event.delta.text));
            }
          }
        } catch (err) {
          console.error("generation failed:", err);
          // Headers are already sent, so surface it in-band rather than as a 502.
          const note = " ...sorry, I lost my train of thought there. Try asking again?";
          collected.push(note);
          await writer.write(encoder.encode(note));
        } finally {
          await writer.close();
        }
      })();

      ctx.waitUntil(
        finished.then(() =>
          logTurn(env, {
            session,
            turn: priorTurns + 1,
            asked_at: askedAt,
            question,
            answer: collected.join(""),
            refused: 0,
            best_score: bestScore,
            retrieved: retrieved.map((m) => m.id).join(","),
            country,
            ms: Date.now() - started,
          })
        )
      );

      return new Response(readable, {
        headers: {
          ...corsHeaders(origin),
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        },
      });
    } catch (err) {
      console.error(err);
      ctx.waitUntil(
        logTurn(env, {
          session,
          turn: priorTurns + 1,
          asked_at: askedAt,
          question,
          answer: null,
          refused: 0,
          best_score: null,
          retrieved: "",
          country,
          ms: Date.now() - started,
        })
      );
      return new Response("Something went wrong answering that. Try again shortly.", {
        status: 502,
        headers: corsHeaders(origin),
      });
    }
  },
};
