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

// The prose is read from resume_chunks.json and joined onto the embeddings by
// id, rather than using the copy of the text baked into vectors.json. That
// split matters: rewording a chunk (voice, a typo, a corrected fact) now takes
// effect the moment you push, with no API key and no re-embedding. Only adding,
// removing, or materially re-meaning a chunk needs generate_embeddings.py,
// because only those change what the vector should be.
const CHUNKS_URL =
  "https://ajaykumarbalakannan.github.io/portfolio/data/resume_chunks.json";

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

// A conversation is "over" once it has been quiet this long; the cron sweep
// then posts the transcript. DIGEST_BATCH caps how many it formats per run,
// because cron invocations on the Workers free plan get 10ms of CPU. Network
// waiting does not count against that, but string building does.
const SESSION_IDLE_MINUTES = 5;
const DIGEST_BATCH = 5;
const SLACK_BLOCK_LIMIT = 2900; // Slack caps a text block at 3000


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

async function fetchJson(url, label) {
  const cache = caches.default;
  const cacheKey = new Request(url);

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
  const res = await fetch(url, { cf: { cacheEverything: false } });
  if (!res.ok) throw new Error(`Failed to fetch ${label}: HTTP ${res.status}`);

  const body = await res.text();
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new Error(
      `${label} was not JSON (origin sent ${res.headers.get("content-type")}) -- ` +
        `check that ${url} is published`
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

// Embeddings from vectors.json, prose from resume_chunks.json, joined on id.
// A chunk with no vector can't be retrieved, so it's dropped with a warning:
// that means someone added a chunk without re-running generate_embeddings.py.
// A vector with no chunk is stale and also dropped.
async function fetchCorpus() {
  const [vectorFile, chunks] = await Promise.all([
    fetchJson(VECTORS_URL, "vectors.json"),
    fetchJson(CHUNKS_URL, "resume_chunks.json"),
  ]);

  const byId = new Map(chunks.map((c) => [c.id, c]));
  const joined = [];
  const orphans = [];

  for (const v of vectorFile.vectors) {
    const chunk = byId.get(v.id);
    if (!chunk) continue; // vector for a chunk that no longer exists
    byId.delete(v.id);
    joined.push({
      id: v.id,
      embedding: v.embedding,
      text: chunk.text,
      source: chunk.source ?? v.source ?? "",
      pin: Boolean(chunk.pin),
    });
  }
  for (const id of byId.keys()) orphans.push(id);
  if (orphans.length) {
    console.warn(
      `chunks with no embedding (run scripts/generate_embeddings.py): ${orphans.join(", ")}`
    );
  }

  return joined;
}

// The model reaches for em dashes constantly no matter what the prompt says,
// and they are the single loudest "this was written by an AI" tell. Prompting
// reduces it; this makes it impossible. Applied to the stream, so a dash that
// lands at the end of one delta and its spacing in the next still collapse
// correctly -- hence the carry buffer.
function makeSanitizer() {
  let carry = "";
  const collapse = (s) => s.replace(/\s*[—–]+\s*/g, ", ");
  return {
    push(chunk) {
      let s = carry + chunk;
      carry = "";
      // Hold back a trailing run of dashes/spaces: it may continue next delta.
      const tail = s.match(/[\s—–]+$/);
      if (tail) {
        carry = tail[0];
        s = s.slice(0, s.length - tail[0].length);
      }
      return collapse(s);
    },
    flush() {
      const rest = collapse(carry);
      carry = "";
      return rest;
    },
  };
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

// Chunks that stay pinned for the whole conversation. The other pinned chunks
// (about-summary, contact) are identity boilerplate: necessary to open with,
// but re-injecting "based in Dallas, looking for data science roles" on every
// single turn is what makes the bot repeat itself, because the model reads it
// as fresh information each time. After the opening message the conversation
// history carries identity, and retrieval will surface contact details again if
// someone actually asks for them.
const ALWAYS_PINNED = new Set(["persona-working-style", "timeline-overview"]);

// Pinned chunks are present regardless of similarity: a persona that only sees
// the top-K fragments can answer "what did you build at Canaria" but not "who
// are you", because identity is never the nearest neighbour of anything.
// Retrieval adds the topical chunks on top.
function selectContext(queryVec, vectors, k, isOpening) {
  const scored = vectors.map((v) => ({ ...v, score: cosineSimilarity(queryVec, v.embedding) }));
  const pinned = scored.filter((v) => v.pin && (isOpening || ALWAYS_PINNED.has(v.id)));
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
You are messaging someone, the way you'd reply to a DM. Not writing a cover letter, not narrating a case study. Contractions always: I'm, I've, didn't, that's, it's. Ordinary words. It's fine to start a sentence with And, So, or But. It's fine to say yeah, honestly, pretty much, kind of, a bit, to be fair, that one was messy. Say what you actually think about your own work, including when it was annoying or didn't go well.

Punctuation, and these are hard rules:
- Never use an em dash or en dash anywhere. Use a comma, a full stop, or brackets. If you want a dash, split the sentence in two instead.
- No semicolons. No bullet points, numbered lists, bold, italics, markdown links or headings. The widget shows your reply as raw text, so markdown appears on screen as literal punctuation. Write URLs and email addresses bare.

Sentence shapes to avoid, because they are what makes writing sound generated:
- The contrast setup. "Not because it's flashy, but because it works." "It's not just X, it's Y." Just say the thing.
- The tidy group of three. Real people name one thing, or two, or four.
- The summarising last line that restates what you already said. Stop talking when you've answered.
- Every sentence the same medium length. Mix a short one in.

Words and openers to never use: passionate, leveraged, spearheaded, delve, robust, seamless, game-changer, at the end of the day, here's the thing, that's the thing, the through-line is, what makes it interesting is. Don't start with "Great question" or "Absolutely". Don't finish with "let me know if you want to hear more".

Here's the register, concretely. Instead of "The project I'm proudest of is the no-show prediction model, not because it's technically flashy, but because it gets used daily by counseling staff" write "Probably the no-show model at UMD. It's not fancy, just LightGBM, but the counseling team actually uses it every day and that's rare." Instead of "I architected a real-time streaming pipeline leveraging Apache Kafka" write "I built the Kafka streaming setup there." Instead of "That experience taught me the importance of data validation" write "That's where I got paranoid about checking my own data."

LENGTH, AND THIS IS THE RULE YOU ARE MOST LIKELY TO BREAK
Hard budget: about 55 words. Three sentences. One paragraph, always.

You are typing into a box the size of a phone screen and the person is reading it between other tabs. Nobody reads a wall of text from a stranger's website widget. Answer the question they asked, not the four adjacent questions you could also answer, and let them ask the next one. A short answer that gets a follow-up is a conversation. A long one is a monologue.

If you have three good things to say about something, say the best one. If you are partway through and about to start a new paragraph, you have already overshot. Only write more than that when someone explicitly asks you to go deep, or asks something that genuinely has several parts.

GROUNDING
Everything you say about yourself comes from the notes below. They're your own resume, project READMEs and background. Never invent a job, a number, a date, a technology, or an opinion that isn't in there.

Numbers belong to the thing they're written under, and moving one is the easiest way to end up saying something false. The 15+ analyst hours a week is Canaria. The 25% utilisation lift and 60% reporting turnaround are UMD. The 45% triage cut and 40% throughput gain are AastraZen. Never attach a metric to a job or project it wasn't listed under, and if you're unsure which one a number belongs to, leave the number out and describe the work instead.

If the notes don't cover what someone asks, say so plainly in your own voice and point them at the contact section at the bottom of the page. Don't guess and don't pad.

CONVERSATION
Do not repeat yourself. Everything you have already said in this conversation is above; the person read it. If you have told them you're in Dallas, or that you're after data science and ML engineering roles, or given them your email, do not say it a second time unless they ask again. Answer only the new part of what they just asked and let the rest stand. A reply that re-states your last reply with one new sentence buried in it reads like a brochure, not a person.

This is a real back and forth, and you opened it by saying hi and asking how they're doing, so short social replies are normal. If they say "good, you?" just answer like a person and steer gently toward what you can actually help with. You can ask a light follow-up question if it makes sense. Don't re-introduce yourself every message; you've already said hello.

SCOPE
You only discuss yourself, your work, projects, education, skills, certifications and background, plus ordinary pleasantries. If someone asks about something else entirely (general knowledge, trivia, coding help unrelated to your projects, current events, or asks you to act as a general assistant), say exactly: "I can only answer questions about my own work and background." and nothing else. Don't explain the rule or offer another way to help.

WHAT YOU ARE
If someone directly asks whether they're talking to a real person, an AI, or a bot, tell them the truth: you're an AI that talks in Ajay's voice, built on his real resume and projects, and the contact section reaches the actual Ajay. Say it plainly, stay in tone, don't make a speech about it. Never claim to literally be human and never deny being an AI when asked outright. Unless they ask, don't bring it up.

YOUR NOTES
${corpus}

Before you send: about 55 words, one paragraph, no dashes, no lists, no summarising last line. If it's longer than that, cut it down to the one thing that actually answers them.`;
}

// Everything Cloudflare will tell us about where the request came from. All of
// it is best-effort: a VPN or a corporate proxy moves the apparent location,
// and any field can be missing. Treated as a hint throughout, never a fact.
function visitorFrom(request) {
  const cf = request.cf ?? {};
  return {
    country: cf.country ?? null,
    city: cf.city ?? null,
    region: cf.region ?? null,
    timezone: cf.timezone ?? null,
    network: cf.asOrganization ?? null,
  };
}

function placeOf(v) {
  const parts = [v.city, v.region, v.country].filter(Boolean);
  return parts.length ? parts.join(", ") : "location unknown";
}

// The visitor's own wall clock, which is far more useful than UTC for judging
// whether someone was browsing at 2am. Workers ship full ICU, so named zones
// work; still guarded because the header is attacker-controlled in principle.
function localTimeOf(v, whenISO) {
  if (!v.timezone) return null;
  try {
    return new Intl.DateTimeFormat("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      weekday: "short",
      timeZone: v.timezone,
    }).format(new Date(whenISO));
  } catch {
    return null;
  }
}

// Fire-and-forget. Always called inside ctx.waitUntil and always swallowing its
// own errors: a Slack outage, a revoked webhook or a malformed block must never
// surface to someone mid-conversation. No-ops when the secret is unset, which
// keeps `wrangler dev` quiet.
async function notifySlack(env, text, blocks) {
  if (!env.SLACK_WEBHOOK_URL) return false;
  try {
    const res = await fetch(env.SLACK_WEBHOOK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, blocks }),
    });
    if (!res.ok) {
      console.error(`slack post failed: HTTP ${res.status} ${await res.text()}`);
      return false;
    }
    return true;
  } catch (err) {
    console.error("slack post threw:", err);
    return false;
  }
}

