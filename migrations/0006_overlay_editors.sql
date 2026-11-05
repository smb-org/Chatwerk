CREATE TABLE overlay_editors (
  overlay_id TEXT NOT NULL REFERENCES overlays(id) ON DELETE CASCADE,
  user_id    TEXT NOT NULL REFERENCES users(id)    ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (overlay_id, user_id)
);
CREATE INDEX overlay_editors_user ON overlay_editors(user_id);
CREATE TABLE overlay_invites (
  overlay_id TEXT PRIMARY KEY REFERENCES overlays(id) ON DELETE CASCADE,
  token      TEXT NOT NULL UNIQUE,
  expires_at INTEGER NOT NULL
);
