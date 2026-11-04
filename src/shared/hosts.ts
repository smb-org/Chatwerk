export const ALLOWED_IMAGE_HOSTS = [
  "static-cdn.jtvnw.net",
  "cdn.7tv.app",
  "cdn.betterttv.net",
  "cdn.frankerfacez.com",
] as const;

export function isAllowedImageUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.username === "" && url.password === "" &&
      (url.port === "" || url.port === "443") &&
      ALLOWED_IMAGE_HOSTS.includes(url.hostname.toLowerCase() as (typeof ALLOWED_IMAGE_HOSTS)[number]);
  } catch {
    return false;
  }
}
