import { sessionForRequest } from "./auth";

export interface PageEnvironment {
  ASSETS: Fetcher;
  SESSION_KEY?: string;
}

export async function handlePageRequest(request: Request, env: PageEnvironment): Promise<Response | null> {
  if (request.method !== "GET") return null;
  const url = new URL(request.url);

  if (url.pathname === "/") {
    const destination = await sessionForRequest(request, env.SESSION_KEY) ? "/studio" : "/login";
    return redirect(url.origin, destination);
  }

  if (url.pathname === "/overlay" || url.pathname === "/overlay/" || url.pathname === "/overlay.html") {
    return asset(request, env, "/overlay.html");
  }

  if (url.pathname === "/login" || url.pathname === "/login/" || url.pathname === "/login.html") {
    return asset(request, env, "/login.html");
  }

  if (url.pathname === "/theme.html") return asset(request, env, "/theme.html");
  if (/^\/t\/[a-z0-9-]{1,100}$/u.test(url.pathname)) return asset(request, env, "/theme.html");
  if (url.pathname.startsWith("/t/")) return Response.json({ error: "Not found" }, { status: 404 });

  const galleryPage = ["/themes", "/themes/", "/themes.html", "/gallery.html"].includes(url.pathname);
  if (galleryPage) {
    const session = await sessionForRequest(request, env.SESSION_KEY);
    if (!session) {
      const login = new URL("/login", url.origin);
      login.searchParams.set("next", "/themes");
      return new Response(null, { status: 302, headers: { Location: login.toString(), "Cache-Control": "no-store" } });
    }
    return asset(request, env, "/gallery.html");
  }

  const exportPage = url.pathname === "/export.html" || url.pathname === "/studio/export" ||
    url.pathname === "/studio/export.html";

  if (url.pathname === "/studio" || url.pathname === "/studio/" || url.pathname === "/studio.html" || exportPage) {
    const session = await sessionForRequest(request, env.SESSION_KEY);
    if (!session) {
      const studioPath = url.pathname === "/studio/" || url.pathname === "/studio.html" ? "/studio" : url.pathname;
      const destination = exportPage ? "/studio/export" : `${studioPath}${url.search}`;
      const login = new URL("/login", url.origin);
      login.searchParams.set("next", destination);
      return new Response(null, { status: 302, headers: { Location: login.toString(), "Cache-Control": "no-store" } });
    }
    const assetPath = exportPage ? "/export.html" : "/studio.html";
    return asset(request, env, assetPath);
  }

  if (url.pathname.startsWith("/studio/")) {
    const session = await sessionForRequest(request, env.SESSION_KEY);
    if (!session) {
      const login = new URL("/login", url.origin);
      login.searchParams.set("next", "/studio");
      return new Response(null, { status: 302, headers: { Location: login.toString(), "Cache-Control": "no-store" } });
    }
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  return null;
}

function asset(request: Request, env: PageEnvironment, pathname: string): Promise<Response> {
  const url = new URL(request.url);
  return env.ASSETS.fetch(new Request(new URL(pathname, url.origin), request));
}

function redirect(origin: string, pathname: string): Response {
  return new Response(null, { status: 302, headers: { Location: new URL(pathname, origin).toString(), "Cache-Control": "no-store" } });
}
