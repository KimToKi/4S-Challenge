PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  timestamp TEXT DEFAULT CURRENT_TIMESTAMP,
  user_id TEXT,
  display_name TEXT,
  command TEXT,
  detail TEXT,
  points INTEGER DEFAULT 0,
  month_key TEXT
);

CREATE TABLE IF NOT EXISTS score_rules (
  command TEXT NOT NULL,
  subtype TEXT NOT NULL DEFAULT '',
  points INTEGER NOT NULL,
  PRIMARY KEY (command, subtype)
);

-- กติกาคะแนนคงที่
INSERT OR IGNORE INTO score_rules VALUES('/bm_product','',1);
INSERT OR IGNORE INTO score_rules VALUES('/pack3','',4);
INSERT OR IGNORE INTO score_rules VALUES('/old_member','',1);
INSERT OR IGNORE INTO score_rules VALUES('/SOP','',2);
INSERT OR IGNORE INTO score_rules VALUES('/plan_update','success',4);
INSERT OR IGNORE INTO score_rules VALUES('/plan_update','fail',-10);
INSERT OR IGNORE INTO score_rules VALUES('/use_product','',1);
INSERT OR IGNORE INTO score_rules VALUES('/link_30d','success',4);
INSERT OR IGNORE INTO score_rules VALUES('/link_30d','fail',-1);
INSERT OR IGNORE INTO score_rules VALUES('/link_30d','none',0);
INSERT OR IGNORE INTO score_rules VALUES('/book','success',4);
INSERT OR IGNORE INTO score_rules VALUES('/book','fail',-4);