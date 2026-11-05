ALTER TABLE themes ADD COLUMN withdrawn_at TEXT;
ALTER TABLE themes ADD COLUMN name_key TEXT NOT NULL DEFAULT '';

UPDATE themes SET name_key = lower(name);

WITH RECURSIVE ranked_active_names AS (
  SELECT
    id,
    owner_id,
    name,
    name_key,
    row_number() OVER (
      PARTITION BY owner_id, name_key
      ORDER BY created_at ASC, id ASC
    ) AS duplicate_number
  FROM themes
  WHERE withdrawn_at IS NULL
), duplicate_active_names AS (
  SELECT id, owner_id, name, name_key
  FROM ranked_active_names
  WHERE duplicate_number > 1
), suffix_candidates(id, owner_id, name, name_key) AS (
  SELECT
    id,
    owner_id,
    name || ' [' || id || ']',
    name_key || ' [' || id || ']'
  FROM duplicate_active_names
  UNION ALL
  SELECT
    candidate.id,
    candidate.owner_id,
    candidate.name || '!',
    candidate.name_key || '!'
  FROM suffix_candidates AS candidate
  WHERE EXISTS (
    SELECT 1
    FROM themes AS existing
    WHERE existing.owner_id = candidate.owner_id
      AND existing.withdrawn_at IS NULL
      AND existing.id <> candidate.id
      AND existing.name_key = candidate.name_key
  )
), free_suffix_candidates AS (
  SELECT candidate.id, candidate.name, candidate.name_key
  FROM suffix_candidates AS candidate
  WHERE NOT EXISTS (
    SELECT 1
    FROM themes AS existing
    WHERE existing.owner_id = candidate.owner_id
      AND existing.withdrawn_at IS NULL
      AND existing.id <> candidate.id
      AND existing.name_key = candidate.name_key
  )
)
UPDATE themes
SET
  name = (SELECT candidate.name FROM free_suffix_candidates AS candidate WHERE candidate.id = themes.id),
  name_key = (SELECT candidate.name_key FROM free_suffix_candidates AS candidate WHERE candidate.id = themes.id)
WHERE id IN (SELECT id FROM free_suffix_candidates);

CREATE UNIQUE INDEX themes_active_owner_name
  ON themes(owner_id, name_key)
  WHERE withdrawn_at IS NULL;

CREATE INDEX themes_active_created
  ON themes(withdrawn_at, created_at DESC);
