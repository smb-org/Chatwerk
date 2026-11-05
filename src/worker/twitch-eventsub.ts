export const HYPE_TRAIN_TYPES = [
  "channel.hype_train.begin",
  "channel.hype_train.progress",
  "channel.hype_train.end",
] as const;

export type HypeTrainSubscriptionType = (typeof HYPE_TRAIN_TYPES)[number];

export interface TwitchEventSubEnvironment {
  TWITCH_CLIENT_ID?: string;
  TWITCH_CLIENT_SECRET?: string;
}

export interface EventSubSubscription {
  id: string;
  type: string;
  condition: { broadcaster_user_id?: string };
}

const TOKEN_URL = "https://id.twitch.tv/oauth2/token";
const SUBSCRIPTIONS_URL = "https://api.twitch.tv/helix/eventsub/subscriptions";

export async function getAppAccessToken(
  env: TwitchEventSubEnvironment,
  fetcher: typeof fetch = fetch,
): Promise<string> {
  if (!env.TWITCH_CLIENT_ID || !env.TWITCH_CLIENT_SECRET) throw new Error("Twitch app credentials unavailable");
  const response = await fetcher(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: env.TWITCH_CLIENT_ID,
      client_secret: env.TWITCH_CLIENT_SECRET,
      grant_type: "client_credentials",
    }),
  });
  if (!response.ok) throw new Error("Twitch app token request failed");
  const payload = await response.json() as { access_token?: unknown };
  if (typeof payload.access_token !== "string" || payload.access_token.length === 0) {
    throw new Error("Twitch app token response was invalid");
  }
  return payload.access_token;
}

export async function createHypeTrainSubscriptions(
  options: {
    env: TwitchEventSubEnvironment;
    fetcher?: typeof fetch;
    appToken: string;
    broadcasterUserId: string;
    callback: string;
    secret: string;
  },
): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const createdIds: string[] = [];
  try {
    for (const type of HYPE_TRAIN_TYPES) {
      const response = await fetcher(SUBSCRIPTIONS_URL, {
        method: "POST",
        headers: apiHeaders(options.env.TWITCH_CLIENT_ID, options.appToken),
        body: JSON.stringify({
          type,
          version: "2",
          condition: { broadcaster_user_id: options.broadcasterUserId },
          transport: { method: "webhook", callback: options.callback, secret: options.secret },
        }),
      });
      if (response.status === 409) continue;
      if (!response.ok) throw new Error("Twitch subscription request failed");
      const payload = await response.json() as { data?: unknown };
      const subscription = Array.isArray(payload.data) ? payload.data[0] as { id?: unknown } | undefined : undefined;
      if (typeof subscription?.id !== "string" || subscription.id.length === 0) {
        throw new Error("Twitch subscription response was invalid");
      }
      createdIds.push(subscription.id);
    }
  } catch (error) {
    await Promise.all(createdIds.map((id) => deleteSubscriptionById({
      env: options.env,
      fetcher,
      appToken: options.appToken,
      id,
    }).catch(() => undefined)));
    throw error;
  }
}

export async function listUserSubscriptions(options: {
  env: TwitchEventSubEnvironment;
  fetcher?: typeof fetch;
  appToken: string;
  userId: string;
}): Promise<EventSubSubscription[]> {
  const fetcher = options.fetcher ?? fetch;
  const subscriptions: EventSubSubscription[] = [];
  let cursor: string | undefined;
  do {
    const url = new URL(SUBSCRIPTIONS_URL);
    url.searchParams.set("user_id", options.userId);
    url.searchParams.set("first", "100");
    if (cursor) url.searchParams.set("after", cursor);
    const response = await fetcher(url, {
      headers: apiHeaders(options.env.TWITCH_CLIENT_ID, options.appToken),
    });
    if (!response.ok) throw new Error("Twitch subscription list request failed");
    const payload = await response.json() as {
      data?: unknown;
      pagination?: { cursor?: unknown };
    };
    if (!Array.isArray(payload.data)) throw new Error("Twitch subscription list response was invalid");
    for (const item of payload.data) {
      if (!isSubscription(item)) throw new Error("Twitch subscription list response was invalid");
      subscriptions.push(item);
    }
    cursor = typeof payload.pagination?.cursor === "string" && payload.pagination.cursor.length > 0
      ? payload.pagination.cursor
      : undefined;
  } while (cursor);
  return subscriptions;
}

export async function deleteSubscriptionById(options: {
  env: TwitchEventSubEnvironment;
  fetcher?: typeof fetch;
  appToken: string;
  id: string;
}): Promise<void> {
  const url = new URL(SUBSCRIPTIONS_URL);
  url.searchParams.set("id", options.id);
  const response = await (options.fetcher ?? fetch)(url, {
    method: "DELETE",
    headers: apiHeaders(options.env.TWITCH_CLIENT_ID, options.appToken),
  });
  if (!response.ok && response.status !== 404) throw new Error("Twitch subscription delete failed");
}

export async function deleteHypeTrainSubscriptionsForUser(options: {
  env: TwitchEventSubEnvironment;
  fetcher?: typeof fetch;
  appToken?: string;
  userId: string;
}): Promise<void> {
  const fetcher = options.fetcher ?? fetch;
  const appToken = options.appToken ?? await getAppAccessToken(options.env, fetcher);
  const subscriptions = await listUserSubscriptions({ ...options, fetcher, appToken });
  const targets = subscriptions.filter((subscription) =>
    HYPE_TRAIN_TYPES.includes(subscription.type as HypeTrainSubscriptionType));
  await Promise.all(targets.map((subscription) => deleteSubscriptionById({
    env: options.env,
    fetcher,
    appToken,
    id: subscription.id,
  })));
}

export async function deriveEventSubSecret(sessionKey: string): Promise<string> {
  const label = new TextEncoder().encode("eventsub-webhook-v1");
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(sessionKey), {
    name: "HMAC",
    hash: "SHA-256",
  }, false, ["sign"]);
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", key, label));
  return Array.from(signature, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function apiHeaders(clientId: string | undefined, appToken: string): HeadersInit {
  if (!clientId) throw new Error("Twitch client id unavailable");
  return { Authorization: `Bearer ${appToken}`, "Client-Id": clientId, "Content-Type": "application/json" };
}

function isSubscription(value: unknown): value is EventSubSubscription {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const condition = record.condition;
  return typeof record.id === "string" && typeof record.type === "string" &&
    typeof condition === "object" && condition !== null && !Array.isArray(condition) &&
    (typeof (condition as Record<string, unknown>).broadcaster_user_id === "string" ||
      (condition as Record<string, unknown>).broadcaster_user_id === undefined);
}
