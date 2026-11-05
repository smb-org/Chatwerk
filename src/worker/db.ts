export interface OverlayRecord {
  id: string;
  owner_id: string;
  link_token: string;
  name: string;
  channel: string;
  link_generation: number;
}

export interface LookRecord {
  id: string;
  owner_id: string;
  slug: string;
  name: string;
  values_json: string;
  parent_theme_id: string | null;
  created_at: string;
  withdrawn_at: string | null;
  author_login: string;
  parent_name: string | null;
  parent_slug: string | null;
  parent_author: string | null;
  parent_withdrawn_at: string | null;
}

export async function getOwnedOverlay(db: D1Database, id: string, ownerId: string): Promise<OverlayRecord | null> {
  return db.prepare(
    "SELECT id, owner_id, link_token, name, channel, link_generation FROM overlays WHERE id = ? AND owner_id = ?",
  ).bind(id, ownerId).first<OverlayRecord>();
}

export async function getOverlayByToken(db: D1Database, token: string): Promise<OverlayRecord | null> {
  return db.prepare(
    "SELECT id, owner_id, link_token, name, channel, link_generation FROM overlays WHERE link_token = ?",
  ).bind(token).first<OverlayRecord>();
}

export async function getOverlayById(db: D1Database, id: string): Promise<OverlayRecord | null> {
  return db.prepare(
    "SELECT id, owner_id, link_token, name, channel, link_generation FROM overlays WHERE id = ?",
  ).bind(id).first<OverlayRecord>();
}

export async function listOwnedOverlays(db: D1Database, ownerId: string): Promise<OverlayRecord[]> {
  const result = await db.prepare(
    "SELECT id, owner_id, link_token, name, channel, link_generation FROM overlays WHERE owner_id = ? ORDER BY created_at, id",
  ).bind(ownerId).all<OverlayRecord>();
  return result.results;
}

export async function rotateOwnedOverlayLink(
  db: D1Database,
  id: string,
  ownerId: string,
  linkToken: string,
): Promise<OverlayRecord | null> {
  return db.prepare(`
    UPDATE overlays
    SET link_token = ?, link_generation = link_generation + 1
    WHERE id = ? AND owner_id = ?
    RETURNING id, owner_id, link_token, name, channel, link_generation
  `).bind(linkToken, id, ownerId).first<OverlayRecord>();
}

export async function listActiveLooks(db: D1Database): Promise<LookRecord[]> {
  const result = await db.prepare(`${LOOK_SELECT}
    WHERE look.withdrawn_at IS NULL
    ORDER BY look.created_at DESC, look.slug ASC`)
    .all<LookRecord>();
  return result.results;
}

export async function listOwnedLooks(db: D1Database, ownerId: string): Promise<LookRecord[]> {
  const result = await db.prepare(`${LOOK_SELECT}
    WHERE look.owner_id = ?
    ORDER BY look.created_at DESC, look.slug ASC`)
    .bind(ownerId).all<LookRecord>();
  return result.results;
}

export async function getLookBySlug(db: D1Database, slug: string, includeWithdrawn = false): Promise<LookRecord | null> {
  return db.prepare(`${LOOK_SELECT}
    WHERE look.slug = ?${includeWithdrawn ? "" : " AND look.withdrawn_at IS NULL"}`)
    .bind(slug).first<LookRecord>();
}

export async function getOwnedLookById(db: D1Database, id: string, ownerId: string): Promise<LookRecord | null> {
  return db.prepare(`${LOOK_SELECT}
    WHERE look.id = ? AND look.owner_id = ?`)
    .bind(id, ownerId).first<LookRecord>();
}

export async function getLookByName(db: D1Database, ownerId: string, nameKey: string): Promise<LookRecord | null> {
  return db.prepare(`${LOOK_SELECT}
    WHERE look.owner_id = ? AND look.name_key = ? AND look.withdrawn_at IS NULL`)
    .bind(ownerId, nameKey).first<LookRecord>();
}

export async function countActiveLooks(db: D1Database, ownerId: string): Promise<number> {
  const result = await db.prepare("SELECT COUNT(*) AS count FROM themes WHERE owner_id = ? AND withdrawn_at IS NULL")
    .bind(ownerId).first<{ count: number }>();
  return result?.count ?? 0;
}

const LOOK_SELECT = `SELECT
  look.id,
  look.owner_id,
  look.slug,
  look.name,
  look.values_json,
  look.parent_theme_id,
  look.created_at,
  look.withdrawn_at,
  author.login AS author_login,
  parent.name AS parent_name,
  parent.slug AS parent_slug,
  parent_author.login AS parent_author,
  parent.withdrawn_at AS parent_withdrawn_at
FROM themes AS look
JOIN users AS author ON author.id = look.owner_id
LEFT JOIN themes AS parent ON parent.id = look.parent_theme_id
LEFT JOIN users AS parent_author ON parent_author.id = parent.owner_id`;
