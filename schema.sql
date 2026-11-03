CREATE TABLE IF NOT EXISTS events (
  id BIGSERIAL PRIMARY KEY,
  timestamp TIMESTAMPTZ DEFAULT NOW(),
  user_id TEXT,
  display_name TEXT,
  command TEXT,
  detail TEXT,
  points NUMERIC(10,2) DEFAULT 0,
  month_key TEXT
);

CREATE TABLE IF NOT EXISTS pending (
  user_id TEXT NOT NULL,
  command TEXT NOT NULL,
  date_key DATE NOT NULL,
  month_key TEXT NOT NULL,
  metadata TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (user_id, command, date_key)
);

CREATE TABLE IF NOT EXISTS daily_announcements (
  chat_id TEXT NOT NULL,
  date_key DATE NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (chat_id, date_key)
);