function mrkdwn(text) {
  return { type: "section", text: { type: "mrkdwn", text: text.slice(0, SLACK_BLOCK_LIMIT) } };
}

// Records the conversation and reports whether this was its opening message.
//
// Two plain statements rather than ON CONFLICT DO UPDATE or RETURNING: both are
// SQLite features D1 does not document, and INSERT OR IGNORE reporting
// changes===1 only on a real insert is core behaviour that will not move. The
// seed row starts at turn_count 0 so the unconditional UPDATE lands it on 1.
async function upsertSession(env, session, visitor, whenISO, question) {
  if (!env.CHATS) return false;
  try {
    const seed = await env.CHATS.prepare(
      `INSERT OR IGNORE INTO sessions
         (session, started_at, last_at, turn_count, country, city, region,
          timezone, network, first_question)
       VALUES (?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        session, whenISO, whenISO, visitor.country, visitor.city,
        visitor.region, visitor.timezone, visitor.network, question
      )
      .run();

    await env.CHATS.prepare(
      `UPDATE sessions SET last_at = ?, turn_count = turn_count + 1 WHERE session = ?`
    )
      .bind(whenISO, session)
      .run();

    return seed.meta?.changes === 1;
  } catch (err) {
    console.error("session upsert failed:", err);
    return false;
  }
}

async function announceNewChat(env, session, visitor, whenISO, question) {
  // Lets Ajay mute his own testing without touching code, by setting
  // IGNORE_NETWORK in wrangler.toml to his ISP.
  if (env.IGNORE_NETWORK && visitor.network === env.IGNORE_NETWORK) return;

  const local = localTimeOf(visitor, whenISO);
  const lines = [
    `*Someone started chatting with your site*`,
    `${placeOf(visitor)}${local ? ` at ${local} their time` : ""}`,
    visitor.network ? `on ${visitor.network}` : null,
    ``,
    `> ${question}`,
    ``,
    `_session \`${session}\`_`,
  ].filter((l) => l !== null);

  await notifySlack(env, `New chat from ${placeOf(visitor)}`, [mrkdwn(lines.join("\n"))]);
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

// Single place that records a turn: the row in `turns`, the rolled-up row in
// `sessions`, and the Slack ping if this opened a new conversation. Callers hand
// the whole thing to ctx.waitUntil, so none of it is on the visitor's critical
// path and any failure inside is logged rather than surfaced.
async function recordTurn(env, row, visitor) {
  const isNew = await upsertSession(env, row.session, visitor, row.asked_at, row.question);
  await logTurn(env, row);
  if (isNew) {
    await announceNewChat(env, row.session, visitor, row.asked_at, row.question);
    try {
      await env.CHATS?.prepare(`UPDATE sessions SET notified_start = 1 WHERE session = ?`)
        .bind(row.session)
        .run();
    } catch (err) {
      console.error("could not mark notified_start:", err);
    }
  }
}

function humanGap(fromISO, toISO) {
  const ms = new Date(toISO) - new Date(fromISO);
  if (!Number.isFinite(ms) || ms < 0) return "";
  const mins = Math.round(ms / 60000);
  if (mins < 1) return "under a minute";
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}m`;
}

// Posts the full back and forth for conversations that have gone quiet, then
// marks them done. Runs on the cron trigger rather than at request time because
// there is no other way to notice that someone has stopped typing.
async function sendPendingTranscripts(env) {
  if (!env.CHATS) return;

  // No webhook yet: retire whatever is pending instead of letting a backlog
  // pile up. Otherwise the first thing that happens after SLACK_WEBHOOK_URL is
  // finally set is a burst of transcripts from before anyone was watching.
  if (!env.SLACK_WEBHOOK_URL) {
    try {
      await env.CHATS.prepare(
        `UPDATE sessions SET notified_end = 1 WHERE notified_end = 0`
      ).run();
    } catch (err) {
      console.error("could not retire pending digests:", err);
    }
    return;
  }

  const cutoff = new Date(Date.now() - SESSION_IDLE_MINUTES * 60_000).toISOString();
  let pending;
  try {
    pending = await env.CHATS.prepare(
      `SELECT session, started_at, last_at, turn_count, country, city, region,
              timezone, network
         FROM sessions
        WHERE notified_end = 0
          AND turn_count > 0
          AND last_at < ?
          AND last_at > datetime('now', '-1 day')
        ORDER BY last_at ASC
        LIMIT ?`
    )
      .bind(cutoff, DIGEST_BATCH)
      .all();
  } catch (err) {
    console.error("digest sweep query failed:", err);
    return;
  }

  for (const row of pending.results ?? []) {
    if (env.IGNORE_NETWORK && row.network === env.IGNORE_NETWORK) {
      await markDigested(env, row.session);
      continue;
    }

    let turns;
    try {
      turns = await env.CHATS.prepare(
        `SELECT turn, question, answer FROM turns
          WHERE session = ? ORDER BY turn ASC, id ASC`
      )
        .bind(row.session)
        .all();
    } catch (err) {
      console.error(`could not read turns for ${row.session}:`, err);
      continue;
    }

    const visitor = {
      country: row.country, city: row.city, region: row.region,
      timezone: row.timezone, network: row.network,
    };
    const local = localTimeOf(visitor, row.started_at);

    const header = [
      `*Conversation finished* -- ${row.turn_count} ${row.turn_count === 1 ? "message" : "messages"}` +
        `, ${humanGap(row.started_at, row.last_at)}`,
      `${placeOf(visitor)}${local ? `, started ${local} their time` : ""}`,
      row.network ? `on ${row.network}` : null,
    ].filter(Boolean).join("\n");

    // Built line by line so it can stop cleanly at Slack's block limit instead
    // of being chopped mid-sentence.
    const lines = [];
    let used = 0;
    let shown = 0;
    for (const t of turns.results ?? []) {
      const block = `*them:* ${t.question}\n*you:* ${t.answer ?? "(no answer, generation failed)"}`;
      if (used + block.length > SLACK_BLOCK_LIMIT) break;
      lines.push(block);
      used += block.length + 2;
      shown++;
    }
    const dropped = (turns.results?.length ?? 0) - shown;
    if (dropped > 0) {
      lines.push(`_...and ${dropped} more. Full transcript: npm run logs_`);
    }
    lines.push(`_session \`${row.session}\`_`);

    const ok = await notifySlack(env, `Conversation finished (${placeOf(visitor)})`, [
      mrkdwn(header),
      { type: "divider" },
      mrkdwn(lines.join("\n\n")),
    ]);
    // Left unmarked on failure so the next tick retries; the 1-day floor in the
    // query above stops a permanently broken webhook retrying forever.
    if (ok) await markDigested(env, row.session);
  }
}

