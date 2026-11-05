import { expect, test } from "@playwright/test";
import { seedStudioSession } from "./studio-session";

test("restores the same OBS count after the Studio socket reconnects", async ({ page }) => {
  await seedStudioSession(page);
  let connections = 0;
  await page.routeWebSocket(/\/api\/overlay\/live$/u, (socket) => {
    connections += 1;
    socket.onMessage((rawMessage) => {
      const message = JSON.parse(String(rawMessage)) as { type?: string; client?: string };
      if (message.type !== "hello" || message.client !== "studio") return;
      socket.send(JSON.stringify({
        type: "clients",
        counts: { obs: 1, browser: 0, widget: 0, studio: 1 },
      }));
      if (connections === 1) {
        setTimeout(() => { void socket.close({ code: 4000, reason: "reconnect regression test" }); }, 25);
      }
    });
  });

  await page.goto("/studio");
  const chip = page.locator("#connection-chip");
  await expect(chip).toHaveText("OBS: 1 connected");
  await expect(chip).toHaveText("OBS: unknown");
  await expect.poll(() => connections).toBe(2);
  await expect(chip).toHaveText("OBS: 1 connected", { timeout: 5_000 });
});
