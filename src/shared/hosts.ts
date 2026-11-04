import hostConfig from "./hosts.json";

export const ALLOWED_CONNECT_ORIGINS = hostConfig.connectOrigins;
export const ALLOWED_IMAGE_HOSTS = hostConfig.imageHosts;

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
