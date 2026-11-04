export { OverlayObject } from "./overlay-object";

const worker = {
  async fetch(request: Request, env: Env): Promise<Response> {
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
