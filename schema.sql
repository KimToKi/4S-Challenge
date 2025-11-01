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

CREATE TABLE IF NOT EXISTS score_rules (
  command TEXT NOT NULL,
  subtype TEXT NOT NULL DEFAULT '',
  points INTEGER NOT NULL,
  PRIMARY KEY (command, subtype)
);

-- กติกาคะแนนคงที่
INSERT INTO score_rules VALUES('/bm_product','',1) ON CONFLICT DO NOTHING;
INSERT INTO score_rules VALUES('/pack3','',4) ON CONFLICT DO NOTHING;
INSERT INTO score_rules VALUES('/old_member','',1) ON CONFLICT DO NOTHING;
INSERT INTO score_rules VALUES('/sop','',2) ON CONFLICT DO NOTHING;
INSERT INTO score_rules VALUES('/plan_update','success',4) ON CONFLICT DO NOTHING;
INSERT INTO score_rules VALUES('/plan_update','fail',-10) ON CONFLICT DO NOTHING;
INSERT INTO score_rules VALUES('/use_product','',1) ON CONFLICT DO NOTHING;
INSERT INTO score_rules VALUES('/link_30d','success',4) ON CONFLICT DO NOTHING;
INSERT INTO score_rules VALUES('/link_30d','fail',-1) ON CONFLICT DO NOTHING;
INSERT INTO score_rules VALUES('/link_30d','none',0) ON CONFLICT DO NOTHING;
