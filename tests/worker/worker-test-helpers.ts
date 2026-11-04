const encoder = new TextEncoder();

const base64Url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");

export async function mintSessionCookie(
  sessionKey: string,
  userId: string,
  expiresAt = Math.floor(Date.now() / 1000) + 3600,
): Promise<string> {
  const payload = `${userId}.${expiresAt}`;
  const key = await crypto.subtle.importKey("raw", encoder.encode(sessionKey), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payload));
  return `session=${payload}.${base64Url(new Uint8Array(signature))}`;
}

export function cookieValue(response: Response, name: string): string | undefined {
  const setCookie = response.headers.get("set-cookie");
  return setCookie?.split(";")[0]?.startsWith(`${name}=`)
    ? setCookie.split(";")[0]?.slice(name.length + 1)
    : undefined;
}

export async function seedOverlay(
  db: D1Database,
  input: { ownerId?: string; overlayId?: string; token?: string; name?: string; channel?: string; generation?: number } = {},
): Promise<{ ownerId: string; overlayId: string; token: string }> {
  const ownerId = input.ownerId ?? `owner-${crypto.randomUUID()}`;
  const overlayId = input.overlayId ?? crypto.randomUUID();
  const token = input.token ?? base64Url(crypto.getRandomValues(new Uint8Array(32)));
  const login = `user_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
  await db.prepare("INSERT INTO users (id, login) VALUES (?, ?) ON CONFLICT(id) DO NOTHING")
    .bind(ownerId, login).run();
  await db.prepare(
    "INSERT INTO overlays (id, owner_id, link_token, name, channel, link_generation) VALUES (?, ?, ?, ?, ?, ?)",
  ).bind(overlayId, ownerId, token, input.name ?? "Main", input.channel ?? login, input.generation ?? 1).run();
  return { ownerId, overlayId, token };
}
