import { expect, test } from "@playwright/test";

const uraniumPaint = {
  id: "01G9DJJ40G00044BJY7M3198HC",
  name: "Uranium",
  color: null,
  kind: "PAINT",
  function: "RADIAL_GRADIENT",
  repeat: false,
  angle: 0,
  shape: "circle",
  image_url: "",
  stops: [
    { at: 0, color: -285277953 },
    { at: 0.5, color: -1493237505 },
    { at: 1, color: 1573063167 },
  ],
  shadows: [
    { x_offset: 0, y_offset: 0, radius: 0.5, color: 624034303 },
    { x_offset: 0, y_offset: 0, radius: 4, color: -1109325313 },
  ],
  gradients: [],
};

test("paints an existing chat name after the mocked initial 7TV lookup resolves", async ({ page }) => {
  let capturedPaintQuery = "";
  let onPaintQuery!: () => void;
  const paintQuerySeen = new Promise<void>((resolve) => { onPaintQuery = resolve; });
  let releasePaintResponse!: () => void;
  const paintResponseGate = new Promise<void>((resolve) => { releasePaintResponse = resolve; });

  await page.route("https://7tv.io/v3/gql", async (route) => {
    const request = route.request().postDataJSON() as { query: string };
    if (request.query.includes("userByConnection")) {
      await route.fulfill({ json: { data: { u0: { id: "7tv-user", style: { paint_id: uraniumPaint.id } } } } });
      return;
    }

    capturedPaintQuery = request.query;
    onPaintQuery();
    await paintResponseGate;
    const hasTopLevelPaintFields = request.query.includes(
      "paints { id name color kind function repeat angle shape image_url stops { at color } gradients",
    );
    const { id, name, color, kind, shadows, gradients } = uraniumPaint;
    const paint = {
      id, name, color, kind, shadows, gradients,
      ...(hasTopLevelPaintFields ? {
        function: uraniumPaint.function,
        repeat: uraniumPaint.repeat,
        angle: uraniumPaint.angle,
        shape: uraniumPaint.shape,
        image_url: uraniumPaint.image_url,
        stops: uraniumPaint.stops,
      } : {}),
    };
    await route.fulfill({ json: { data: { cosmetics: { paints: [paint] } } } });
  });
  await page.routeWebSocket("wss://irc-ws.chat.twitch.tv/**", (socket) => {
    socket.onMessage((message) => {
      if (String(message).startsWith("JOIN #paintlookup")) {
        socket.send("@id=paint-row;user-id=42;display-name=UraniumViewer;color=#123456 :viewer!viewer@host PRIVMSG #paintlookup :hello");
      }
    });
  });

  try {
    await page.goto("/overlay#channel=paintlookup&client=browser");
    await page.addStyleTag({ content: "#chat * { animation: none !important; transition: none !important; }" });
    const row = page.locator(".chat-line");
    const name = row.locator(".chat-name");
    await expect(name).toHaveCount(1);
    await paintQuerySeen;
    await expect(name).not.toHaveClass(/chat-name-painted/u);
    const before = await name.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    });

    expect(capturedPaintQuery).toContain(
      "paints { id name color kind function repeat angle shape image_url stops { at color } gradients",
    );
    releasePaintResponse();

    await expect(name).toHaveClass(/chat-name-painted/u);
    const rendered = await name.evaluate((element) => {
      const rect = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return {
        text: element.textContent,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
        backgroundImage: style.backgroundImage,
        backgroundClip: style.backgroundClip,
        filter: style.filter,
        visibility: style.visibility,
      };
    });
    expect(rendered.backgroundImage).toContain("radial-gradient");
    expect(rendered.backgroundClip).toBe("text");
    expect(rendered.filter).toContain("drop-shadow(");
    expect(rendered.visibility).toBe("visible");
    expect(rendered.text).toContain("UraniumViewer");
    expect({ x: rendered.x, y: rendered.y, width: rendered.width, height: rendered.height }).toEqual(before);
  } finally {
    releasePaintResponse();
  }
});