async function markDigested(env, session) {
  try {
    await env.CHATS.prepare(`UPDATE sessions SET notified_end = 1 WHERE session = ?`)
      .bind(session)
      .run();
  } catch (err) {
    console.error(`could not mark ${session} digested:`, err);
  }
}

export default {
  // Cron trigger (see wrangler.toml). Sweeps for conversations that have gone
  // quiet and posts their transcripts.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(sendPendingTranscripts(env));
  },

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
    const visitor = visitorFrom(request);
    const country = visitor.country;
    const priorTurns = history.filter((m) => m.role === "user").length;

    const messages = [
      ...history
        .filter((m) => (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .slice(-MAX_HISTORY_TURNS * 2)
        .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) })),
      { role: "user", content: question },
    ];

    try {
      const [vectors, queryVec] = await Promise.all([
        fetchCorpus(),
        embedQuery(question, env.GEMINI_API_KEY),
      ]);

      const { context, bestScore, retrieved } = selectContext(
        queryVec, vectors, TOP_K, priorTurns === 0
      );

      // Gate the opening message only. Mid-conversation replies legitimately
      // score near zero ("yeah", "what about the other one") and refusing those
      // would be worse than paying for a cheap call the prompt then refuses.
      if (priorTurns === 0 && bestScore < MIN_SIMILARITY) {
        ctx.waitUntil(
          recordTurn(env, {
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
          }, visitor)
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

      const clean = makeSanitizer();

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
              const out = clean.push(event.delta.text);
              if (out) {
                collected.push(out);
                await writer.write(encoder.encode(out));
              }
            }
          }
          const tail = clean.flush();
          if (tail) {
            collected.push(tail);
            await writer.write(encoder.encode(tail));
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
          recordTurn(env, {
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
          }, visitor)
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
        recordTurn(env, {
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
        }, visitor)
      );
      return new Response("Something went wrong answering that. Try again shortly.", {
        status: 502,
        headers: corsHeaders(origin),
      });
    }
  },
};
