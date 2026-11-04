const LOCAL_ORIGINS = "http://localhost:* http://127.0.0.1:*";
const LOCAL_WSS_ORIGINS = "wss://localhost:* wss://127.0.0.1:*";

export const publicOriginFor = (environment, publicOrigin) => {
  const isLocal = environment === undefined || environment === "" || environment === "local" || environment === "test";
  if (isLocal && (publicOrigin === undefined || publicOrigin === "")) {
    return { origin: LOCAL_ORIGINS, wssOrigin: LOCAL_WSS_ORIGINS };
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
  return { origin: parsed.origin, wssOrigin: `wss://${parsed.host}` };
};

export const renderHeaders = (source, { origin, wssOrigin }) => {
  const rendered = source
    .replaceAll("__PUBLIC_ORIGIN__", origin)
    .replaceAll("__PUBLIC_WSS__", wssOrigin);
  if (rendered.includes("__PUBLIC_")) {
    throw new Error("public/_headers contains an unknown __PUBLIC_* placeholder.");
  }
  return rendered;
};
