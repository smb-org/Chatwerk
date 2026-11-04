export interface OverlayRecord {
  id: string;
  owner_id: string;
  link_token: string;
  name: string;
  channel: string;
  link_generation: number;
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
