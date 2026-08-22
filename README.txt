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

DEPLOY (GitHub Pages)
  Put all of these at the repo root, keeping the folder structure exactly.
  Commit + push. It's a static site. Because it uses ES modules, open it
  via a URL (GitHub Pages), not by double-clicking the file locally.

ASK ABOUT MY WORK (RAG chatbot)
  A widget on the site (#ask) answers visitor questions using only real
  content from data/resume_chunks.json -- work history, projects (with real
  architecture pulled from each project's GitHub README), certifications,
  coursework. It never invents facts: retrieval below a similarity threshold
  returns a "not covered, use the contact section" message instead of
  guessing.

  Pieces:
  data/resume_chunks.json      the knowledge base (edit this to add/change facts)
  data/vectors.json            generated -- do not hand-edit (see below)
  scripts/generate_embeddings.py   embeds resume_chunks.json into vectors.json
  worker/index.js              Cloudflare Worker: retrieval + Gemini 3.7 Flash
  worker/wrangler.toml         Worker deploy config
  js/ask.js                    frontend widget (talks to the deployed Worker)

  Setup -- five steps, in order:

  1. Get a free Gemini API key
     https://aistudio.google.com/apikey -- "Create API key". Do not paste
     this key into chat with any AI assistant, commit it to git, or put it
     in a tracked file. It only ever goes into two places: your local shell
     environment (step 2) and the Cloudflare Worker secret store (step 4).

  2. Generate the embeddings (run locally, needs the key from step 1)
       cd portfolio
       pip install --user requests   # only dependency; stdlib does the rest
       GEMINI_API_KEY=your-key-here python3 scripts/generate_embeddings.py
     This writes data/vectors.json. Re-run it any time you edit
     resume_chunks.json (new job, new project, updated numbers, etc).

  3. Push the repo and enable GitHub Pages
     Commit index.html, css/, js/, data/ (including vectors.json -- it's
     public info, same as the resume already on the page) and push.
     Repo Settings -> Pages -> Deploy from a branch -> main -> / (root).
     Note the exact live URL GitHub gives you -- you need it in step 5.

  4. Deploy the Cloudflare Worker
       npm install -g wrangler        # or use npx wrangler for each command
       cd worker
       npx wrangler login
       npx wrangler secret put GEMINI_API_KEY   # paste the key when prompted
       npx wrangler deploy
     Deploy prints your Worker's URL, something like:
       https://portfolio-rag.<your-subdomain>.workers.dev

  5. Point the two placeholder URLs at your real deployments
     worker/index.js:
       - VECTORS_URL       -> the exact vectors.json URL from step 3
       - ALLOWED_ORIGINS    -> your real GitHub Pages origin (and any custom domain)
     js/ask.js:
       - WORKER_URL         -> the Worker URL from step 4
     Redeploy the Worker (npx wrangler deploy) and push the site again after
     editing these.

  Testing locally without deploying anything:
       cd portfolio
       python3 -m http.server 8899                     # terminal 1: the site
       GEMINI_API_KEY=... python3 scripts/dev_worker.py # terminal 2: the backend
     Then open http://localhost:8899 -- js/ask.js detects localhost and talks to
     the dev worker on :8787 instead of the deployed Worker, so the widget works
     end-to-end before step 4 below. dev_worker.py parses its models, thresholds
     and system prompt directly out of worker/index.js so the two cannot drift.
     It is a dev tool only; worker/index.js is what actually ships.

  Guardrail tuning (already calibrated against the real corpus -- only revisit
  if you significantly change resume_chunks.json):
    Measured with gemini-embedding-001, on-topic questions score 0.64-0.73
    similarity and off-topic ones ("capital of India", "reverse a linked list",
    "tell me a joke") score 0.51-0.58. MIN_SIMILARITY in worker/index.js is set
    to 0.61, inside that gap, so off-topic questions are refused before any LLM
    call is paid for. The system instruction is the second line of defence.
    Re-run the probe if answers start getting wrongly refused.

  Note on maxOutputTokens: gemini-3.7-flash always spends ~300-450 "thinking"
  tokens (thinkingLevel/thinkingBudget do not disable this) and they count
  against maxOutputTokens. It is set to 1200 -- at 400 answers truncated
  mid-sentence.

  Cost: Gemini's free tier covers casual portfolio traffic (the embedding
  call and gemini-3.7-flash both have generous free-tier limits as of
  Aug 2026); Cloudflare Workers' free plan (100k requests/day) is not a
  practical limit here either. If either free tier is ever a concern, add
  billing alerts on the Google Cloud project tied to the API key.

  To add a fact: add an entry to data/resume_chunks.json, re-run step 2,
  commit+push both JSON files.

THE INTRO
  Particles assemble into drifting clusters, react to your cursor (move to
  orbit, click to pulse), then burst apart when you hit "Enter portfolio"
  (or auto-skip). Reduced-motion visitors skip straight to the page.

TWEAKS
  - Replace your photo: drop a new image in as assets/ajay.jpg
