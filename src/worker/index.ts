import { handleApiRequest } from "./api";
import { handleAuthRequest } from "./auth";
import { handleBadgeRequest, type BadgeEnvironment } from "./badges";
import { handlePageRequest } from "./pages";
import { handleHypeTrainRequest, type HypeTrainEnvironment } from "./hype-train";

export { OverlayObject } from "./overlay-object";

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const authResponse = await handleAuthRequest(request, env);
    if (authResponse) return authResponse;
    const hypeTrainResponse = await handleHypeTrainRequest(request, env as HypeTrainEnvironment, ctx);
    if (hypeTrainResponse) return hypeTrainResponse;
    const badgeResponse = await handleBadgeRequest(request, env as BadgeEnvironment, fetch, (promise) => ctx.waitUntil(promise));
    if (badgeResponse) return badgeResponse;
    const apiResponse = await handleApiRequest(request, env);
    if (apiResponse) return apiResponse;
    const pageResponse = await handlePageRequest(request, env);
    if (pageResponse) return pageResponse;

    const url = new URL(request.url);
    switch (`${request.method} ${url.pathname}`) {
      case "GET /health":
        return Response.json({ ok: true });
      default:
        if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
          return Response.json({ error: "Not found" }, { status: 404 });
        }
        return env.ASSETS.fetch(request);
    }
  },
} satisfies ExportedHandler<Env>;

export default worker;
