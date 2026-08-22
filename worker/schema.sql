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
