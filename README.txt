Ajay — Portfolio (interactive 3D particle intro)

WHAT'S HERE
  index.html        the page
  css/style.css     styles
  js/intro.js       the interactive WebGL particle gate (three.js)
  js/site.js        typewriter, staggered scroll reveal, card accents, k-means tile
  libs/three.module.min.js   three.js, self-hosted (no CDN needed)
  assets/ajay.jpg   your photo (swap this file to change it)

  Logos (self-hosted, no hotlinking):
  assets/logo-umd.svg        University of Maryland
  assets/logo-skcet.png      Sri Krishna College (wide lockup; CSS crops to the
                             crest via .mark.logo.crest)
  assets/logo-microsoft.svg  Microsoft four-square mark (wordmark stripped so it
                             stays legible at badge size)
  assets/cert-aws-saa.png    AWS Solutions Architect Associate credential badge
  assets/logo-aws.svg        AWS logo (spare, not currently placed)

  Canaria and AastraZen have no publicly available logo file, so they use the
  designed monogram marks instead. Drop a logo in and swap the <span class="mark
  s2"> for the same <span class="mark logo"><img ...></span> pattern to upgrade.

DEPLOY
  It's a static site served from the repo root -- commit + push and it's live.
  The canonical site is https://ajaykumarbalakannan.com, served by Cloudflare;
  https://ajaykumarbalakannan.github.io/portfolio/ is a parallel GitHub Pages
  copy of the same repo, and the Worker fetches data/vectors.json from it.
  Both origins are in the Worker's ALLOWED_ORIGINS.

  Because it uses ES modules, open it via a URL, not by double-clicking the
  file locally.

ASK ABOUT MY WORK (chatbot)
  A widget on the site answers visitor questions in Ajay's own voice, using
  only real content from data/resume_chunks.json -- work history, projects
  (with real architecture pulled from each project's GitHub README), company
  background, certifications, coursework. It never invents facts: the model is
  told to answer only from the notes it is given, and to point at the contact
  section when something isn't covered.

  Two providers, on purpose:
    Gemini  embeds the question (Anthropic has no embedding endpoint)
    Claude  writes the answer (claude-haiku-4-5)

  Pieces:
  data/resume_chunks.json          the knowledge base (edit this to add/change facts)
  data/vectors.json                generated -- do not hand-edit (see below)
  scripts/generate_embeddings.py   embeds resume_chunks.json into vectors.json
  scripts/calibrate_threshold.py   measures the on-topic/off-topic score gap
  worker/index.js                  Cloudflare Worker: retrieval + Claude
  worker/wrangler.toml             Worker deploy config
  js/ask.js                        frontend widget (talks to the deployed Worker)

  Setup:

  1. Get the two API keys
     Gemini    https://aistudio.google.com/apikey  ("Create API key")
     Anthropic https://console.anthropic.com       (API keys -> Create key)
     Neither key goes in a tracked file. They live in your shell environment
     (step 2) and the Cloudflare secret store (step 4), nowhere else.

  2. Generate the embeddings (run locally, needs the Gemini key)
       cd portfolio
       GEMINI_API_KEY=your-key python3 scripts/generate_embeddings.py
     This writes data/vectors.json. Re-run it any time you edit
     resume_chunks.json, then commit and push both JSON files.

  3. Push the repo
     The Worker fetches vectors.json over HTTP at answer time, so the file has
     to be live before the chatbot works.

  4. Deploy the Worker
       cd worker
       npm install
       npx wrangler login
       npx wrangler secret put GEMINI_API_KEY
       npx wrangler secret put ANTHROPIC_API_KEY
       npx wrangler deploy
     Deploy prints the Worker URL. It is already wired into js/ask.js.

  5. Point the URLs at your deployments, if they ever move
     worker/index.js:  VECTORS_URL, ALLOWED_ORIGINS
     js/ask.js:        DEPLOYED_WORKER_URL

  Testing locally:
       cd portfolio && python3 -m http.server 8899     # terminal 1: the site
       cd worker && npx wrangler dev                   # terminal 2: the backend
     wrangler dev serves the real Worker on :8787, which is what js/ask.js
     targets when it sees localhost -- so this exercises the code that actually
     ships, not an imitation of it. Put both keys in worker/.dev.vars
     (gitignored) as KEY=value lines.

  Pinned chunks: entries in resume_chunks.json with "pin": true are sent to the
  model on every question regardless of similarity. That is what keeps the
  persona coherent -- identity is never the nearest neighbour of anything, so
  "who are you" would otherwise retrieve four unrelated project chunks.
  Currently pinned: about-summary, persona-working-style, timeline-overview,
  contact.

  Relative dates: the Worker injects today's date into the system prompt, and
  timeline-overview spells out the chronology. Without both, "what did you do
  last summer" fails even though the Canaria dates are right there -- the model
  has no way to know what year it is.

  Threshold tuning: MIN_SIMILARITY in worker/index.js refuses a question before
  paying for a model call. It must be re-measured whenever resume_chunks.json
  changes, because rewriting the corpus moves the embedding distribution:
       GEMINI_API_KEY=... python3 scripts/calibrate_threshold.py
  It scores a set of real and junk questions and suggests a value. It is only a
  cost guard -- the system prompt refuses off-topic questions on its own, so err
  low rather than wrongly refusing real questions.

  Cost: roughly $0.004 per question at claude-haiku-4-5 rates ($1 per million
  input tokens, $5 per million output) -- about $4 per thousand questions.
  Prompt caching is deliberately not used: Haiku 4.5 needs a 4096-token cached
  prefix to qualify, and the stable part of this prompt is well under that, so
  adding cache_control would silently do nothing.

  Note on the earlier Gemini-only build: generation ran on the Gemini free tier,
  which caps at 20 requests per quota window. A public portfolio exhausts that
  almost immediately -- every question past the cap returned "Couldn't reach the
  assistant". That is why answers moved to a paid Claude key. Embeddings stayed
  on Gemini: one short call per question, well inside the free tier.

  To add a fact: add an entry to data/resume_chunks.json, re-run step 2,
  commit+push both JSON files.

THE INTRO
  Particles assemble into drifting clusters, react to your cursor (move to
  orbit, click to pulse), then burst apart when you hit "Enter portfolio"
  (or auto-skip). Reduced-motion visitors skip straight to the page.

TWEAKS
  - Replace your photo: drop a new image in as assets/ajay.jpg
