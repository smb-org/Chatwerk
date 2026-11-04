const LOCAL_ORIGINS = "http://localhost:* http://127.0.0.1:*";
const LOCAL_WSS_ORIGINS = "wss://localhost:* wss://127.0.0.1:*";
const LOCAL_SOCKET_ORIGINS = "ws://localhost:* ws://127.0.0.1:*";

export const publicOriginFor = (environment, publicOrigin) => {
  const isLocal = environment === undefined || environment === "" || environment === "local" || environment === "test";
  if (isLocal && (publicOrigin === undefined || publicOrigin === "")) {
    return { origin: LOCAL_ORIGINS, wssOrigin: LOCAL_WSS_ORIGINS, socketOrigin: LOCAL_SOCKET_ORIGINS };
  }
  if (typeof publicOrigin !== "string" || publicOrigin.trim() === "") {
    throw new Error(`PUBLIC_ORIGIN is required for ${environment ?? "this"} build; set a bare HTTPS origin.`);
  }

  let parsed;
  try {
    parsed = new URL(publicOrigin);
  } catch {
    throw new Error("PUBLIC_ORIGIN must be a bare HTTPS origin without credentials, path, query, or fragment.");
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" ||
    parsed.search || parsed.hash || parsed.origin !== publicOrigin.replace(/\/$/u, "")) {
    throw new Error("PUBLIC_ORIGIN must be a bare HTTPS origin without credentials, path, query, or fragment.");
  }
  return { origin: parsed.origin, wssOrigin: `wss://${parsed.host}`, socketOrigin: `wss://${parsed.host}` };
};

export const renderHeaders = (source, { origin, wssOrigin, socketOrigin }, hosts = { connectOrigins: [], imageHosts: [] }) => {
  const rendered = source
    .replaceAll("__PUBLIC_ORIGIN__", origin)
    .replaceAll("__PUBLIC_WSS__", wssOrigin)
    .replaceAll("__PUBLIC_SOCKET__", socketOrigin)
    .replaceAll("__OVERLAY_CONNECT_ORIGINS__", hosts.connectOrigins.join(" "))
    .replaceAll("__OVERLAY_IMAGE_ORIGINS__", hosts.imageHosts.map((host) => `https://${host}`).join(" "));
  if (rendered.includes("__")) {
    throw new Error("public/_headers contains an unknown build placeholder.");
  }
  return rendered;
};
