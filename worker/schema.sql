-- Conversation log for the "Ask about my work" widget.
--
-- Apply once (and after any change):
--   npx wrangler d1 execute portfolio-chat-logs --remote --file=schema.sql
--
-- Deliberately NOT stored: IP address, user agent, or anything else that
-- identifies a specific visitor. `session` is a random id the browser makes up
-- per panel-open so a back-and-forth reads as one conversation; it is not tied
-- to a person and does not survive a refresh. Country comes from Cloudflare and
-- is coarse. If a visitor types their own name or email into the chat that does
-- get stored, which is why the widget says out loud that chats are saved.
CREATE TABLE IF NOT EXISTS turns (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  session     TEXT    NOT NULL,          -- random per-conversation id from the browser
  turn        INTEGER NOT NULL,          -- 1-based position within the session
  asked_at    TEXT    NOT NULL,          -- ISO 8601 UTC
  question    TEXT    NOT NULL,
  answer      TEXT,                      -- NULL if generation failed
  refused     INTEGER NOT NULL DEFAULT 0,-- 1 = stopped at the similarity gate
  best_score  REAL,                      -- top cosine similarity for this question
  retrieved   TEXT,                      -- comma-separated chunk ids sent as context
  country     TEXT,                      -- Cloudflare cf.country, coarse
  ms          INTEGER                    -- wall time to finish the answer
);

CREATE INDEX IF NOT EXISTS turns_session_idx ON turns (session, turn);
CREATE INDEX IF NOT EXISTS turns_asked_at_idx ON turns (asked_at DESC);

-- One row per conversation, so counting visitors doesn't mean COUNT(DISTINCT
-- session) over the turn log, and so there's somewhere to hang per-visitor
-- facts: where they came from, how long they stayed, whether we've pinged
-- Slack about them yet.
--
-- `network` is Cloudflare's asOrganization. On a home connection it's an ISP
-- ("Charter Communications Inc"); on a corporate network it's often the
-- employer's own name, which is the single most interesting field here.
CREATE TABLE IF NOT EXISTS sessions (
  session        TEXT PRIMARY KEY,          -- matches turns.session
  started_at     TEXT NOT NULL,             -- ISO 8601 UTC, first message
  last_at        TEXT NOT NULL,             -- ISO 8601 UTC, most recent message
  turn_count     INTEGER NOT NULL DEFAULT 0,
  country        TEXT,
  city           TEXT,
  region         TEXT,
  timezone       TEXT,                      -- IANA, renders the visitor's local time
  network        TEXT,                      -- cf.asOrganization
  first_question TEXT,
  notified_start INTEGER NOT NULL DEFAULT 0,-- 1 = "new chat" posted to Slack
  notified_end   INTEGER NOT NULL DEFAULT 0 -- 1 = transcript posted to Slack
);

CREATE INDEX IF NOT EXISTS sessions_started_idx ON sessions (started_at DESC);
-- Drives the cron sweep that looks for conversations that have gone quiet.
CREATE INDEX IF NOT EXISTS sessions_pending_idx ON sessions (notified_end, last_at);
