PRAGMA defer_foreign_keys = ON;

CREATE TABLE users_new (
  id TEXT PRIMARY KEY,
  login TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO users_new (id, login, created_at)
SELECT id, login, created_at FROM users;

CREATE TABLE overlays_new (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users_new(id) ON DELETE CASCADE,
  link_token TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  channel TEXT NOT NULL DEFAULT '',
  link_generation INTEGER NOT NULL DEFAULT 1
);

INSERT INTO overlays_new (id, owner_id, link_token, name, created_at, channel, link_generation)
SELECT id, owner_id, link_token, name, created_at, channel, link_generation FROM overlays;

CREATE TABLE themes_new (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users_new(id) ON DELETE CASCADE,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  values_json TEXT NOT NULL,
  parent_theme_id TEXT REFERENCES themes_new(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

INSERT INTO themes_new (id, owner_id, slug, name, values_json, parent_theme_id, created_at)
SELECT id, owner_id, slug, name, values_json, parent_theme_id, created_at FROM themes;

DROP TABLE overlays;
DROP TABLE themes;
DROP TABLE users;

ALTER TABLE users_new RENAME TO users;
ALTER TABLE overlays_new RENAME TO overlays;
ALTER TABLE themes_new RENAME TO themes;

CREATE UNIQUE INDEX overlays_one_main_per_owner ON overlays(owner_id) WHERE name = 'Main';
